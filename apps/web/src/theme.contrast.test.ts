import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every text colour clears WCAG AA on the surfaces it sits on, in both
 * themes. Read from the stylesheet itself, so a palette edit that breaks
 * legibility fails here rather than in someone's eyes at 11pm.
 */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

function token(name: string): { light: string; dark: string } {
  const m = new RegExp(`--${name}: light-dark\\(([^,]+), ([^)]+)\\);`).exec(css);
  if (!m) throw new Error(`no light-dark token --${name}`);
  return { light: m[1]!.trim(), dark: m[2]!.trim() };
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const TEXT = ['ink', 'ink-soft', 'ink-faint', 'violet-ink', 'blue-ink', 'ok', 'warn', 'danger'];
const SURFACES = ['page', 'surface'];

describe.each(['light', 'dark'] as const)('%s theme', (theme) => {
  it.each(TEXT.flatMap((text) => SURFACES.map((surface) => [text, surface])))(
    '%s reads on %s at 4.5:1',
    (text, surface) => {
      expect(contrast(token(text)[theme], token(surface)[theme])).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('white reads on the primary button', () => {
    expect(contrast('#ffffff', token('violet')[theme])).toBeGreaterThanOrEqual(4.5);
  });

  it('the focus ring clears 3:1 against the page', () => {
    expect(contrast(token('focus')[theme], token('page')[theme])).toBeGreaterThanOrEqual(3);
  });
});
