// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultBuild } from './VaultBuild.js';

/**
 * The first build starts itself.
 *
 * A student who has just connected everything has done the one thing a vault
 * needs. Landing back in settings to find a button they still have to press
 * is a step nobody asked for, and the timer would otherwise leave them with
 * nothing for hours.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Status = {
  ready: boolean;
  missing: string[];
  entities: number;
  episodes: number;
  building: boolean;
  progress: null;
};

let status: Status;
const build = vi.fn(async () => ({ ok: true, status: 202 }));

vi.mock('../lib/api.js', () => ({
  api: {
    vault: {
      $get: async () => ({ ok: true, json: async () => status }),
      build: { $post: (...args: unknown[]) => build(...(args as [])) },
    },
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  build.mockClear();
  status = { ready: true, missing: [], entities: 0, episodes: 0, building: false, progress: null };
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

describe('the first build', () => {
  it('starts itself once everything is connected and the vault is empty', async () => {
    act(() => root.render(<VaultBuild />));
    await settle();

    expect(build).toHaveBeenCalledTimes(1);
  });

  it('is not started for a vault that already has something in it', async () => {
    status.entities = 300;
    act(() => root.render(<VaultBuild />));
    await settle();

    expect(build).not.toHaveBeenCalled();
  });

  it('is not started while something is still not connected', async () => {
    status.ready = false;
    status.missing = ['drive'];
    act(() => root.render(<VaultBuild />));
    await settle();

    expect(build).not.toHaveBeenCalled();
  });

  it('is started once, not again on every status refresh', async () => {
    // Once it is running the server says so, and even before it does, one ask is enough.
    act(() => root.render(<VaultBuild />));
    await settle();
    await settle();

    expect(build).toHaveBeenCalledTimes(1);
  });
});
