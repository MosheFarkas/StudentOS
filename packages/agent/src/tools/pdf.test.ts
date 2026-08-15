import { describe, expect, it, vi } from 'vitest';

const extractTextMock = vi.hoisted(() => vi.fn());
vi.mock('unpdf', () => ({ extractText: extractTextMock }));

const { extractPdfText } = await import('./pdf.js');

describe('extractPdfText', () => {
  /**
   * The false positive this rule was rewritten to fix.
   *
   * A flat 20-character floor called a real one-page PDF containing
   * "Dummy PDF file" a scan -- confirmed against the live W3C test file.
   * Length alone cannot separate a scan from a genuinely short document.
   */
  it('accepts a short but real one-page document', async () => {
    extractTextMock.mockResolvedValue({ text: 'Dummy PDF file', totalPages: 1 });

    const result = await extractPdfText(new Uint8Array());
    expect(result).toEqual({ ok: true, text: 'Dummy PDF file', pages: 1 });
  });

  /** A scan yields roughly nothing however many pages it runs to. */
  it('detects a multi-page scan with no text layer', async () => {
    extractTextMock.mockResolvedValue({ text: '   \n  \n ', totalPages: 20 });

    const result = await extractPdfText(new Uint8Array());
    expect(result).toEqual({ ok: false, reason: 'no-text-layer' });
  });

  /**
   * The case a flat character floor gets exactly backwards: plenty of
   * characters in total, but spread so thin across pages that it is a scan
   * with stray header text rather than a document.
   */
  it('detects a long scan carrying a few stray characters per page', async () => {
    extractTextMock.mockResolvedValue({ text: 'x'.repeat(60), totalPages: 40 });

    const result = await extractPdfText(new Uint8Array());
    expect(result).toEqual({ ok: false, reason: 'no-text-layer' });
  });

  it('reports an encrypted or malformed file separately', async () => {
    extractTextMock.mockRejectedValue(new Error('InvalidPDFException'));

    const result = await extractPdfText(new Uint8Array());
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('survives a missing page count', async () => {
    extractTextMock.mockResolvedValue({ text: 'Read chapter four before Friday.' });

    const result = await extractPdfText(new Uint8Array());
    expect(result.ok).toBe(true);
  });
});
