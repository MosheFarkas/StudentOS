// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { el } from './dom.mjs';

/**
 * These assert the rendered element's live properties, not the props passed
 * in. The bug that prompted them produced perfect-looking markup: the button
 * showed the right label and was permanently unclickable, so any test reading
 * text alone would have passed.
 */
describe('el', () => {
  it('leaves a button enabled when disabled is absent', () => {
    // `disabled: null` used to stringify to "null", and disabled is a boolean
    // attribute -- any value at all disables it.
    const button = el('button', { text: 'Link this computer', disabled: null });
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['false', false],
  ])('treats %s as absent rather than setting it', (_label, value) => {
    expect(el('button', { disabled: value }).disabled).toBe(false);
  });

  it('still disables when asked to', () => {
    expect(el('button', { disabled: 'true' }).disabled).toBe(true);
    expect(el('button', { disabled: true }).disabled).toBe(true);
  });

  it('sets text as text, never as markup', () => {
    // Portal names are typed by the student and errors come from a school's
    // server; neither is markup this app should evaluate.
    const node = el('div', { text: '<img src=x onerror=alert(1)>' });
    expect(node.querySelector('img')).toBeNull();
    expect(node.textContent).toContain('<img');
  });

  it('wires event handlers and fires them', () => {
    const onclick = vi.fn();
    el('button', { onclick }).click();
    expect(onclick).toHaveBeenCalledOnce();
  });

  it('skips absent children so conditional rows can render nothing', () => {
    const node = el('div', {}, [el('span', { text: 'kept' }), null, undefined, false]);
    expect(node.childNodes).toHaveLength(1);
  });

  it('applies class and arbitrary attributes', () => {
    const node = el('input', { class: 'primary', type: 'checkbox', 'aria-label': 'Portal name' });
    expect(node.className).toBe('primary');
    expect(node.getAttribute('aria-label')).toBe('Portal name');
    expect(node.type).toBe('checkbox');
  });
});
