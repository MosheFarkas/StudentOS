import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listDriveFiles, readDriveFile } from './drive.js';
import type { ToolContext } from '../types.js';

/*
 * unpdf is mocked so these tests cover OUR branching -- the scanned-document
 * threshold, the encrypted-file path -- rather than pdf.js's parser. The real
 * PDF round trip is verified against an actual Classroom PDF in production;
 * a hand-built fixture would only prove pdf.js parses what we hand it.
 */
const extractTextMock = vi.hoisted(() => vi.fn());
vi.mock('unpdf', () => ({ extractText: extractTextMock }));

/** Google's 404 body shape, verbatim from Drive v3. */
const NOT_FOUND = {
  error: { code: 404, message: 'File not found: abc.', errors: [{ reason: 'notFound' }] },
};

let responses: Array<{ match: RegExp; status?: number; json?: unknown; body?: string }>;

function ctx(token: string | null = 'token'): ToolContext {
  return { google: { getAccessToken: async () => token } } as unknown as ToolContext;
}

beforeEach(() => {
  responses = [];
  extractTextMock.mockReset();

  vi.stubGlobal('fetch', async (url: string) => {
    const stub = responses.find((r) => r.match.test(url));
    if (!stub) throw new Error(`Unexpected request: ${url}`);

    const status = stub.status ?? 200;
    const body = stub.json !== undefined ? JSON.stringify(stub.json) : (stub.body ?? '');
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  });
});

afterEach(() => vi.unstubAllGlobals());

/** Metadata reply for a file of the given type. */
function meta(mimeType: string, extra: Record<string, unknown> = {}) {
  return {
    match: /drive\/v3\/files\/[^/?]+\?fields=/,
    json: { id: 'f1', name: 'Exam Review', mimeType, ...extra },
  };
}

describe('readDriveFile', () => {
  it('says Drive is not connected rather than failing', async () => {
    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx(null));
    expect(result).toMatchObject({ unavailable: true });
    expect((result as { reason: string }).reason).toContain('not connected');
  });

  /**
   * The load-bearing case for drive.file. A file the student has NOT handed
   * over is indistinguishable from one that does not exist -- Drive answers
   * 404 to both. Reporting "does not exist" for a file the student is looking
   * at in Classroom reads as a broken product and offers no way forward.
   */
  it('reads a 404 as "you have not given me this file"', async () => {
    responses = [{ match: /files\/f1\?fields=/, status: 404, json: NOT_FOUND }];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    const reason = (result as { reason: string }).reason;

    expect(reason).toContain('have not given Contexto access');
    expect(reason).toContain('Add files');
    expect(reason).not.toContain('does not exist');
  });

  it('exports a Google Doc as plain text', async () => {
    responses = [
      meta('application/vnd.google-apps.document'),
      { match: /\/export\?mimeType=text%2Fplain/, body: 'Chapter 4: Quebec' },
    ];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect(result).toMatchObject({
      name: 'Exam Review',
      content: 'Chapter 4: Quebec',
      truncated: false,
    });
  });

  it('exports a Sheet as CSV so structure survives', async () => {
    responses = [
      meta('application/vnd.google-apps.spreadsheet'),
      { match: /\/export\?mimeType=text%2Fcsv/, body: 'week,topic\n1,Intro' },
    ];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toContain('week,topic');
  });

  it('truncates a long file and says so', async () => {
    responses = [
      meta('application/vnd.google-apps.document'),
      { match: /\/export\?/, body: 'x'.repeat(60_000) },
    ];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    const body = result as { truncated: boolean; content: string; note?: string };

    expect(body.truncated).toBe(true);
    expect(body.content.length).toBeLessThan(41_000);
    expect(body.content).toContain('[truncated]');
    expect(body.note).toBeDefined();
  });

  it('refuses an oversized file before downloading it', async () => {
    responses = [meta('application/pdf', { size: String(80 * 1024 * 1024) })];

    // No stub for the media URL: if it tried to download, fetch would throw.
    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { reason: string }).reason).toContain('too large');
  });

  it('extracts a PDF', async () => {
    responses = [meta('application/pdf'), { match: /alt=media/, body: '%PDF' }];
    extractTextMock.mockResolvedValue({ text: 'Solve for x. Show your work.' });

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toContain('Solve for x');
  });

  /**
   * Scanned worksheets are extremely common in schools and extract to
   * whitespace. Reporting an empty document reads as our bug; naming the
   * cause tells the student the file needs OCR, which we do not do.
   */
  it('recognises a scan with no text layer', async () => {
    responses = [meta('application/pdf'), { match: /alt=media/, body: '%PDF' }];
    extractTextMock.mockResolvedValue({ text: '  \n \n ' });

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('scan');
    expect(reason).toContain('Exam Review');
  });

  it('reports an unreadable PDF instead of throwing', async () => {
    responses = [meta('application/pdf'), { match: /alt=media/, body: 'not a pdf' }];
    extractTextMock.mockRejectedValue(new Error('InvalidPDFException'));

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { reason: string }).reason).toContain('password protected');
  });

  it('joins multi-page extraction output', async () => {
    responses = [meta('application/pdf'), { match: /alt=media/, body: '%PDF' }];
    extractTextMock.mockResolvedValue({
      text: ['Question 1. Define inertia.', 'Question 2. Define momentum.'],
    });

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toBe(
      'Question 1. Define inertia.\n\nQuestion 2. Define momentum.',
    );
  });

  /**
   * Pins the scan threshold as a deliberate choice rather than an accident.
   * Anything under it is called a scan, so the cutoff has to sit below any
   * plausible real document -- a PDF whose entire content is one short
   * sentence must still read as a document.
   */
  it('does not mistake a very short real document for a scan', async () => {
    responses = [meta('application/pdf'), { match: /alt=media/, body: '%PDF' }];
    extractTextMock.mockResolvedValue({ text: 'Exam Friday, room 204.' });

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toBe('Exam Friday, room 204.');
  });

  it('explains that an image has no text', async () => {
    responses = [meta('image/jpeg')];
    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { reason: string }).reason).toContain('no text to read');
  });

  it('names the format it cannot read yet', async () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    responses = [meta(docx)];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('Exam Review');
    expect(reason).toContain('Google Docs');
  });

  it('reads a plain text file directly', async () => {
    responses = [meta('text/markdown'), { match: /alt=media/, body: '# Notes' }];
    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toBe('# Notes');
  });
});

