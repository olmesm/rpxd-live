/**
 * Per-instance FIFO queue. Mutations serialize through one of these —
 * patchState flushes, broadcast handlers, the `params` reducer — so
 * last-write-wins falls out of strict ordering (§1).
 *
 * Handlers themselves never hold the queue: each flush is its own
 * {@link SerialQueue.run} call, so other work interleaves freely while a
 * handler awaits (§3).
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #size = 0;

  /** Number of tasks queued or running. */
  get size(): number {
    return this.#size;
  }

  /**
   * Enqueue `task` behind everything already queued. The returned promise
   * settles with the task's result; a rejection does not poison the queue.
   */
  run<T>(task: () => Promise<T> | T): Promise<T> {
    this.#size += 1;
    const result = this.#tail.then(task);
    this.#tail = result.then(
      () => {
        this.#size -= 1;
      },
      () => {
        this.#size -= 1;
      },
    );
    return result;
  }

  /** Resolves once everything currently queued has settled. */
  async idle(): Promise<void> {
    while (this.#size > 0) {
      await this.#tail;
    }
  }
}
