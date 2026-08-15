import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * spawn is mocked because the failure modes worth testing are the ones that
 * are hard to provoke with a real binary -- a missing tesseract, a non-zero
 * exit, a hang. The happy path is verified against the real binary on the
 * droplet; mocking it here would only assert that the mock returns what it
 * was told to.
 */
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { ocrImage, describeOcrFailure } = await import('./ocr.js');

/** A fake child process that can be driven from the test. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
});

/** Yield until the queued work has actually spawned its child. */
async function untilSpawned(count: number) {
  for (let i = 0; i < 50 && spawnMock.mock.calls.length < count; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('ocrImage', () => {
  it('returns the recognised text', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const pending = ocrImage(new Uint8Array([1, 2, 3]));
    await untilSpawned(1);
    child.stdout.write('Chapter 4 Societal Choices\n');
    child.emit('close', 0);

    await expect(pending).resolves.toEqual({ ok: true, text: 'Chapter 4 Societal Choices' });
  });

  it('asks for both languages, since materials are bilingual', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const pending = ocrImage(new Uint8Array());
    await untilSpawned(1);
    child.stdout.write('ok');
    child.emit('close', 0);
    await pending;

    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['stdin', 'stdout', '-l', 'eng+fra']);
  });

  /**
   * Normal on a development machine, and it must not read as a broken file.
   * The student-facing text says the server is missing a capability, not that
   * their worksheet is unreadable.
   */
  it('distinguishes a missing binary from a failed read', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const pending = ocrImage(new Uint8Array());
    await untilSpawned(1);
    child.emit('error', Object.assign(new Error('spawn tesseract ENOENT'), { code: 'ENOENT' }));

    await expect(pending).resolves.toEqual({ ok: false, reason: 'not-installed' });
    expect(describeOcrFailure('not-installed', 'notes.jpg')).toContain('not set up');
  });

  it('treats a non-zero exit as a failed read', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const pending = ocrImage(new Uint8Array());
    await untilSpawned(1);
    child.emit('close', 1);

    await expect(pending).resolves.toEqual({ ok: false, reason: 'failed' });
  });

  /** A photo of a landscape is not an error; it just has no words in it. */
  it('reports an image with no words separately', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const pending = ocrImage(new Uint8Array());
    await untilSpawned(1);
    child.stdout.write('  \n ');
    child.emit('close', 0);

    await expect(pending).resolves.toEqual({ ok: false, reason: 'no-text' });
    expect(describeOcrFailure('no-text', 'photo.jpg')).toContain(
      'could not find any readable text',
    );
  });

  /**
   * Serialisation is what keeps the subprocess inside the service's 512MB
   * cgroup. Two images running at once would double peak memory on a box
   * that is already shared with other projects.
   */
  it('runs one image at a time', async () => {
    const first = fakeChild();
    const second = fakeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const a = ocrImage(new Uint8Array());
    const b = ocrImage(new Uint8Array());

    // The second must not have spawned while the first is still running.
    await untilSpawned(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    first.stdout.write('first page');
    first.emit('close', 0);
    await a;

    await untilSpawned(2);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    second.stdout.write('second page');
    second.emit('close', 0);
    await expect(b).resolves.toEqual({ ok: true, text: 'second page' });
  });

  /** A failure must not wedge the queue for every later request. */
  it('keeps running after one image fails', async () => {
    const failing = fakeChild();
    const working = fakeChild();
    spawnMock.mockReturnValueOnce(failing).mockReturnValueOnce(working);

    const a = ocrImage(new Uint8Array());
    await untilSpawned(1);
    failing.emit('error', new Error('boom'));
    await a;

    const b = ocrImage(new Uint8Array());
    await untilSpawned(2);
    working.stdout.write('still working');
    working.emit('close', 0);

    await expect(b).resolves.toEqual({ ok: true, text: 'still working' });
  });
});
