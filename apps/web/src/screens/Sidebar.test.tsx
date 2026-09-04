// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, sortChats } from './Sidebar.js';
import { initialOf } from '../lib/initial.js';
import { NewChat } from './NewChat.js';
import { takeHandoff } from '../lib/handoff.js';

/**
 * That the new shell draws at all, and draws the right things.
 *
 * The pieces underneath have their own tests -- the greeting pool is pinned in
 * greeting.test.ts, the router in router.test.ts. What this covers is the join
 * a typecheck cannot: that these two components mount without throwing, that
 * the rail lists what the server returned, and that the footer shows a letter
 * and a name rather than the account menu's contents.
 */

// React needs telling that this is a test, or every act() warns and the
// updates it is supposed to flush are left in flight.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** Let the component's in-flight fetches settle. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  /*
   * The mark asks for a frame, gets one, and asks again -- a stream of updates
   * act() would wait forever to see the end of. What it draws is checked in a
   * real browser; what this file is about is the rail around it.
   */
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});

  vi.stubGlobal('fetch', async () => {
    const agent = (id: string, name: string) => ({
      id,
      name,
      purpose: '',
      profile: '',
      archivedAt: null,
      pinnedAt: null,
      createdAt: '',
      updatedAt: '',
    });
    return new Response(
      JSON.stringify({ agents: [agent('a1', 'Bio midterm plan'), agent('a2', 'Essay outline')] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.className = '';
  vi.unstubAllGlobals();
});

const text = (selector: string) =>
  [...container.querySelectorAll(selector)].map((el) => el.textContent ?? '');

describe('the rail', () => {
  async function show(name?: string | null, email?: string | null) {
    await act(async () => {
      root.render(<Sidebar route={{ name: 'new' }} working={false} name={name} email={email} />);
    });
    await settle();
  }

  it('lists the chats the server returned', async () => {
    await show('Lucas');
    expect(text('.sidebar-chat-open')).toEqual(['Bio midterm plan', 'Essay outline']);
  });

  it('offers exactly one way to start, and calls it New', async () => {
    await show('Lucas');
    expect(text('.sidebar-new')).toEqual(['New']);
  });

  it('marks the screen you are on', async () => {
    await act(async () => {
      root.render(<Sidebar route={{ name: 'chat', agentId: 'a2' }} working={false} name="Lucas" />);
    });
    await settle();
    expect(text('.sidebar-chat.is-current .sidebar-chat-open')).toEqual(['Essay outline']);
  });

  it('shows the student their initial and their name', async () => {
    await show('Lucas');
    expect(text('.account-initial')).toEqual(['L']);
    expect(text('.account-name')).toEqual(['Lucas']);
  });

  it('falls back to the email when the account carries no name', async () => {
    await show(null, 'lucas@school.edu');
    expect(text('.account-name')).toEqual(['lucas']);
    expect(text('.account-initial')).toEqual(['L']);
  });

  it('keeps Settings and Sign out behind the name until it is pressed', async () => {
    await show('Lucas');
    expect(container.querySelector('.account-menu')).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.account-button')?.click();
    });
    expect(text('.account-menu button')).toEqual(['Settings', 'Sign out']);
  });

  it('still draws when the chat list cannot be fetched', async () => {
    // A rail that cannot list is still a rail you can start a chat from.
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    await show('Lucas');
    expect(text('.sidebar-new')).toEqual(['New']);
    expect(text('.sidebar-chat-open')).toEqual([]);
  });
});

describe('what a chat row can do', () => {
  /** Chats as the server would send them, with whatever state the test needs. */
  function listing(
    ...rows: { id: string; name: string; archivedAt?: string; pinnedAt?: string }[]
  ) {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
      if (method === 'PATCH' || method === 'DELETE') {
        patched.push({
          method,
          ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
        });
        const [target] = rows;
        return new Response(
          JSON.stringify({
            agent: { ...blank(target!.id, target!.name), ...patched.at(-1)?.body },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ agents: rows.map((r) => ({ ...blank(r.id, r.name), ...r })) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
  }

  const blank = (id: string, name: string) => ({
    id,
    name,
    purpose: '',
    profile: '',
    archivedAt: null,
    pinnedAt: null,
    createdAt: '',
    updatedAt: '',
  });

  let patched: { method: string; body?: Record<string, unknown> }[];

  beforeEach(() => {
    patched = [];
  });

  async function railWith(...rows: Parameters<typeof listing>) {
    vi.stubGlobal('fetch', listing(...rows));
    await act(async () => {
      root.render(<Sidebar route={{ name: 'new' }} working={false} name="Lucas" />);
    });
    await settle();
  }

  const openRowMenu = async (index = 0) => {
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>('.sidebar-chat-more')[index]?.click();
    });
  };

  it('keeps the menu shut until the dots are pressed', async () => {
    await railWith({ id: 'c1', name: 'Bio midterm plan' });
    expect(container.querySelector('.chat-menu')).toBeNull();
  });

  it('offers rename, pin, archive and delete', async () => {
    await railWith({ id: 'c1', name: 'Bio midterm plan' });
    await openRowMenu();
    expect(text('.chat-menu button')).toEqual(['Rename', 'Pin', 'Archive', 'Delete']);
  });

  it('offers to unpin a chat that is already pinned', async () => {
    await railWith({ id: 'c1', name: 'Bio midterm plan', pinnedAt: '2026-09-01T00:00:00.000Z' });
    await openRowMenu();
    expect(text('.chat-menu button')).toContain('Unpin');
  });

  it('keeps archived chats out of the rail', async () => {
    // Not deleted -- settings lists them, and the vault never noticed.
    await railWith(
      { id: 'c1', name: 'Still here' },
      { id: 'c2', name: 'Put away', archivedAt: '2026-09-01T00:00:00.000Z' },
    );
    expect(text('.sidebar-chat-open')).toEqual(['Still here']);
  });

  it('shows a chat whose archived flag the server never sent', async () => {
    /*
     * A response from before the column existed, or a client ahead of a
     * server. Reading a missing field as "archived" would empty the rail
     * completely -- the loudest possible failure for the smallest mismatch.
     */
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            agents: [
              {
                id: 'c1',
                name: 'No flags',
                purpose: '',
                profile: '',
                createdAt: '',
                updatedAt: '',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    await act(async () => {
      root.render(<Sidebar route={{ name: 'new' }} working={false} name="Lucas" />);
    });
    await settle();
    expect(text('.sidebar-chat-open')).toEqual(['No flags']);
  });

  it('asks before deleting, naming the chat', async () => {
    await railWith({ id: 'c1', name: 'Bio midterm plan' });
    await openRowMenu();
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('.chat-menu button')]
        .find((b) => b.textContent === 'Delete')
        ?.click();
    });

    // Portalled to the body, so it is not inside the rail.
    const dialog = document.querySelector('.dialog');
    expect(dialog?.textContent).toContain('Are you sure you want to delete this chat?');
    expect(dialog?.textContent).toContain('Bio midterm plan');
    expect(dialog?.textContent).toContain('permanently deleted from your vault');
    expect(patched).toEqual([]);
  });

  it('deletes nothing when the question is cancelled', async () => {
    await railWith({ id: 'c1', name: 'Bio midterm plan' });
    await openRowMenu();
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('.chat-menu button')]
        .find((b) => b.textContent === 'Delete')
        ?.click();
    });
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('.dialog-actions button')]
        .find((b) => b.textContent === 'Cancel')
        ?.click();
    });

    expect(document.querySelector('.dialog')).toBeNull();
    expect(patched).toEqual([]);
    expect(text('.sidebar-chat-open')).toEqual(['Bio midterm plan']);
  });
});

