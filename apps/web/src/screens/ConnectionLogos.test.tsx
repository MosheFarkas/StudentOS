// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteLogo } from './ConnectionLogos.js';

// React needs telling that this is a test, or every act() warns and the
// updates it is supposed to flush are left in flight.
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

const show = (origin: string, name: string) =>
  act(() => root.render(<SiteLogo origin={origin} name={name} />));
const img = () => container.querySelector('img');
const fail = () =>
  act(() => {
    img()?.dispatchEvent(new Event('error'));
  });

describe("a custom site's mark", () => {
  it('asks the site itself first', () => {
    show('https://portals.veracross.com', 'Veracross');
    expect(img()?.getAttribute('src')).toBe('https://portals.veracross.com/favicon.ico');
  });

  it('asks the lookup next, through our own API, when the site has none', () => {
    show('https://app.schoology.com', 'Schoology');
    fail();
    expect(img()?.getAttribute('src')).toMatch(
      /\/api\/devices\/sites\/icon\?host=app\.schoology\.com$/,
    );
  });

  it('falls back to the initial when nobody has it', () => {
    show('https://nowhere.example', 'Moodle');
    fail();
    fail();
    expect(img()).toBeNull();
    expect(container.textContent).toBe('M');
  });

  it('shows the initial at once for an address that is not one', () => {
    show('not a url', 'Portal');
    expect(img()).toBeNull();
    expect(container.textContent).toBe('P');
  });
});
