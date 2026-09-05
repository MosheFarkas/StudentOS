// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultMap } from './VaultMap.js';

// React needs telling that this is a test, or every act() warns and the
// updates it is supposed to flush are left in flight.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lib/auth.js', () => ({
  useSession: () => ({ data: { user: { id: 'u1' } } }),
}));

// A vault with nothing in it yet: the account exists, nothing is connected.
vi.mock('../lib/vaultGraph.js', () => ({
  loadGraph: vi.fn(async () => ({ nodes: [], edges: [] })),
  forgetGraph: vi.fn(),
}));

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

describe('an empty vault', () => {
  it('says what to do about it rather than what has not happened', async () => {
    act(() => root.render(<VaultMap onConnect={() => {}} />));
    await settle();

    expect(container.textContent).toContain('Connect everything to build your vault');
    expect(container.textContent).not.toContain('Nothing has been written');
  });

  it('takes the student to connections', async () => {
    const onConnect = vi.fn();
    act(() => root.render(<VaultMap onConnect={onConnect} />));
    await settle();

    act(() => {
      container.querySelector('button')?.click();
    });
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});
