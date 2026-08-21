import { describe, expect, it } from 'vitest';
import { LiveSessions, type InputEvent } from './live-session.js';

const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const frame = (data = 'AAA') => ({ data, width: 800, height: 600 });
const click = (x: number): InputEvent => ({
  kind: 'mouse',
  type: 'mousePressed',
  x,
  y: 10,
  button: 'left',
  clickCount: 1,
});

describe('frames going out', () => {
  it('hands over the newest frame at once when the reader has not seen it', async () => {
    const live = new LiveSessions();
    live.putFrame(AGENT, frame('first'));
    const got = await live.waitForFrame(AGENT, 0, 50);
    expect(got?.data).toBe('first');
  });

  it('numbers frames so a reader can ask only for newer ones', async () => {
    const live = new LiveSessions();
    live.putFrame(AGENT, frame('one'));
    live.putFrame(AGENT, frame('two'));
    const got = await live.waitForFrame(AGENT, 1, 50);
    expect(got).toMatchObject({ data: 'two', seq: 2 });
  });

  it('holds the request open until the page repaints', async () => {
    // The point of the whole arrangement: a website that has caught up waits
    // for the next repaint rather than asking four times a second.
    const live = new LiveSessions();
    live.putFrame(AGENT, frame('seen'));

    const pending = live.waitForFrame(AGENT, 1, 1000);
    let settled = false;
    void pending.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    live.putFrame(AGENT, frame('fresh'));
    expect((await pending)?.data).toBe('fresh');
  });

  it('gives up rather than hanging forever when nothing repaints', async () => {
    // A finished page emits no frames at all, so this is the normal ending.
    const live = new LiveSessions();
    expect(await live.waitForFrame(AGENT, 0, 20)).toBeNull();
  });

  it('keeps one conversation’s screen out of another', async () => {
    const live = new LiveSessions();
    live.putFrame(AGENT, frame('mine'));
    expect(await live.waitForFrame(OTHER, 0, 20)).toBeNull();
  });
});

describe('input coming back', () => {
  it('delivers straight to a waiting machine without queueing', async () => {
    const live = new LiveSessions();
    const pending = live.waitForInput(AGENT, 1000);
    live.pushInput(AGENT, [click(5)]);
    expect(await pending).toEqual([click(5)]);
  });

  it('holds what happened while nobody was asking', async () => {
    // The app is mid-frame-upload when the student clicks; the click must not
    // be dropped just because no request was open at that instant.
    const live = new LiveSessions();
    live.pushInput(AGENT, [click(1)]);
    live.pushInput(AGENT, [click(2)]);
    expect(await live.waitForInput(AGENT, 20)).toEqual([click(1), click(2)]);
  });

  it('hands each event over exactly once', async () => {
    const live = new LiveSessions();
    live.pushInput(AGENT, [click(1)]);
    expect(await live.waitForInput(AGENT, 20)).toHaveLength(1);
    expect(await live.waitForInput(AGENT, 20)).toEqual([]);
  });

  it('does not grow without limit when nothing is collecting', async () => {
    const live = new LiveSessions();
    for (let i = 0; i < 200; i++) live.pushInput(AGENT, [click(i)]);
    const drained = await live.waitForInput(AGENT, 20);
    expect(drained.length).toBeLessThanOrEqual(64);
    // The most recent survive: a stale click is worth less than a fresh one.
    expect(drained.at(-1)).toEqual(click(199));
  });

  it('keeps one conversation’s clicks out of another', async () => {
    const live = new LiveSessions();
    live.pushInput(AGENT, [click(1)]);
    expect(await live.waitForInput(OTHER, 20)).toEqual([]);
  });
});

describe('ending a session', () => {
  it('releases a reader instead of leaving it hanging', async () => {
    const live = new LiveSessions();
    live.putFrame(AGENT, frame('x'));
    const pending = live.waitForFrame(AGENT, 1, 1000);
    live.end(AGENT);
    expect(await pending).toBeNull();
  });

  it('forgets the last screenful', async () => {
    const live = new LiveSessions();
    live.putFrame(AGENT, frame('private'));
    live.end(AGENT);
    expect(live.size).toBe(0);
    expect(await live.waitForFrame(AGENT, 0, 20)).toBeNull();
  });
});

describe('sweeping idle sessions', () => {
  it('drops a channel nothing has touched, so a shut laptop leaves nothing', () => {
    let now = 1_000_000;
    const live = new LiveSessions(() => now);
    live.putFrame(AGENT, frame('last thing on screen'));
    expect(live.size).toBe(1);

    now += 3 * 60 * 1000;
    live.sweep();
    expect(live.size).toBe(0);
  });

  it('leaves a channel that is still being written to', () => {
    let now = 1_000_000;
    const live = new LiveSessions(() => now);
    live.putFrame(AGENT, frame('a'));
    now += 3 * 60 * 1000;
    live.putFrame(AGENT, frame('b'));
    live.sweep();
    expect(live.size).toBe(1);
  });
});
