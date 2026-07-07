/** Token bucket for per-session rpc rate limiting (§10). */
export interface RateLimit {
  /** Maximum burst size. */
  capacity: number;
  /** Tokens restored per second. */
  refillPerSec: number;
}

/** Thrown (and surfaced as an rpc error ack) when a bucket is exhausted. */
export class RateLimitError extends Error {
  override name = "RateLimitError";
  constructor(rpc: string) {
    super(`Rate limit exceeded for rpc "${rpc}"`);
  }
}

export class TokenBucket {
  #tokens: number;
  #last: number;

  constructor(
    private readonly limit: RateLimit,
    now = Date.now(),
  ) {
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
