// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAppearance, resolvedTheme, storedAppearance } from './theme.js';

let dark = false;
const listeners = new Set<() => void>();

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML = '<meta name="theme-color" content="#faf9fd">';
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('dark') && dark,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  listeners.clear();
  dark = false;
});

const flipOs = (toDark: boolean) => {
  dark = toDark;
  for (const fn of listeners) fn();
};

describe('applyAppearance', () => {
  it('pins dark on the root, and the choice survives the OS changing its mind', () => {
    applyAppearance('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(resolvedTheme()).toBe('dark');
    flipOs(false);
    expect(resolvedTheme()).toBe('dark');
  });

  it('stamps nothing for system and follows the OS live', () => {
    applyAppearance('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(resolvedTheme()).toBe('light');
    flipOs(true);
    expect(resolvedTheme()).toBe('dark');
  });

  it('remembers the choice for the next load, and forgets it for system', () => {
    applyAppearance('light');
    expect(storedAppearance()).toBe('light');
    applyAppearance('system');
    expect(storedAppearance()).toBe('system');
  });

  it('tells the browser chrome which colour the page is', () => {
    applyAppearance('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#0c0f2a',
    );
    applyAppearance('light');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#faf9fd',
    );
  });
});
