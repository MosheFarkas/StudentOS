import { describe, expect, it } from 'vitest';
import { parseSegments, toPreviewTarget } from './preview.js';

describe('toPreviewTarget', () => {
  it('converts a Drive file link to its preview route', () => {
    const target = toPreviewTarget(
      'https://drive.google.com/file/d/1VSFW3Px0w9stM4Vjui01DNrtRQ12YfzH/view?usp=drive_web',
    );
    expect(target?.embedUrl).toBe(
      'https://drive.google.com/file/d/1VSFW3Px0w9stM4Vjui01DNrtRQ12YfzH/preview',
    );
  });

  it('converts Docs, Slides, and Sheets', () => {
    // These are real link shapes from the school Classroom account.
    expect(
      toPreviewTarget('https://docs.google.com/presentation/d/1eHprJ4r33/edit?usp=drive_web')
        ?.embedUrl,
    ).toBe('https://docs.google.com/presentation/d/1eHprJ4r33/preview');

    expect(toPreviewTarget('https://docs.google.com/document/d/1qeVneDgcDn6/edit')?.embedUrl).toBe(
      'https://docs.google.com/document/d/1qeVneDgcDn6/preview',
    );

    expect(toPreviewTarget('https://docs.google.com/spreadsheets/d/abc123/edit')?.embedUrl).toBe(
      'https://docs.google.com/spreadsheets/d/abc123/preview',
    );
  });

  it('refuses Drive folders', () => {
    // Folders have no preview route; embedding one renders Google's
    // "refused to connect" frame, which looks like our bug.
    expect(
      toPreviewTarget('https://drive.google.com/drive/folders/1e6AB92A6XONnpIC1BF5NlfdZazk3FYe7'),
    ).toBeNull();
  });

  it('refuses Classroom permalinks', () => {
    // classroom.google.com sets X-Frame-Options and cannot be embedded.
    expect(
      toPreviewTarget('https://classroom.google.com/c/Nzc0OTY3NzkzNjM1/p/ODY3NDc0OTAxOTg5'),
    ).toBeNull();
  });

  it('embeds YouTube in both link forms', () => {
    expect(toPreviewTarget('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.embedUrl).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
    expect(toPreviewTarget('https://youtu.be/dQw4w9WgXcQ')?.embedUrl).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
  });

  it('returns null for unrelated or malformed links', () => {
    expect(toPreviewTarget('https://example.com/thing.pdf')).toBeNull();
    expect(toPreviewTarget('not a url')).toBeNull();
    expect(toPreviewTarget('')).toBeNull();
  });

  it('keeps the label for display', () => {
    const target = toPreviewTarget('https://drive.google.com/file/d/abc/view', 'Exam Review');
    expect(target?.label).toBe('Exam Review');
    expect(target?.sourceUrl).toBe('https://drive.google.com/file/d/abc/view');
  });
});

describe('parseSegments', () => {
  it('splits markdown links out of prose', () => {
    const segments = parseSegments(
      'Here it is: [Exam Review](https://drive.google.com/file/d/abc/view) — good luck.',
    );

    expect(segments.map((s) => s.type)).toEqual(['text', 'link', 'text']);
    const link = segments[1];
    expect(link?.type === 'link' && link.label).toBe('Exam Review');
    expect(link?.type === 'link' && link.preview?.embedUrl).toContain('/preview');
  });

  it('finds bare URLs too', () => {
    const segments = parseSegments('see https://docs.google.com/document/d/x/edit for details');
    const link = segments.find((s) => s.type === 'link');
    expect(link?.type === 'link' && link.url).toBe('https://docs.google.com/document/d/x/edit');
  });

  it('marks non-embeddable links as link-only', () => {
    const segments = parseSegments('[Post](https://classroom.google.com/c/123/p/456)');
    const link = segments[0];
    expect(link?.type === 'link' && link.preview).toBeNull();
  });

  it('leaves plain text untouched', () => {
    const segments = parseSegments('No links here at all.');
    expect(segments).toEqual([{ type: 'text', value: 'No links here at all.' }]);
  });

  it('handles several links in one message', () => {
    const segments = parseSegments(
      '[A](https://drive.google.com/file/d/a/view) and [B](https://drive.google.com/file/d/b/view)',
    );
    expect(segments.filter((s) => s.type === 'link')).toHaveLength(2);
  });

  it('does not choke on a trailing bracket or paren', () => {
    // Model output is not guaranteed well-formed markdown.
    expect(() => parseSegments('[broken](http://x.com')).not.toThrow();
    expect(() => parseSegments('](())')).not.toThrow();
  });
});
