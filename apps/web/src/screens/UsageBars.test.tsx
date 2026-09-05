// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageStatus } from '@contexto/shared';
import { UsageBars } from './UsageBars.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const usage = {
  activeProvider: 'platform',
  limits: {
    session: { used: 420_000, limit: 1_000_000, resetsAt: null },
    week: { used: 1_200_000, limit: 10_000_000, resetsAt: '2026-09-07T00:00:00Z' },
  },
} as unknown as UsageStatus;

describe('the usage bars', () => {
  it('say how much of each window is used, and nothing else', () => {
    act(() => root.render(<UsageBars usage={usage} />));

    const text = container.textContent ?? '';
    expect(text).toContain('This session');
    expect(text).toContain('42% used');
    expect(text).toContain('This week');
    expect(text).toContain('12% used');
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/window|refills|allowance|resets/i);
  });
});
