/** Token bucket for per-session rpc rate limiting (§10). */
export interface RateLimit {
  /** Maximum burst size. */
  capacity: number;
  /** Tokens restored per second. */
  refillPerSec: number;
}

/**
 * Thrown (and surfaced as an rpc error ack) when a bucket is exhausted.
 *
 * @example
 * ```ts
 * if (!bucket.take()) throw new RateLimitError("add");
 * ```
 */
export class RateLimitError extends Error {
  override name = "RateLimitError";
  constructor(rpc: string) {
    super(`Rate limit exceeded for rpc "${rpc}"`);
  }
}

/**
 * One token bucket — take() consumes a token, time refills them.
 *
 * Buckets live per rpc *per instance* — with per-session instances (§1)
 * that is effectively per session per route, which satisfies §10's
 * per-session intent at a finer grain.
 *
 * @example
 * ```ts
 * const bucket = new TokenBucket({ capacity: 5, refillPerSec: 1 });
 * bucket.take(); // true until the burst is spent
 * ```
 */
export class TokenBucket {
  #tokens: number;
  #last: number;
  // Plain field (not a parameter property) so the source stays erasable —
  // Node runs it under default, unflagged TypeScript stripping.
  private readonly limit: RateLimit;

  constructor(limit: RateLimit, now = Date.now()) {
    this.limit = limit;
    this.#tokens = limit.capacity;
    this.#last = now;
  }

  /** Take one token; returns false when the bucket is empty. */
  take(now = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.#last) / 1000;
    this.#tokens = Math.min(this.limit.capacity, this.#tokens + elapsed * this.limit.refillPerSec);
    this.#last = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