const FOLDER = 'application/vnd.google-apps.folder';

describe('picked folders', () => {
  /**
   * The point of allowing folder selection: one pick covers a course. This
   * only works if Drive cascades access under drive.file, which the docs do
   * not promise -- so the two tests below pin BOTH outcomes as acceptable.
   */
  it('lists what is inside a picked folder', async () => {
    responses = [
      {
        match: /files\?pageSize=100/,
        json: { files: [{ id: 'dir', name: 'Math 10', mimeType: FOLDER }] },
      },
      {
        match: /files\?q=/,
        json: {
          files: [
            { id: 'c1', name: 'Review', mimeType: 'application/pdf' },
            { id: 'c2', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
          ],
        },
      },
    ];

    const result = (await listDriveFiles.execute({}, ctx())) as {
      files: { name: string }[];
      count: number;
    };
    expect(result.count).toBe(3);
    expect(result.files.map((f) => f.name)).toContain('Review');
  });

  /**
   * When access does NOT cascade, Drive answers 403/404 for the children.
   * That is not an error the student caused and must not break the listing --
   * they simply see the folder and can still pick files individually.
   */
  it('degrades quietly when Drive will not expand the folder', async () => {
    responses = [
      {
        match: /files\?pageSize=100/,
        json: { files: [{ id: 'dir', name: 'Math 10', mimeType: FOLDER }] },
      },
      { match: /files\?q=/, status: 403, json: { error: { message: 'Insufficient permission' } } },
    ];

    const result = (await listDriveFiles.execute({}, ctx())) as {
      files: { name: string; kind: string }[];
      count: number;
    };
    expect(result.count).toBe(1);
    expect(result.files[0]?.kind).toBe('Folder');
  });

  it('does not loop forever on a folder that contains itself', async () => {
    responses = [
      {
        match: /files\?pageSize=100/,
        json: { files: [{ id: 'dir', name: 'Loop', mimeType: FOLDER }] },
      },
      // Drive should never return this, but a cycle here would hang Settings.
      { match: /files\?q=/, json: { files: [{ id: 'dir', name: 'Loop', mimeType: FOLDER }] } },
    ];

    const result = (await listDriveFiles.execute({}, ctx())) as { count: number };
    expect(result.count).toBe(1);
  });

  it('tells the agent to list a folder rather than read it', async () => {
    responses = [meta(FOLDER)];
    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { reason: string }).reason).toContain('is a folder');
  });
});

describe('listDriveFiles', () => {
  it('labels file kinds readably', async () => {
    responses = [
      {
        match: /drive\/v3\/files\?/,
        json: {
          files: [
            { id: 'a', name: 'Slides', mimeType: 'application/vnd.google-apps.presentation' },
            { id: 'b', name: 'Packet', mimeType: 'application/pdf' },
          ],
        },
      },
    ];

    const result = (await listDriveFiles.execute({}, ctx())) as {
      files: { fileId: string; kind: string }[];
      count: number;
    };

    expect(result.count).toBe(2);
    expect(result.files.map((f) => f.kind)).toEqual(['Google Slides', 'PDF']);
    expect(result.files[0]?.fileId).toBe('a');
  });

  /*
   * Empty is the normal state right after connecting, not an error -- the
   * scope grants nothing until files are picked. The note tells the agent
   * where to send the student instead of it concluding Drive is broken.
   */
  it('tells the agent where to send the student when empty', async () => {
    responses = [{ match: /drive\/v3\/files\?/, json: { files: [] } }];

    const result = (await listDriveFiles.execute({}, ctx())) as { count: number; note: string };
    expect(result.count).toBe(0);
    expect(result.note).toContain('Settings');
  });
});