describe('the order the rail is in', () => {
  const at = (id: string, pinnedAt: string | null, updatedAt: string) => ({
    id,
    name: id,
    purpose: '',
    profile: '',
    archivedAt: null,
    pinnedAt,
    updatedAt,
    createdAt: '',
  });

  it('puts pinned chats above the rest', () => {
    const order = sortChats([
      at('plain', null, '2026-09-03T00:00:00.000Z'),
      at('pinned', '2026-09-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
    ]).map((c) => c.id);

    // Even though the unpinned one was used more recently.
    expect(order).toEqual(['pinned', 'plain']);
  });

  it('puts the newest pin first among pinned chats', () => {
    const order = sortChats([
      at('older', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
      at('newer', '2026-09-02T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
    ]).map((c) => c.id);
    expect(order).toEqual(['newer', 'older']);
  });

  it('falls back to most recently used', () => {
    const order = sortChats([
      at('stale', null, '2026-08-01T00:00:00.000Z'),
      at('fresh', null, '2026-09-03T00:00:00.000Z'),
    ]).map((c) => c.id);
    expect(order).toEqual(['fresh', 'stale']);
  });
});

describe('the initial in the circle', () => {
  it('uppercases whatever the name starts with', () => {
    expect(initialOf('Lucas')).toBe('L');
    expect(initialOf('lucas')).toBe('L');
    expect(initialOf('  lucas ')).toBe('L');
  });

  it('does not split a character in half', () => {
    // Spread rather than [0], so an emoji or an accented pair survives.
    expect(initialOf('Émile')).toBe('É');
  });

  it('says something rather than nothing when there is no name at all', () => {
    expect(initialOf('')).toBe('?');
  });
});

describe('the new-chat screen', () => {
  it('greets the student and offers somewhere to type', async () => {
    await act(async () => {
      root.render(<NewChat name="Lucas" />);
    });
    await settle();

    expect(container.querySelector('.newchat-greeting')?.textContent).toBeTruthy();
    expect(container.querySelector('textarea')?.getAttribute('placeholder')).toBe(
      'How can I help you today?',
    );
  });

  it('holds the greeting still while the student types', async () => {
    await act(async () => {
      root.render(<NewChat name="Lucas" />);
    });
    await settle();
    const first = container.querySelector('.newchat-greeting')?.textContent;

    const input = container.querySelector('textarea');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, 'what is due friday');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // A sentence that changes under you mid-thought is worse than a dull one.
    expect(container.querySelector('.newchat-greeting')?.textContent).toBe(first);
  });

  describe('attaching a file', () => {
    async function show() {
      await act(async () => {
        root.render(<NewChat name="Lucas" />);
      });
      await settle();
    }

    const openMenu = async () => {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.composer-attach')?.click();
      });
    };

    it('offers the attach button', async () => {
      await show();
      expect(container.querySelector('.composer-attach')).not.toBeNull();
    });

    it('keeps the menu shut until the button is pressed', async () => {
      await show();
      expect(container.querySelector('.attach-menu')).toBeNull();
    });

    it('offers uploading from this computer', async () => {
      await show();
      await openMenu();
      expect(text('.attach-menu button')).toContain('Upload from this computer');
    });

    /*
     * The failure this whole feature started from. The button used to disable
     * itself when the Drive picker had no keys, which meant a deployment
     * without them had no way to attach anything at all -- including files
     * that never go near Drive.
     */
    it('still offers uploading where the Drive picker is not configured', async () => {
      // No VITE_GOOGLE_* in the test environment, so pickerConfigured() is false.
      await show();
      expect(container.querySelector<HTMLButtonElement>('.composer-attach')?.disabled).toBe(false);
      await openMenu();
      expect(text('.attach-menu button')).toEqual(['Upload from this computer']);
    });

    it('gives the file dialog something it will accept', async () => {
      await show();
      const input = container.querySelector('input[type=file]');
      expect(input).not.toBeNull();
      expect(input?.getAttribute('accept')).toContain('.pdf');
      // Several at once: a student attaching a term's handouts should not
      // have to open the dialog six times.
      expect(input?.hasAttribute('multiple')).toBe(true);
    });

    it('shuts the menu when Escape is pressed', async () => {
      await show();
      await openMenu();
      expect(container.querySelector('.attach-menu')).not.toBeNull();

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(container.querySelector('.attach-menu')).toBeNull();
    });
  });

  describe('starting a chat', () => {
    /** What the app asked the server to create, if anything. */
    let created: { name?: string; purpose?: string } | undefined;

    beforeEach(() => {
      created = undefined;
      window.history.pushState({}, '', '/');
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
        if (method === 'POST') {
          created = JSON.parse(String(init?.body ?? '{}'));
          return new Response(JSON.stringify({ agent: { id: 'new-1', name: created?.name } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
    });

    async function typeAndSend(text: string) {
      await act(async () => {
        root.render(<NewChat name="Lucas" />);
      });
      await settle();

      const input = container.querySelector('textarea');
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(input, text);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        container
          .querySelector('form')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await settle();
    }

    it('creates a chat named after what was typed', async () => {
      await typeAndSend('what is due friday');
      expect(created?.name).toBe('What is due friday');
    });

    it('creates it without a purpose, because there is no longer one to give', async () => {
      await typeAndSend('what is due friday');
      expect(created?.purpose).toBe('');
    });

    it('opens the new chat', async () => {
      await typeAndSend('what is due friday');
      expect(window.location.pathname).toBe('/chats/new-1');
    });

    it('leaves the message for the conversation to send', async () => {
      await typeAndSend('what is due friday');
      // Sent from the conversation, not from here, so the student watches the
      // reply arrive rather than a screen that has not changed.
      expect(takeHandoff('new-1')).toBe('what is due friday');
    });

    it('will not start a chat from an empty box', async () => {
      await typeAndSend('   ');
      expect(created).toBeUndefined();
      expect(window.location.pathname).toBe('/');
    });

    it('says so when the chat cannot be created, and keeps the draft', async () => {
      vi.stubGlobal('fetch', async () => new Response('no', { status: 500 }));
      await typeAndSend('what is due friday');
      expect(container.querySelector('.newchat-error')?.textContent).toContain('500');
      expect(container.querySelector('textarea')?.value).toBe('what is due friday');
      expect(window.location.pathname).toBe('/');
    });
  });
});
