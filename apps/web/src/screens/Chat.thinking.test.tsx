// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat } from './Chat.js';
import { BASIC_PHRASES, NICHE_PHRASES, phrasesFor } from '../lib/thinkingPhrases.js';
import type { AgentActivity } from '@contexto/shared';

/**
 * The line the student actually reads, end to end.
 *
 * Everything under it is tested on its own -- the loop reports steps, the
 * registry holds them, the route returns them, the picker chooses a phrase to
 * suit. This is the join: that the poll's answer reaches the line, that the
 * phrase turns over when the agent moves to a different step, and that it
 * holds still when the agent has not moved. Getting the last one wrong is the
 * failure that would survive every other test in the tree -- the poll hands
 * back a new object every few seconds, and a line that churns through slang on
 * a timer is exactly what this was not supposed to be.
 */

const ALL = [...BASIC_PHRASES, ...NICHE_PHRASES].map((p) => p.text);

// React needs telling that this is a test, or every act() warns and the
// updates it is supposed to flush are left in flight.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const message = (role: string, content: string) => ({
  id: `m-${role}`,
  agentId: 'a1',
  role,
  content,
  toolsUsed: [],
  createdAt: '2026-08-22T00:00:00.000Z',
});

/** What the server would say about this conversation, poll by poll. */
let serverPending: boolean;
let reported: AgentActivity | undefined;
/** Set to keep a reply in flight, so a poll can land while the turn runs. */
let holdPost: Promise<void> | undefined;

let container: HTMLDivElement;
let root: Root;

/** Let the component's in-flight fetches settle. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

/** Ask the conversation to poll now, the way returning to the window does. */
async function poll() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await settle();
}

// The mark is a span too, and it comes first -- this is the other one.
const line = () => container.querySelector('.thinking > span:not(.logo-mark)')?.textContent ?? '';

async function type(text: string) {
  const input = container.querySelector('input');
  if (!input) throw new Error('no composer on screen');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  serverPending = true;
  reported = { kind: 'thinking' };
  holdPost = undefined;

  // happy-dom has no layout, so the scroll the conversation does on every
  // change is not there to call.
  Element.prototype.scrollIntoView = () => {};

  /*
   * The mark holds still here. It asks for a frame, gets one, and asks again
   * -- an endless stream of state updates that act() waits forever to see the
   * end of. What it draws is checked in a real browser; what this file is
   * about is the words beside it.
   */
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';

    let body: unknown;
    if (url.endsWith('/messages') && method === 'POST') {
      if (holdPost) await holdPost;
      body = {
        userMessage: message('user', 'hi'),
        assistantMessage: message('assistant', 'Friday.'),
      };
    } else if (url.endsWith('/messages')) {
      body = {
        messages: [],
        pending: serverPending,
        activity: serverPending ? reported : undefined,
      };
    } else {
      body = {
        agent: {
          id: 'a1',
          name: 'Tutor',
          purpose: 'help',
          profile: '',
          createdAt: '',
          updatedAt: '',
        },
      };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Chat agentId="a1" />);
  });
  await settle();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('the line under a question', () => {
  it('says one of its phrases while a turn is running', () => {
    expect(ALL).toContain(line());
  });

  it('puts the folding mark beside it', () => {
    expect(container.querySelector('.thinking .logo-mark')).not.toBeNull();
  });

  it('holds the phrase while the agent stays on the same step', async () => {
    const first = line();
    await poll();
    await poll();
    expect(line()).toBe(first);
  });

  it('turns the phrase over when the agent moves to a different step', async () => {
    const first = line();
    reported = { kind: 'tool', name: 'gmail_search' };
    await poll();
    expect(line()).not.toBe(first);
  });

  it('chooses the new phrase to suit the new step', async () => {
    reported = { kind: 'tool', name: 'google_calendar_list_events' };
    await poll();
    const fitting = [
      ...phrasesFor('time', BASIC_PHRASES),
      ...phrasesFor('time', NICHE_PHRASES),
    ].map((p) => p.text);
    expect(fitting).toContain(line());
  });

  it('holds again once it has settled on the new step', async () => {
    reported = { kind: 'tool', name: 'gmail_search' };
    await poll();
    const onMail = line();
    await poll();
    expect(line()).toBe(onMail);
  });

  it('says nothing at all once the turn is over', async () => {
    serverPending = false;
    await poll();
    expect(container.querySelector('.thinking')).toBeNull();
  });

  it('stops the moment the answer arrives, without waiting for a poll', async () => {
    /*
     * The regression this exists for: the poll runs during a turn of our own
     * now, and the turn it reports as running is that same turn. Taking the
     * server's word for it leaves `pending` set behind our back, and with the
     * next poll four seconds away the line sits under a finished answer still
     * insisting the agent is working.
     */
    serverPending = false;
    await poll();

    let answer!: () => void;
    holdPost = new Promise<void>((resolve) => {
      answer = resolve;
    });

    await type('when is my bio test?');
    await submit();

    // The turn is now running, and the server says so. A poll lands mid-turn,
    // the way one does during any real answer.
    serverPending = true;
    await poll();
    expect(container.querySelector('.thinking')).not.toBeNull();

    serverPending = false;
    await act(async () => {
      answer();
    });
    await settle();

    expect(container.textContent).toContain('Friday.');
    expect(container.querySelector('.thinking')).toBeNull();
  });
});
