// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Chat } from './Chat.js';

/**
 * Where the page is left when the student sends something.
 *
 * A reply never drags a student who has scrolled up back down -- that rule has
 * its reasons and stays. Their own message is the exception: a question sent
 * from halfway up the conversation lands below the fold, and a send that
 * cannot be seen reads as one that did not happen.
 *
 * happy-dom has no layout, so the page's height is set by hand and the scroll
 * is watched rather than performed.
 */

// React needs telling that this is a test, or every act() warns and the
// updates it is supposed to flush are left in flight.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const message = (id: string, role: string, content: string) => ({
  id,
  agentId: 'a1',
  role,
  content,
  toolsUsed: [],
  skillsRead: [],
  createdAt: '2026-09-12T00:00:00.000Z',
});

/** Set to keep a reply in flight. */
let holdPost: Promise<void> | undefined;
let scrolled: Mock<Element['scrollIntoView']>;

let container: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

/** Leave the student reading an earlier part of a long conversation. */
async function scrollUp() {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    value: 5000,
  });
  await act(async () => {
    window.dispatchEvent(new Event('scroll'));
  });
  // The page agrees it is scrolled up: it is offering the jump back down.
  expect(container.querySelector('.to-bottom')).not.toBeNull();
  scrolled.mockClear();
}

async function send(text: string) {
  const input = container.querySelector<HTMLInputElement>('.composer-row > input');
  if (!input) throw new Error('no composer on screen');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** Keep the reply in flight until the returned function is called. */
function holdReply() {
  let answer!: () => void;
  holdPost = new Promise<void>((resolve) => {
    answer = resolve;
  });
  return async () => {
    await act(async () => {
      answer();
    });
    await settle();
  };
}

beforeEach(async () => {
  holdPost = undefined;
  scrolled = vi.fn<Element['scrollIntoView']>();
  Element.prototype.scrollIntoView = scrolled;
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';

    let body: unknown;
    if (url.endsWith('/messages') && method === 'POST') {
      if (holdPost) await holdPost;
      body = {
        userMessage: message('m3', 'user', 'and the one after?'),
        assistantMessage: message('m4', 'assistant', 'Tuesday.'),
      };
    } else if (url.endsWith('/messages')) {
      // Something already said, so there is somewhere to have scrolled up to.
      body = {
        messages: [
          message('m1', 'user', 'when is my bio test?'),
          message('m2', 'assistant', 'Friday.'),
        ],
        pending: false,
        skills: [],
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
  Reflect.deleteProperty(document.documentElement, 'scrollHeight');
  vi.unstubAllGlobals();
});

describe('sending from partway up the conversation', () => {
  it('takes the page down to the message the moment it is sent', async () => {
    holdReply();
    await scrollUp();

    await send('and the one after?');

    expect(scrolled).toHaveBeenCalled();
  });

  it('leaves them be if they scroll back up before the reply lands', async () => {
    const release = holdReply();
    await scrollUp();
    await send('and the one after?');

    // Still scrolled up -- happy-dom performed nothing, which is the same as
    // the student having gone back up to reread while the turn ran.
    scrolled.mockClear();
    await release();

    expect(container.textContent).toContain('Tuesday.');
    expect(scrolled).not.toHaveBeenCalled();
  });
});
