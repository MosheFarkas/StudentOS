/**
 * One job at a time per student.
 *
 * Everything that writes a vault -- the build button, the six-hourly pass,
 * the live sync -- goes through here, so two of them can never write the
 * same notes at once. In memory, like the build lock: a job is bounded by
 * this process and a restart is exactly when the queue should be empty.
 */
export class StudentQueue {
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #pending = new Map<string, number>();

  run<T>(userId: string, job: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(userId) ?? Promise.resolve();
    this.#pending.set(userId, (this.#pending.get(userId) ?? 0) + 1);

    // Runs after the previous job however that job ended.
    const next = previous.then(job, job);

    // Cleanup function to be attached directly to next.
    // Runs on both success and failure paths, always returns undefined.
    const cleanup = () => {
      const left = (this.#pending.get(userId) ?? 1) - 1;
      if (left <= 0) {
        this.#pending.delete(userId);
        if (this.#tails.get(userId) === settled) this.#tails.delete(userId);
      } else this.#pending.set(userId, left);
      return undefined;
    };

    // Attach cleanup directly to next (before run() returns) on both paths,
    // so it runs before any caller continuation.
    const settled = next.then(cleanup, cleanup);
    this.#tails.set(userId, settled);

    return next;
  }

  /** Whether anything is running or waiting for this student. */
  busy(userId: string): boolean {
    return (this.#pending.get(userId) ?? 0) > 0;
  }
}

export const studentQueue = new StudentQueue();
