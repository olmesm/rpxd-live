/**
 * Per-instance FIFO queue. Rpcs AND broadcast handlers serialize through one
 * of these — last-write-wins falls out of strict ordering (§1).
 *
 * Generator rpcs do NOT hold the queue across `yield`: each segment is its
 * own {@link SerialQueue.run} call, so other work interleaves between
 * segments (§3).
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
