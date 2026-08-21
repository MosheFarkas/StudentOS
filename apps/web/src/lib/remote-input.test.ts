import { describe, expect, it } from 'vitest';
import { keyEvents, toPagePoint } from './remote-input.js';

const shown = { width: 500, height: 350 };
const page = { width: 1000, height: 700 };

describe('toPagePoint', () => {
  it('scales a click on the picture up to the real page', () => {
    // The frame is shown at half size, so everything on it is at half its
    // real coordinates.
    expect(toPagePoint({ x: 100, y: 50 }, shown, page)).toEqual({ x: 200, y: 100 });
  });

  it('leaves a click alone when the picture is shown at full size', () => {
    expect(toPagePoint({ x: 137, y: 42 }, page, page)).toEqual({ x: 137, y: 42 });
  });

  it('keeps the far corner inside the page', () => {
    // Off-by-one here means the last row and column can never be clicked.
    expect(toPagePoint({ x: 500, y: 350 }, shown, page)).toEqual({ x: 999, y: 699 });
  });

  it('pulls a drag that left the picture back to the edge', () => {
    // The button is still down; the pointer is outside. That is an edge
    // position, not a fault.
    expect(toPagePoint({ x: -20, y: -5 }, shown, page)).toEqual({ x: 0, y: 0 });
  });

  it('answers harmlessly before the picture has been laid out', () => {
    // First paint: the element is measured at zero, and dividing by that
    // would send NaN into the protocol.
    expect(toPagePoint({ x: 10, y: 10 }, { width: 0, height: 0 }, page)).toEqual({ x: 0, y: 0 });
  });
});

describe('keyEvents', () => {
  it('types a printing character exactly once', () => {
    // Measured against a real page: text on both the keyDown and the char
    // produced "hh" from one press. Only the char carries it.
    const events = keyEvents('h', 'KeyH');
    expect(events.map((e) => e.type)).toEqual(['keyDown', 'char', 'keyUp']);
    expect(events.filter((e) => 'text' in e && e.text)).toHaveLength(1);
  });

  it('sends no character for a key that does not print', () => {
    const events = keyEvents('Backspace', 'Backspace');
    expect(events.map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('treats Enter and the arrows as non-printing too', () => {
    for (const key of ['Enter', 'ArrowLeft', 'Tab', 'Escape']) {
      expect(keyEvents(key, key).map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
    }
  });

  it('handles a character that is more than one code unit', () => {
    // An emoji is two UTF-16 units but one character to a reader, and it
    // prints -- length checks on the raw string get this wrong.
    expect(keyEvents('😀', '').map((e) => e.type)).toEqual(['keyDown', 'char', 'keyUp']);
  });
});
