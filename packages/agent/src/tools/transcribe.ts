import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Turning a video or audio file into text.
 *
 * Two constraints shape all of this, both measured rather than assumed:
 *
 *   Memory. The largest video in one real account is 279MB, and the API runs
 *   in a 512MB cgroup shared with other projects. Video is therefore streamed
 *   straight to disk and never held in memory -- the rest of the file readers
 *   buffer, and doing that here would OOM the service.
 *
 *   Size on the wire. The transcription endpoint takes at most 25MB, but
 *   video is mostly picture. Stripping to mono 16kHz Opus took a 16MB video
 *   to 1.6MB of audio for 9.5 minutes of speech, so even the longest of these
 *   lands far inside the limit.
 */

/** Above this we refuse rather than spend minutes on a download. */
const MAX_VIDEO_BYTES = 600 * 1024 * 1024;
/** The transcription endpoint's own ceiling. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

const FFMPEG_TIMEOUT_MS = 300_000;

export type TranscriptionResult =
  | { ok: true; text: string; minutes: number }
  | { ok: false; reason: 'not-installed' | 'too-large' | 'failed' | 'no-speech' };

/**
 * Supplies the transcription itself.
 *
 * The same seam as GoogleTokenProvider: this package knows how to get audio
 * out of a video, and nothing about which vendor turns it into words or where
 * that key lives.
 */
export interface AudioTranscriber {
  transcribe(audio: Uint8Array, filename: string): Promise<string>;
}

/** Streams a URL to disk, refusing anything oversized as it arrives. */
async function downloadToFile(
  url: string,
  token: string,
  destination: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status})`);
  }

  /*
   * Checked while writing, not from Content-Length. A server that lies about
   * or omits the length would otherwise fill the disk.
   */
  let written = 0;
  const guard = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      written += chunk.byteLength;
      if (written > MAX_VIDEO_BYTES) {
        controller.error(new Error('too-large'));
        return;
      }
      controller.enqueue(chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body.pipeThrough(guard) as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(destination),
  );
  return written;
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    /*
     * -nostdin matters. ffmpeg reads stdin for interactive commands, and
     * without this it consumes whatever the parent process had there --
     * which silently ate the rest of a shell script during development.
     */
    const child = spawn('ffmpeg', ['-nostdin', ...args], { stdio: 'ignore' });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, FFMPEG_TIMEOUT_MS);

    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function ffmpegInstalled(): Promise<boolean> {
  return runFfmpeg(['-version']);
}

/**
 * Download a video or audio file, strip it to speech, and transcribe it.
 *
 * Takes a URL rather than bytes precisely so the download can stream.
 */
export async function transcribeMedia(
  url: string,
  token: string,
  transcriber: AudioTranscriber,
  signal?: AbortSignal,
): Promise<TranscriptionResult> {
  if (!(await ffmpegInstalled())) return { ok: false, reason: 'not-installed' };

  let workspace: string | undefined;
  try {
    workspace = await mkdtemp(join(tmpdir(), 'contexto-av-'));
    const source = join(workspace, 'media');
    const audio = join(workspace, 'audio.ogg');

    try {
      await downloadToFile(url, token, source, signal);
    } catch (cause) {
      return {
        ok: false,
        reason: cause instanceof Error && cause.message === 'too-large' ? 'too-large' : 'failed',
      };
    }

    // Mono, 16kHz, 24kbps Opus: speech survives, picture and stereo do not.
    const converted = await runFfmpeg([
      '-y',
      '-loglevel',
      'error',
      '-i',
      source,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libopus',
      '-b:a',
      '24k',
      audio,
    ]);
    if (!converted) return { ok: false, reason: 'failed' };

    const { size } = await stat(audio);
    if (size > MAX_AUDIO_BYTES) return { ok: false, reason: 'too-large' };

    const bytes = await readFile(audio);
    const text = (await transcriber.transcribe(new Uint8Array(bytes), 'audio.ogg')).trim();
    if (text.length < 10) return { ok: false, reason: 'no-speech' };

    // 24kbps mono, so bytes map to duration closely enough to tell a student
    // how long the recording was without probing the file again.
    const minutes = Math.max(1, Math.round(size / (3 * 1024) / 60));
    return { ok: true, text, minutes };
  } catch {
    return { ok: false, reason: 'failed' };
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

export function describeTranscriptionFailure(
  reason: 'not-installed' | 'too-large' | 'failed' | 'no-speech',
  name: string,
): string {
  switch (reason) {
    case 'not-installed':
      return `I cannot listen to "${name}" -- audio processing is not set up on this server.`;
    case 'too-large':
      return `"${name}" is too long for me to transcribe.`;
    case 'no-speech':
      return `I listened to "${name}" but could not make out any speech in it.`;
    default:
      return `I could not transcribe "${name}".`;
  }
}
