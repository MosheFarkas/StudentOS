import { strToU8, zipSync } from 'fflate';
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

/*
 * OCR is mocked so these tests cover the Drive reader's routing -- which
 * files get sent for recognition -- rather than Tesseract. The engine itself
 * is covered in ocr.test.ts and verified against the real binary on the
 * droplet.
 */
const transcribeMediaMock = vi.hoisted(() => vi.fn());
vi.mock('../transcribe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../transcribe.js')>()),
  transcribeMedia: transcribeMediaMock,
}));

const ocrImageMock = vi.hoisted(() => vi.fn());
const ocrPdfMock = vi.hoisted(() => vi.fn());
vi.mock('../ocr.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ocr.js')>()),
  ocrImage: ocrImageMock,
  ocrPdf: ocrPdfMock,
}));

/** Mirrors the real one-page shape unpdf returns, so per-page detection works. */
const pdfText = (text: string, totalPages = 1) => ({ text, totalPages });

/** Google's 404 body shape, verbatim from Drive v3. */
const NOT_FOUND = {
  error: { code: 404, message: 'File not found: abc.', errors: [{ reason: 'notFound' }] },
};

let responses: Array<{
  match: RegExp;
  status?: number;
  json?: unknown;
  body?: string;
  bytes?: Uint8Array;
}>;

function ctx(
  token: string | null = 'token',
  broadAccess = false,
  withTranscriber = false,
): ToolContext {
  return {
    google: {
      getAccessToken: async () => token,
      hasScope: (scope: string) => broadAccess && scope.endsWith('drive.readonly'),
    },
    ...(withTranscriber ? { transcriber: { transcribe: async () => '' } } : {}),
  } as unknown as ToolContext;
}

