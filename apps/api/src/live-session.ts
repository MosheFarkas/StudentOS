/**
 * The live view of a browser the agent is driving, and the clicks going back.
 *
 * The desktop app owns a real Chromium view; a browser tab cannot hold one and
 * is not allowed to embed the sites involved -- every portal worth showing
 * sends X-Frame-Options. So the pixels are carried instead: the app screencasts
 * frames here, the website reads them, and input taken on the website is
 * carried the other way and replayed into the real page.
 *
 * Memory only, deliberately. These are frames of a student's school portal --
 * their timetable, their marks, whatever was on screen. Writing them to the
 * database would turn a thing that exists for a few seconds into a record with
 * a retention policy, and there is no reason to keep them once they have been
 * looked at. A restart drops them; the next frame rebuilds the view.
 *
 * Keyed by agent, because that is what decides where a browser may be shown --
 * the same rule the panel already follows. Work with no conversation behind it
 * is shown nowhere and streams nowhere.
 */

/** One JPEG from the page, as base64. */
export interface Frame {
  data: string;
  width: number;
  height: number;
  /** Rises with every frame, so a reader can ask for "newer than this". */
  seq: number;
}

/** Something the student did on the website, to be replayed in the real page. */
export type InputEvent =
  | {
      kind: 'mouse';
      type: 'mousePressed' | 'mouseReleased' | 'mouseMoved';
      x: number;
      y: number;
      button: 'left' | 'none';
      clickCount: number;
    }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'key'; type: 'keyDown' | 'keyUp' | 'char'; key: string; code: string; text?: string };

interface Channel {
  frame?: Frame;
  seq: number;
  touchedAt: number;
  input: InputEvent[];
  frameWaiters: ((frame: Frame | null) => void)[];
  inputWaiters: ((events: InputEvent[]) => void)[];
}

/**
 * How long a channel survives with nothing happening on it.
 *
 * Long enough to outlast a page that simply is not repainting -- a finished
 * portal page emits no frames at all -- and short enough that a closed laptop
 * does not leave its last screenful in memory for the afternoon.
 */
const IDLE_MS = 2 * 60 * 1000;

/** Bounded so a website that stops reading cannot grow this without limit. */
const MAX_QUEUED_INPUT = 64;

export class LiveSessions {
  private channels = new Map<string, Channel>();

  /** @param now Injectable so the tests are not at the mercy of the clock. */
  constructor(private now: () => number = Date.now) {}

  private channel(agentId: string): Channel {
    const existing = this.channels.get(agentId);
    if (existing) {
      existing.touchedAt = this.now();
      return existing;
    }
    const fresh: Channel = {
      seq: 0,
      touchedAt: this.now(),
      input: [],
      frameWaiters: [],
      inputWaiters: [],
    };
    this.channels.set(agentId, fresh);
    return fresh;
  }

  /** A new frame from the machine doing the work. */
  putFrame(agentId: string, frame: Omit<Frame, 'seq'>): void {
    const channel = this.channel(agentId);
    channel.seq += 1;
    channel.frame = { ...frame, seq: channel.seq };

    // Everyone waiting gets this one and is dropped; they will ask again.
    const waiting = channel.frameWaiters.splice(0);
    for (const resolve of waiting) resolve(channel.frame);
  }

  /**
   * The newest frame, waiting for one if the caller has already seen it.
   *
   * Held open rather than answered empty, so the website can sit on a request
   * and get the next repaint the moment it happens instead of asking four
   * times a second and mostly being told nothing changed.
   */
  waitForFrame(agentId: string, since: number, timeoutMs: number): Promise<Frame | null> {
    const channel = this.channel(agentId);
    if (channel.frame && channel.frame.seq > since) return Promise.resolve(channel.frame);

    return new Promise((resolve) => {
      const settle = (frame: Frame | null) => {
        clearTimeout(timer);
        channel.frameWaiters = channel.frameWaiters.filter((w) => w !== settle);
        resolve(frame);
      };
      const timer = setTimeout(() => settle(null), timeoutMs);
      // Never keeps the process alive on its own account.
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      channel.frameWaiters.push(settle);
    });
  }

  /** Something the student did, on its way to the real page. */
  pushInput(agentId: string, events: InputEvent[]): void {
    const channel = this.channel(agentId);

    const waiting = channel.inputWaiters.splice(0);
    if (waiting.length > 0) {
      for (const resolve of waiting) resolve(events);
      return;
    }

    channel.input.push(...events);
    // Oldest dropped first: a stale click is worth less than a recent one.
    if (channel.input.length > MAX_QUEUED_INPUT) {
      channel.input = channel.input.slice(-MAX_QUEUED_INPUT);
    }
  }

  /** Whatever the student has done since last asked, waiting if nothing yet. */
  waitForInput(agentId: string, timeoutMs: number): Promise<InputEvent[]> {
    const channel = this.channel(agentId);
    if (channel.input.length > 0) return Promise.resolve(channel.input.splice(0));

    return new Promise((resolve) => {
      const settle = (events: InputEvent[]) => {
        clearTimeout(timer);
        channel.inputWaiters = channel.inputWaiters.filter((w) => w !== settle);
        resolve(events);
      };
      const timer = setTimeout(() => settle([]), timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      channel.inputWaiters.push(settle);
    });
  }

  /** The app saying the browser is gone, so readers stop waiting on it. */
  end(agentId: string): void {
    const channel = this.channels.get(agentId);
    if (!channel) return;
    for (const resolve of channel.frameWaiters.splice(0)) resolve(null);
    for (const resolve of channel.inputWaiters.splice(0)) resolve([]);
    this.channels.delete(agentId);
  }

  /** Drop channels nothing has touched. Called opportunistically, not timed. */
  sweep(): void {
    const cutoff = this.now() - IDLE_MS;
    for (const [agentId, channel] of this.channels) {
      if (channel.touchedAt < cutoff && channel.frameWaiters.length === 0) this.end(agentId);
    }
  }

  /** For tests and health: how many conversations are streaming right now. */
  get size(): number {
    return this.channels.size;
  }
}
