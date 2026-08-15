import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Reading text off images and scanned pages.
 *
 * 159 of one real account's 632 Classroom attachments are images -- a quarter
 * of everything teachers post, and the single largest category the agent could
 * not read. Photographed worksheets and handwritten notes are normal in
 * schools, so treating images as "no text" made the agent blind to a quarter
 * of the coursework.
 *
 * Runs the system `tesseract` binary rather than a WASM build. On the
 * production droplet a page costs about 0.5s and 49MB peak RSS in a separate
 * process; the in-process WASM equivalent would sit inside the API's 512MB
 * cgroup for the lifetime of the service. Language is eng+fra because this
 * school's materials are bilingual and Tesseract handles both in one pass.
 */

/** One page at a time. The subprocess counts against the service's cgroup. */
let queue: Promise<unknown> = Promise.resolve();

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  // Keep the chain alive regardless of outcome, without unhandled rejections.
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const TIMEOUT_MS = 45_000;
/** Bounds a scanned book to something a student will wait for. */
const MAX_PDF_PAGES = 12;
const LANGUAGES = 'eng+fra';

export type OcrResult =
  { ok: true; text: string } | { ok: false; reason: 'not-installed' | 'failed' | 'no-text' };

function runTesseract(input: Buffer): Promise<OcrResult> {
  return new Promise((resolve) => {
    const child = spawn('tesseract', ['stdin', 'stdout', '-l', LANGUAGES], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let settled = false;
    const finish = (result: OcrResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, reason: 'failed' });
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    // Drained and ignored: tesseract writes progress here, and leaving the
    // pipe unread can block the child on a full buffer.
    child.stderr.on('data', () => {});

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ENOENT means no tesseract on this machine -- normal in development,
      // and worth saying plainly rather than reporting as a failed read.
      finish({ ok: false, reason: error.code === 'ENOENT' ? 'not-installed' : 'failed' });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish({ ok: false, reason: 'failed' });
      const text = out.trim();
      finish(text.length < 3 ? { ok: false, reason: 'no-text' } : { ok: true, text });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Read text off a single image. */
export function ocrImage(bytes: Uint8Array): Promise<OcrResult> {
  return serialise(() => runTesseract(Buffer.from(bytes)));
}

/**
 * Read text off a PDF that has no text layer.
 *
 * Rasterises with pdftoppm first, because Tesseract cannot open a PDF. Capped
 * at the first few pages: a scanned textbook would otherwise take minutes,
 * and the answer to "what does this worksheet say" is on page one.
 */
export function ocrPdf(bytes: Uint8Array): Promise<OcrResult & { pagesRead?: number }> {
  return serialise(async () => {
    let workspace: string | undefined;
    try {
      workspace = await mkdtemp(join(tmpdir(), 'contexto-ocr-'));
      const source = join(workspace, 'in.pdf');
      await writeFile(source, bytes);

      const rasterised = await new Promise<boolean>((resolve) => {
        const child = spawn(
          'pdftoppm',
          [
            '-png',
            '-r',
            '150',
            '-f',
            '1',
            '-l',
            String(MAX_PDF_PAGES),
            source,
            join(workspace as string, 'page'),
          ],
          { stdio: 'ignore' },
        );
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve(false);
        }, TIMEOUT_MS);
        child.on('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
      });
      if (!rasterised) return { ok: false, reason: 'failed' as const };

      const pages = (await readdir(workspace)).filter((name) => name.endsWith('.png')).sort();
      if (pages.length === 0) return { ok: false, reason: 'failed' as const };

      const chunks: string[] = [];
      for (const page of pages) {
        const result = await runTesseract(await readFile(join(workspace, page)));
        // A blank page inside a scan is normal; skip it rather than failing.
        if (result.ok) chunks.push(result.text);
      }

      const text = chunks.join('\n\n').trim();
      if (text.length < 3) return { ok: false, reason: 'no-text' as const };
      return { ok: true as const, text, pagesRead: pages.length };
    } catch {
      return { ok: false, reason: 'failed' as const };
    } finally {
      if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/** Student-facing explanation for each failure. */
export function describeOcrFailure(
  reason: 'not-installed' | 'failed' | 'no-text',
  name: string,
): string {
  switch (reason) {
    case 'not-installed':
      return `I cannot read text out of "${name}" -- image reading is not set up on this server.`;
    case 'no-text':
      return `I looked at "${name}" but could not find any readable text in it.`;
    default:
      return `I could not read the text in "${name}".`;
  }
}
