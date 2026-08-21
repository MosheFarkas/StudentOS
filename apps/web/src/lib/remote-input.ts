/**
 * Turning something done on a picture into something done on a page.
 *
 * The website shows frames of a browser running on the student's machine, at
 * whatever size the column happens to be. A click at (40, 90) on that picture
 * means nothing to the real page until it is expressed in the page's own
 * coordinates -- so everything here is one conversion, kept apart from the
 * component so it can be checked without a browser.
 */

export interface Size {
  width: number;
  height: number;
}

/**
 * Where on the real page a click on the picture landed.
 *
 * The frame keeps its aspect ratio when displayed, so one scale factor serves
 * both axes. Rounded because the protocol wants whole pixels, and clamped
 * because a drag can leave the image while the button is still down -- a
 * pointer at -3 is a pointer at the edge, not an error.
 */
export function toPagePoint(local: { x: number; y: number }, shown: Size, page: Size) {
  if (shown.width <= 0 || shown.height <= 0) return { x: 0, y: 0 };

  const scale = page.width / shown.width;
  return {
    x: clamp(Math.round(local.x * scale), 0, Math.max(0, page.width - 1)),
    y: clamp(Math.round(local.y * scale), 0, Math.max(0, page.height - 1)),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * The events that type one character.
 *
 * Three, in the order the protocol expects, and only the middle one carries
 * text: anything with `text` inserts a character, so a press that both went
 * down with text and sent a char typed it twice.
 *
 * A key that does not print -- Backspace, Enter, an arrow -- acts on the way
 * down and has nothing to insert, so it sends no char at all.
 */
export function keyEvents(key: string, code: string) {
  const prints = [...key].length === 1;
  return [
    { kind: 'key' as const, type: 'keyDown' as const, key, code },
    ...(prints ? [{ kind: 'key' as const, type: 'char' as const, key, code, text: key }] : []),
    { kind: 'key' as const, type: 'keyUp' as const, key, code },
  ];
}
