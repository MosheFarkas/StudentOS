import { describe, expect, it } from 'vitest';
import { StudentQueue } from './vault-queue.js';

/**
 * One student's vault is written by one job at a time.
 *
 * The button, the six-hourly pass and the live sync all reach the same
 * files. Two of them at once pay twice and interleave writes; the queue is
 * what makes that impossible rather than merely unlikely.
 */

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

describe('StudentQueue', () => {
  it("runs one student's jobs in order, one at a time", async () => {
    const queue = new StudentQueue();
    const order: string[] = [];
    const first = gate();

    const a = queue.run('s1', async () => {
      order.push('a-start');
      await first.opened;
      order.push('a-end');
    });
    const b = queue.run('s1', async () => {
      order.push('b');
    });

    await Promise.resolve();
    expect(order).toEqual(['a-start']);
    expect(queue.busy('s1')).toBe(true);
    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    expect(queue.busy('s1')).toBe(false);
  });

  it('lets different students run at once', async () => {
    const queue = new StudentQueue();
    const first = gate();
    const started: string[] = [];
    const a = queue.run('s1', async () => {
      started.push('s1');
      await first.opened;
    });
    const b = queue.run('s2', async () => {
      started.push('s2');
    });
    await b;
    expect(started).toEqual(['s1', 's2']);
    first.open();
    await a;
  });

  it('runs the next job after a failure', async () => {
    const queue = new StudentQueue();
    await expect(
      queue.run('s1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await queue.run('s1', async () => 'ok')).toBe('ok');
  });

  it('clears busy immediately after a successful job', async () => {
    const queue = new StudentQueue();
    await queue.run('s1', async () => 'ok');
    expect(queue.busy('s1')).toBe(false);
  });

  it('clears busy immediately after a failed job', async () => {
    const queue = new StudentQueue();
    await queue
      .run('s1', async () => {
        throw new Error('boom');
      })
      .catch(() => {});
    expect(queue.busy('s1')).toBe(false);
  });
});
