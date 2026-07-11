/**
 * Optional backlog-warning config for {@link SerialQueue} — pure observability,
 * never rejects or drops work. `warnAt` is a depth threshold; `onWarn` fires
 * once per backlog "episode" (depth crosses `warnAt` from below, and stays
 * armed until depth drains back under `warnAt`, at which point it re-arms for
 * the next episode) rather than once per queued item.
 */
export interface SerialQueueOptions {
  /** Depth at/above which the queue is considered backlogged. */
  warnAt?: number;
  /** Called once when {@link size} first reaches `warnAt`, until it re-arms. */
  onWarn?: () => void;
}

/**
 * Per-instance FIFO queue. Mutations serialize through one of these —
 * patchState flushes, broadcast handlers, the `params` reducer — so
 * last-write-wins falls out of strict ordering (§1).
 *
 * Handlers themselves never hold the queue: each flush is its own
 * {@link SerialQueue.run} call, so other work interleaves freely while a
 * handler awaits (§3).
 *
 * @example
 * ```ts
 * const queue = new SerialQueue();
 * await queue.run(async () => commit());  // strictly after anything queued before
 * await queue.idle();                     // drained
 * ```
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #size = 0;
  readonly #warnAt: number | undefined;
  readonly #onWarn: (() => void) | undefined;
  /** Whether the current backlog episode has already warned (re-arms below `warnAt`). */
  #warned = false;

  constructor(opts?: SerialQueueOptions) {
    this.#warnAt = opts?.warnAt;
    this.#onWarn = opts?.onWarn;
  }

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
    if (this.#warnAt !== undefined && this.#size >= this.#warnAt && !this.#warned) {
      this.#warned = true;
      this.#onWarn?.();
    }
    const result = this.#tail.then(task);
    this.#tail = result.then(
      () => {
        this.#decrement();
      },
      () => {
        this.#decrement();
      },
    );
    return result;
  }

  /** Drop size by one and re-arm the backlog warning once depth clears `warnAt`. */
  #decrement(): void {
    this.#size -= 1;
    if (this.#warnAt !== undefined && this.#size < this.#warnAt) this.#warned = false;
  }

  /** Resolves once everything currently queued has settled. */
  async idle(): Promise<void> {
    while (this.#size > 0) {
      await this.#tail;
    }
  }
}
