// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { drawStill, recallStill, rememberStill, type Still } from './vaultStill.js';
import type { DocEdge, DocNode } from './vaultmap.js';

const node = (name: string): DocNode => ({
  name,
  kind: 'entity',
  source: 'test',
  description: 'Course',
  degree: 1,
  cluster: null,
});

const nodes = (count: number) => Array.from({ length: count }, (_, i) => node(`note-${i}`));

describe('drawStill', () => {
  it('lands every note in the same place each time it is drawn', () => {
    const edges: DocEdge[] = [{ from: 'note-0', to: 'note-1' }];
    expect(drawStill(nodes(40), edges)).toEqual(drawStill(nodes(40), edges));
  });

  it('keeps every dot inside the ball', () => {
    for (const dot of drawStill(nodes(300), []).dots) {
      expect(Math.hypot(dot.x - 50, dot.y - 50)).toBeLessThanOrEqual(50);
      expect(dot.r).toBeGreaterThan(0);
    }
  });

  it('draws a few hundred at most, however big the vault is', () => {
    expect(drawStill(nodes(3000), []).dots.length).toBeLessThanOrEqual(260);
  });

  it('links only dots that are both drawn, by index', () => {
    const many = nodes(400);
    const edges: DocEdge[] = [
      { from: 'note-0', to: 'note-1' },
      // One end past the cap, so it has nowhere to be drawn to.
      { from: 'note-0', to: 'note-399' },
      { from: 'nowhere', to: 'note-2' },
    ];
    expect(drawStill(many, edges).links).toEqual([[0, 1]]);
  });
});

describe('the remembered still', () => {
  const still: Still = { dots: [{ x: 50, y: 50, r: 2 }], links: [] };

  beforeEach(() => localStorage.clear());

  it('comes back for the student who left it', () => {
    rememberStill('u1', still);
    expect(recallStill('u1')).toEqual(still);
  });

  it('is not shown to anyone else on the same browser', () => {
    rememberStill('u1', still);
    expect(recallStill('u2')).toBeNull();
  });

  it('is nothing rather than garbage when what is stored is not a still', () => {
    localStorage.setItem('vault-still:u1', '{"dots": "no"}');
    expect(recallStill('u1')).toBeNull();
    localStorage.setItem('vault-still:u1', 'not json');
    expect(recallStill('u1')).toBeNull();
  });

  it('survives a browser that refuses storage', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      expect(() => rememberStill('u1', still)).not.toThrow();
      expect(recallStill('u1')).toBeNull();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
