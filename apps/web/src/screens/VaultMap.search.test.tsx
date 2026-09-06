// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultMap } from './VaultMap.js';

/**
 * Looking for something in the vault.
 *
 * The bar across the top has a search in it. What it finds is lit up in the
 * ball, and the ball itself is WebGL and not here -- so what this checks is
 * the frame: that typing counts what was found, and that the way out still
 * works once there is a search to clear first.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lib/auth.js', () => ({
  useSession: () => ({ data: { user: { id: 'u1' } } }),
}));

// The reader fetches the page being read; there is no server here.
vi.mock('../lib/api.js', () => {
  const nothing = { $get: async () => ({ ok: false }) };
  return { api: { vault: { doc: { ':name': nothing }, note: { ':name': nothing } } } };
});

vi.mock('../lib/vaultGraph.js', () => ({
  loadGraph: vi.fn(async () => ({
    nodes: [
      {
        name: 'user',
        kind: 'document',
        source: 'agent',
        description: 'You',
        degree: 0,
        cluster: null,
      },
      {
        name: 'cold-war-essay',
        kind: 'entity',
        source: 'classroom',
        description: 'Assignment',
        degree: 1,
        cluster: 'history',
      },
      {
        name: 'vectors',
        kind: 'entity',
        source: 'classroom',
        description: 'Assignment',
        degree: 1,
        cluster: 'math',
      },
    ],
    edges: [],
  })),
  forgetGraph: vi.fn(),
}));

// The stage measures itself with one of these, which happy-dom may not have.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  disconnect() {}
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

/** Into the vault, with the search in front of you. */
async function open(): Promise<HTMLInputElement> {
  act(() => root.render(<VaultMap onConnect={() => {}} />));
  await settle();
  act(() => {
    container.querySelector<HTMLButtonElement>('button.vault-open')?.click();
  });
  await settle();

  const field = document.body.querySelector<HTMLInputElement>('input.vault-search');
  if (!field) throw new Error('No search field in the vault');
  return field;
}

/** Typing, the way React hears it. */
function type(field: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    set?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(field: HTMLInputElement, key: string) {
  act(() => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('searching the vault', () => {
  it('counts what was found as you type', async () => {
    const field = await open();

    type(field, 'cold');
    expect(document.body.textContent).toContain('1 found');

    type(field, 'essay vectors');
    expect(document.body.textContent).toContain('0 found');
  });

  it('says nothing about a count until something is typed', async () => {
    await open();
    expect(document.body.textContent).not.toContain('found');
  });

  it('clears the search on Escape before it leaves the vault', async () => {
    const field = await open();
    type(field, 'cold');

    press(field, 'Escape');
    expect(field.value).toBe('');
    expect(document.body.querySelector('.vault-inside')).not.toBeNull();

    press(field, 'Escape');
    expect(document.body.querySelector('.vault-inside')).toBeNull();
  });
});
