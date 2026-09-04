// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat } from './Chat.js';
import { handOff } from '../lib/handoff.js';

/**
 * The first message of a chat, which does not come from the composer.
 *
 * It is typed on the new-chat screen, left behind, and sent by the
 * conversation as it opens. The join is worth its own test because the failure
 * is a race rather than a wrong answer: opening a chat loads its history and
 * calls setMessages with the server's list, and a message put on screen
 * optimistically before that lands is wiped by it. What the student sees is
 * their own question vanishing.
 */

// React needs telling that this is a test, or every act() warns and the
// updates it is supposed to flush are left in flight.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every message the app posted, in order. */
let posted: string[];
/** Resolved by the test to let the history request land when it chooses. */
let releaseHistory: (() => void) | undefined;

let container: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

const message = (role: string, content: string) => ({
  id: `m-${role}-${content}`,
  agentId: 'a1',
  role,
  content,
  toolsUsed: [],
  createdAt: '2026-09-01T00:00:00.000Z',
});

beforeEach(() => {
  posted = [];
  releaseHistory = undefined;

  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';

    let body: unknown;
    if (url.endsWith('/messages') && method === 'POST') {
      const sent = JSON.parse(String(init?.body ?? '{}')).content as string;
      posted.push(sent);
      body = {
        userMessage: message('user', sent),
        assistantMessage: message('assistant', 'Two things are due.'),
      };
    } else if (url.endsWith('/messages')) {
      // A brand new chat: the server has nothing yet.
      if (releaseHistory) await new Promise<void>((go) => (releaseHistory = go));
      body = { messages: [], pending: false, activity: undefined };
    } else {
      body = { agent: { id: 'a1', name: 'What is due friday', purpose: '' } };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function open(agentId = 'a1') {
  await act(async () => {
    root.render(<Chat agentId={agentId} />);
  });
  await settle();
}

const shown = () => [...container.querySelectorAll('.message')].map((el) => el.textContent ?? '');

describe('the message a chat was started with', () => {
  it('is sent as the conversation opens', async () => {
    handOff('a1', 'what is due friday');
    await open();
    expect(posted).toEqual(['what is due friday']);
  });

  it('is not sent twice, however often the screen settles', async () => {
    handOff('a1', 'what is due friday');
    await open();
    await settle();
    await settle();
    expect(posted).toEqual(['what is due friday']);
  });

  it('leaves the question and its answer on screen', async () => {
    handOff('a1', 'what is due friday');
    await open();
    expect(shown()).toEqual(['what is due friday', 'Two things are due.']);
  });

  it('waits for the history rather than racing it', async () => {
    /*
     * The ordering this test exists to pin. Opening a chat calls setMessages
     * with the server's list, so a first message put on screen before that
     * lands is erased by it. Holding the history open proves the send is
     * behind it: nothing is posted until the history has arrived.
     */
    releaseHistory = () => {};
    handOff('a1', 'what is due friday');
    await open();
    // Still waiting on the history, so nothing has been said yet.
    expect(posted).toEqual([]);

    await act(async () => {
      releaseHistory?.();
    });
    await settle();

    expect(shown()).toContain('what is due friday');
    expect(posted).toEqual(['what is due friday']);
  });

  it('sends nothing when the chat was opened rather than started', async () => {
    // Clicking a chat in the rail must not re-send anything.
    await open();
    expect(posted).toEqual([]);
  });

  it('does not deliver one chat the message meant for another', async () => {
    handOff('other-chat', 'not for this one');
    await open('a1');
    expect(posted).toEqual([]);
  });
});

describe('a message with a picture on it', () => {
  const photo = () => new File([new Uint8Array([1, 2])], 'board.png', { type: 'image/png' });

  it('shows the picture the instant it is sent, before any upload lands', async () => {
    /*
     * The whole point of the change. Uploading first meant the thumbnail sat
     * in the composer for several seconds after the student pressed send,
     * which reads as the press not having worked.
     *
     * The upload is held open here, so what is asserted is the state while it
     * is still in flight: the message is up, the picture is on it, and it is
     * being shown from the copy the browser already has.
     */
    let releaseUpload: (() => void) | undefined;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';

      if (url.endsWith('/uploads')) {
        await new Promise<void>((go) => (releaseUpload = go));
        return new Response(JSON.stringify({ name: 'board', filename: 'board.png', image: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/messages') && method === 'POST') {
        posted.push(JSON.parse(String(init?.body ?? '{}')).content as string);
        return new Response(
          JSON.stringify({
            userMessage: { ...message('user', 'what is this'), attachments: [] },
            assistantMessage: message('assistant', 'A connector.'),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/messages')) {
        return new Response(JSON.stringify({ messages: [], pending: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ agent: { id: 'a1', name: 'x', purpose: '' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    handOff('a1', 'what is this', [photo()]);
    await open();

    // Still uploading, and the message is already complete on screen.
    const shown = container.querySelector<HTMLImageElement>('.message-image');
    expect(shown).not.toBeNull();
    expect(shown?.getAttribute('src')).toMatch(/^blob:|^data:/);
    expect(posted).toEqual([]);

    await act(async () => {
      releaseUpload?.();
    });
    await settle();
    // Just what they typed. The file is carried beside the message, not
    // announced inside it -- the thumbnail above the bubble already says so.
    expect(posted).toEqual(['what is this']);
  });
});
