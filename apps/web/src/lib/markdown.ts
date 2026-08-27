/**
 * Enough markdown to read a vault page by.
 *
 * The pages are written in a small, known dialect -- headings, short
 * paragraphs, lists, the occasional bold run, and wikilinks -- because the
 * writers are instructed to write exactly that. So this parses that dialect
 * rather than pulling in a general markdown library to render prose nobody is
 * going to write.
 *
 * It returns a structure rather than markup. The component decides what a
 * wikilink does, which is the whole reason the panel is worth having: a link
 * out of a page is a way into what the page was written from.
 */

export type Span = { text: string; bold?: true } | { link: string };

export type Block =
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'list'; items: Span[][] };

/** `[[a-note]]` or `**bold**`, whichever comes first. */
const INLINE = /(\[\[[^\]]+\]\]|\*\*[^*]+\*\*)/g;

export function spansOf(text: string): Span[] {
  const spans: Span[] = [];

  for (const piece of text.split(INLINE)) {
    if (piece === '') continue;

    const link = /^\[\[([^\]]+)\]\]$/.exec(piece);
    if (link) {
      spans.push({ link: link[1] as string });
      continue;
    }

    const bold = /^\*\*([^*]+)\*\*$/.exec(piece);
    if (bold) {
      spans.push({ text: bold[1] as string, bold: true });
      continue;
    }

    spans.push({ text: piece });
  }

  return spans;
}

export function parseMarkdown(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let items: Span[][] = [];

  const endParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', spans: spansOf(paragraph.join(' ')) });
    paragraph = [];
  };

  const endList = () => {
    if (items.length === 0) return;
    blocks.push({ kind: 'list', items });
    items = [];
  };

  for (const line of body.split('\n')) {
    const trimmed = line.trim();

    if (trimmed === '') {
      endParagraph();
      endList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      endParagraph();
      endList();
      blocks.push({
        kind: 'heading',
        level: (heading[1] as string).length,
        spans: spansOf(heading[2] as string),
      });
      continue;
    }

    const item = /^[-*]\s+(.*)$/.exec(trimmed);
    if (item) {
      endParagraph();
      items.push(spansOf(item[1] as string));
      continue;
    }

    /*
     * Anything else is prose, and consecutive lines are one paragraph.
     *
     * A page wraps its lines; rendering each as its own paragraph would space
     * a single sentence out over half the panel.
     */
    endList();
    paragraph.push(trimmed);
  }

  endParagraph();
  endList();
  return blocks;
}
