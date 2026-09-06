import { useEffect, useState } from 'react';

/**
 * Which appearance the page is in, and who decides.
 *
 * Three settings, two outcomes. Light and dark are pinned: the root carries
 * data-theme and the choice holds whatever the OS does. System stamps nothing
 * and follows the OS live. The tokens in index.css resolve through
 * light-dark(), so all this has to do is set color-scheme by way of the
 * stamp -- and remember the choice, so index.html can restore it before the
 * first paint rather than flashing the wrong theme for a frame.
 */
export type Appearance = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

const KEY = 'appearance';
/** What the browser paints around the page. Matches --page in index.css. */
const PAGE: Record<Theme, string> = { light: '#faf9fd', dark: '#0c0f2a' };

let current: Appearance = storedAppearance();
let watching = false;
const listeners = new Set<() => void>();

export function storedAppearance(): Appearance {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyAppearance(appearance: Appearance): void {
  current = appearance;
  const root = document.documentElement;
  if (appearance === 'system') delete root.dataset.theme;
  else root.dataset.theme = appearance;

  try {
    if (appearance === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, appearance);
  } catch {
    // Storage refused: the choice still applies for this visit.
  }

  watchOs();
  changed();
}

/** Light or dark, as it is on screen right now. */
export function resolvedTheme(): Theme {
  if (current !== 'system') return current;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** For the few things CSS cannot switch on its own -- the pictures. */
export function useResolvedTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(resolvedTheme);
  useEffect(() => {
    const follow = () => setTheme(resolvedTheme());
    listeners.add(follow);
    watchOs();
    follow();
    return () => {
      listeners.delete(follow);
    };
  }, []);
  return theme;
}

function watchOs(): void {
  if (watching) return;
  watching = true;
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (current === 'system') changed();
  });
}

function changed(): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', PAGE[resolvedTheme()]);
  for (const listener of listeners) listener();
}
