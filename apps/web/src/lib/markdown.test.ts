import { describe, expect, it } from 'vitest';
import { parseMarkdown, spansOf } from './markdown.js';

/**
 * Enough markdown to read a vault page by.
 *
 * The pages are written in a small, known dialect because the writers are told
 * to write exactly that. What matters here is that the dialect renders, and
 * that the links inside it come out as links rather than as punctuation a
 * reader has to ignore.
 */

describe('reading a line', () => {
  it('turns a wikilink into something to follow', () => {
    expect(spansOf('Taught by [[mme-rivard]].')).toEqual([
      { text: 'Taught by ' },
      { link: 'mme-rivard' },
      { text: '.' },
    ]);
  });

  it('reads several links in one line', () => {
    const spans = spansOf('Both [[a]] and [[b]].');
    expect(spans.filter((s) => 'link' in s)).toHaveLength(2);
  });

  it('reads bold', () => {
    expect(spansOf('It is **important**.')).toContainEqual({ text: 'important', bold: true });
  });

  it('leaves plain prose alone', () => {
    expect(spansOf('Nothing special here.')).toEqual([{ text: 'Nothing special here.' }]);
  });
});

describe('reading a page', () => {
  it('reads headings and their level', () => {
    const blocks = parseMarkdown('# French\n\n## How it works');
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, spans: [{ text: 'French' }] },
      { kind: 'heading', level: 2, spans: [{ text: 'How it works' }] },
    ]);
  });

  it('gathers a list', () => {
    const blocks = parseMarkdown('- one\n- two');
    expect(blocks).toEqual([{ kind: 'list', items: [[{ text: 'one' }], [{ text: 'two' }]] }]);
  });

  it('keeps a wrapped sentence as one paragraph', () => {
    /*
     * The pages wrap their lines. Rendering each line as its own paragraph
     * would space one sentence out over half the panel.
     */
    const blocks = parseMarkdown('This sentence\nis wrapped across lines.');
    expect(blocks).toEqual([
      { kind: 'paragraph', spans: [{ text: 'This sentence is wrapped across lines.' }] },
    ]);
  });

  it('separates paragraphs on a blank line', () => {
    expect(parseMarkdown('One.\n\nTwo.')).toHaveLength(2);
  });

  it('ends a list when prose follows it', () => {
    const kinds = parseMarkdown('- one\nAnd then prose.').map((b) => b.kind);
    expect(kinds).toEqual(['list', 'paragraph']);
  });

  it('reads a page the writers actually produce', () => {
    const blocks = parseMarkdown(
      '# Lucas\n\n## What they study\n\n- [[class-french]] — French\n- [[class-math]] — Maths\n',
    );

    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'heading', 'list']);
    const list = blocks[2] as { kind: 'list'; items: unknown[] };
    expect(list.items).toHaveLength(2);
  });

  it('reads an empty page as nothing', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});
