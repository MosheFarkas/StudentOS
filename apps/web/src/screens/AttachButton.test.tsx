// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachButton } from './AttachButton.js';

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

const open = () =>
  act(() => {
    container.querySelector<HTMLButtonElement>('.composer-attach')?.click();
  });
const menu = () => container.querySelector('.attach-menu');

describe('the + menu', () => {
  /**
   * In a conversation the composer sits at the foot of the window, so the
   * menu has to open upward or it opens off the bottom. On the new-chat
   * screen the composer is mid-screen, and a menu above it covers the prompt.
   */
  it('opens upward unless told otherwise', () => {
    act(() => root.render(<AttachButton onChosen={() => {}} />));
    open();
    expect(menu()).not.toBeNull();
    expect(menu()?.classList.contains('opens-down')).toBe(false);
  });

  it('opens downward when asked to', () => {
    act(() => root.render(<AttachButton onChosen={() => {}} opens="down" />));
    open();
    expect(menu()?.classList.contains('opens-down')).toBe(true);
  });
});