beforeEach(() => {
  responses = [];
  extractTextMock.mockReset();
  ocrImageMock.mockReset();
  ocrPdfMock.mockReset();
  transcribeMediaMock.mockReset();

  vi.stubGlobal('fetch', async (url: string) => {
    const stub = responses.find((r) => r.match.test(url));
    if (!stub) throw new Error(`Unexpected request: ${url}`);

    const status = stub.status ?? 200;
    if (stub.bytes) {
      // Copied into a fresh ArrayBuffer: Response wants a plain buffer source.
      return new Response(stub.bytes.slice().buffer as ArrayBuffer, { status });
    }
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

    expect(reason).toContain('have not given me access');
    expect(reason).toContain('Add files');
    // Also names the way to stop doing this, not just the way to do it again.
    expect(reason).toContain('all my Drive');
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
    responses = [meta('application/pdf', { size: String(900 * 1024 * 1024) })];

    // No stub for the media URL: if it tried to download, fetch would throw.
    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { reason: string }).reason).toContain('too large');
  });

  it('extracts a PDF', async () => {
    responses = [meta('application/pdf'), { match: /alt=media/, body: '%PDF' }];
    extractTextMock.mockResolvedValue(pdfText('Solve for x. Show your work.'));

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toContain('Solve for x');
  });

  /**
   * Scanned worksheets are extremely common in schools and extract to
   * whitespace. Rather than dead-ending, they now go to OCR -- which is the
   * whole reason a student can ask about a photographed handout at all.
   */
  it('reads a zip whatever Windows called its type', async () => {
    /*
     * Drive reports zips uploaded from Windows as
     * application/x-zip-compressed, which is the same format under a second
     * name. Matching one spelling meant a real archive came back as "I cannot
     * read this yet".
     */
    responses = [
      meta('application/x-zip-compressed'),
      {
        match: /alt=media/,
        bytes: zipSync({ 'notes.txt': strToU8('The Patriots Rebellion of 1837.') }),
      },
    ];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toContain('Patriots Rebellion');
  });

  it('lists what is in a folder instead of refusing it', async () => {
    /*
     * A teacher sharing a whole folder is ordinary, and the vault held two of
     * them as notes that said only "this is a folder". One had 22 photographs
     * of a robotics build in it. Naming the contents is not the same as
     * reading them, and it is the difference between a dead end and a place
     * to go next.
     */
    responses = [
      meta('application/vnd.google-apps.folder', { name: '2026 MODUEL' }),
      {
        match: /files\?q=/,
        json: {
          files: [
            { id: 'k1', name: '20260121_173636.jpg', mimeType: 'image/jpeg' },
            { id: 'k2', name: 'Field drawings.pdf', mimeType: 'application/pdf' },
          ],
        },
      },
    ];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    const content = (result as { content: string }).content;
    expect(content).toContain('20260121_173636.jpg');
    expect(content).toContain('Field drawings.pdf');
    // The ids travel too, so the agent can go and read one.
    expect(content).toContain('k2');
  });

  it('says a folder is empty rather than pretending it is unreadable', async () => {
    responses = [
      meta('application/vnd.google-apps.folder', { name: 'Empty' }),
      { match: /files\?q=/, json: { files: [] } },
    ];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect(String((result as { reason?: string }).reason)).toMatch(/nothing in it|empty/i);
  });

  it('reads a locked document off its own thumbnail', async () => {
    /*
     * Some owners set "disable download, print and copy". Drive then answers
     * every export with a 403 -- text and PDF alike -- while still handing out
     * a thumbnail: on a real account one such document exported 403 and its
     * thumbnail came back 200 and 143KB. The picture is a picture of the page,
     * so OCR reads it.
     *
     * It is the first page only, and that is worth having: a title and an
     * opening paragraph beat a note that says nothing at all.
     */
    responses = [
      meta('application/vnd.google-apps.document', {
        thumbnailLink: 'https://lh3.googleusercontent.com/abc=s220',
      }),
      {
        match: /export\?mimeType/,
        status: 403,
        json: { error: { message: 'cannot be exported' } },
      },
      { match: /googleusercontent/, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    ];
    ocrImageMock.mockResolvedValue({ ok: true, text: 'Charity Financials - Notes' });

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toContain('Charity Financials');
  });

  it('asks for a thumbnail big enough to read', async () => {
    // Drive offers a 220-pixel-wide preview by default, which OCR cannot do
    // anything with. The link takes a size, so it is asked for one.
    let asked = '';
    responses = [
      meta('application/vnd.google-apps.document', {
        thumbnailLink: 'https://lh3.googleusercontent.com/abc=s220',
      }),
      {
        match: /export\?mimeType/,
        status: 403,
        json: { error: { message: 'cannot be exported' } },
      },
      { match: /googleusercontent/, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    ];
    ocrImageMock.mockImplementation(async () => ({ ok: true, text: 'read' }));
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.includes('googleusercontent')) asked = url;
      return realFetch(url as never, init as never);
    });

    await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect(asked).toMatch(/=s\d{4,}/);
  });

  it('says the document is locked when there is no thumbnail either', async () => {
    responses = [
      meta('application/vnd.google-apps.document'),
      {
        match: /export\?mimeType/,
        status: 403,
        json: { error: { message: 'cannot be exported' } },
      },
    ];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect(String((result as { reason?: string }).reason)).toMatch(/export/i);
  });

  it('reads a huge Google Slides deck, whose stored size says nothing', async () => {
    /*
     * A Google file is exported, not downloaded, and the size Drive reports is
     * what the deck occupies in Drive -- not what its text weighs. Two history
     * revision decks on a real account were 31MB and 67MB of images and were
     * refused as "too large to read", when exporting them as text would have
     * produced a few kilobytes. The cap was being applied to a number that had
     * nothing to do with the thing being fetched.
     */
    responses = [
      meta('application/vnd.google-apps.presentation', { size: String(67 * 1024 * 1024) }),
      { match: /export\?mimeType/, body: 'Chapter 2: Nationalisms and Canadian Autonomy.' },
    ];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toContain('Nationalisms');
  });

  it('still refuses a download that genuinely would not fit in memory', async () => {
    // The cap earns its place for real bytes: this one is downloaded whole.
    responses = [meta('application/pdf', { size: String(900 * 1024 * 1024) })];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect(String((result as { reason?: string }).reason)).toMatch(/too large/i);
  });

  it('reads a PDF that the old thirty-megabyte ceiling would have refused', async () => {
    // That ceiling was low enough to turn away ordinary course readers, and
    // the biggest files are often the ones worth reading.
    responses = [
      meta('application/pdf', { size: String(80 * 1024 * 1024) }),
      { match: /alt=media/, bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
    ];
    // One page's worth of text on one page. Claiming forty pages here would
    // correctly read as a scan and route to OCR, testing the wrong path.
    extractTextMock.mockResolvedValue(pdfText('Chapter 1. The Patriots Rebellion.'));

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toContain('Patriots');
  });

  it('sends a scan with no text layer to OCR', async () => {
    responses = [meta('application/pdf'), { match: /alt=media/, body: '%PDF' }];
    extractTextMock.mockResolvedValue(pdfText('  \n \n ', 12));
    ocrPdfMock.mockResolvedValue({ ok: true, text: 'Question 1. Define inertia.' });

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect(ocrPdfMock).toHaveBeenCalledOnce();
    expect((result as { content: string }).content).toContain('Define inertia');
  });

  it('still reaches OCR when the PDF parser consumes the bytes', async () => {
    /*
     * pdf.js takes ownership of the buffer it is handed and detaches it. Both
     * reads were views over the same one, so the OCR fallback constructed from
     * a dead buffer and threw "Cannot perform Construct on a detached
     * ArrayBuffer" -- and only ever on scans, the exact files OCR exists for.
     *
     * Found in production: 196 of 512 files failed a read, and this was among
     * the reasons. The mock detaches for real, because a mock that politely
     * leaves the buffer alone is what let this ship.
     */
    responses = [meta('application/pdf'), { match: /alt=media/, body: '%PDF' }];
    extractTextMock.mockImplementation(async (bytes: Uint8Array) => {
      // What pdf.js does: takes the buffer with it. Cast because the lib
      // target predates ArrayBuffer.transfer, which Node 22 has.
      (bytes.buffer as ArrayBuffer & { transfer(): ArrayBuffer }).transfer();
      return pdfText('   ', 3);
    });
    ocrPdfMock.mockResolvedValue({ ok: true, text: 'Question 1. Define inertia.' });

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect(ocrPdfMock).toHaveBeenCalledOnce();
    expect((result as { content: string }).content).toContain('Define inertia');
  });

  it('explains itself when OCR cannot read a scan either', async () => {
    responses = [meta('application/pdf'), { match: /alt=media/, body: '%PDF' }];
    extractTextMock.mockResolvedValue(pdfText('  ', 3));
    ocrPdfMock.mockResolvedValue({ ok: false, reason: 'no-text' });

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { reason: string }).reason).toContain('Exam Review');
  });

  it('reports an unreadable PDF instead of throwing', async () => {
    responses = [meta('application/pdf'), { match: /alt=media/, body: 'not a pdf' }];
    extractTextMock.mockRejectedValue(new Error('InvalidPDFException'));

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { reason: string }).reason).toContain('password protected');
  });

  it('joins multi-page extraction output', async () => {
    responses = [meta('application/pdf'), { match: /alt=media/, body: '%PDF' }];
    extractTextMock.mockResolvedValue(
      pdfText(['Question 1. Define inertia.', 'Question 2. Define momentum.'] as never, 2),
    );

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
    extractTextMock.mockResolvedValue(pdfText('Exam Friday, room 204.'));

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toBe('Exam Friday, room 204.');
  });

  /** Images were a quarter of all attachments and previously unreadable. */
  it('reads text off an image', async () => {
    responses = [meta('image/jpeg'), { match: /alt=media/, body: 'JPEGDATA' }];
    ocrImageMock.mockResolvedValue({ ok: true, text: 'Devoir a remettre vendredi' });

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toBe('Devoir a remettre vendredi');
  });

  it('says so when an image contains no words', async () => {
    responses = [meta('image/png'), { match: /alt=media/, body: 'PNGDATA' }];
    ocrImageMock.mockResolvedValue({ ok: false, reason: 'no-text' });

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { reason: string }).reason).toContain('readable text');
  });

  /** Videos are transcribed now, so the tool needs a transcriber to use. */
  it('transcribes a video', async () => {
    responses = [meta('video/mp4')];
    transcribeMediaMock.mockResolvedValue({
      ok: true,
      text: 'Welcome to grade 11 biology.',
      minutes: 9,
    });

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx('token', false, true));
    const content = (result as { content: string }).content;
    expect(content).toContain('Welcome to grade 11 biology');
    expect(content).toContain('9 minutes');
  });

  /*
   * Transcription is optional configuration, not a property of the file. A
   * student whose deployment lacks it should hear that, not that their video
   * is broken.
   */
  it('says transcription is unconfigured rather than blaming the file', async () => {
    responses = [meta('video/mp4')];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { reason: string }).reason).toContain('not configured');
  });

  /** Video streams to disk, so the in-memory size cap must not apply to it. */
  it('does not reject a large video on the in-memory cap', async () => {
    responses = [meta('video/mp4', { size: String(280 * 1024 * 1024) })];
    transcribeMediaMock.mockResolvedValue({
      ok: true,
      text: 'A long lecture recording.',
      minutes: 45,
    });

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx('token', false, true));
    expect((result as { content?: string }).content).toContain('long lecture');
  });

  it('names the format it cannot read yet', async () => {
    // Word and PowerPoint are read now; this is for what genuinely is not.
    responses = [meta('application/x-iso9660-image')];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('Exam Review');
    expect(reason).toContain('Google Docs');
  });

  it('reads a Word document', async () => {
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const body =
      '<w:document><w:body><w:p><w:t>Quiet </w:t><w:t>Revolution</w:t></w:p></w:body></w:document>';
    responses = [
      meta(DOCX),
      { match: /alt=media/, bytes: zipSync({ 'word/document.xml': strToU8(body) }) },
    ];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toContain('Quiet Revolution');
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
        match: /files\?q=trashed/,
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
        match: /files\?q=trashed/,
        json: { files: [{ id: 'dir', name: 'Math 10', mimeType: FOLDER }] },
      },
      {
        match: /in%20parents/,
        status: 403,
        json: { error: { message: 'Insufficient permission' } },
      },
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
        match: /files\?q=trashed/,
        json: { files: [{ id: 'dir', name: 'Loop', mimeType: FOLDER }] },
      },
      // Drive should never return this, but a cycle here would hang Settings.
      { match: /in%20parents/, json: { files: [{ id: 'dir', name: 'Loop', mimeType: FOLDER }] } },
    ];

    const result = (await listDriveFiles.execute({}, ctx())) as { count: number };
    expect(result.count).toBe(1);
  });

  it('opens a folder rather than turning the agent away from it', async () => {
    /*
     * This used to refuse and point at google_drive_list_files, which was a
     * dead end wherever the folder arrived as a Classroom attachment -- there
     * was nothing to search for. Listing it in place is strictly better, and
     * the ids come with it so the agent can read any of them.
     */
    responses = [
      meta(FOLDER, { name: 'Unit 3' }),
      {
        match: /files\?q=/,
        json: { files: [{ id: 'k1', name: 'Reading.pdf', mimeType: 'application/pdf' }] },
      },
    ];

    const result = await readDriveFile.execute({ fileId: 'f1' }, ctx());
    expect((result as { content: string }).content).toContain('Reading.pdf');
  });
});

describe('listDriveFiles', () => {
  it('labels file kinds readably', async () => {
    responses = [
      {
        match: /drive\/v3\/files\?q=/,
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
    responses = [{ match: /drive\/v3\/files\?q=/, json: { files: [] } }];

    const result = (await listDriveFiles.execute({}, ctx())) as { count: number; note: string };
    expect(result.count).toBe(0);
    expect(result.note).toContain('Settings');
    expect(result.note).toContain('all my Drive');
  });
});
