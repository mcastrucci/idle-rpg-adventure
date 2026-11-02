import type { Clock } from '../clock.ts';
import { AuthError } from './errors.ts';

/** Per-process bounded limiter. A full bucket map rejects new keys rather than evicting limits under attack. */
export class AuthRateLimiter {
  readonly #clock: Clock;
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maximumKeys: number;
  readonly #buckets = new Map<string, { count: number; until: number }>();
  constructor(clock: Clock, limit = 30, windowMs = 60000, maximumKeys = 10000) {
    if (![limit, windowMs, maximumKeys].every((value) => Number.isSafeInteger(value) && value > 0)) throw new RangeError('invalid rate limit');
    this.#clock = clock; this.#limit = limit; this.#windowMs = windowMs; this.#maximumKeys = maximumKeys;
  }
  consume(key: string): void {
    const now = this.#clock.nowMs();
    for (const [existing, bucket] of this.#buckets) if (bucket.until <= now) this.#buckets.delete(existing);
    const bucket = this.#buckets.get(key);
    if (bucket) {
      if (bucket.count >= this.#limit) throw new AuthError('rate_limited', 429);
      bucket.count++;
    } else {
      if (this.#buckets.size >= this.#maximumKeys) throw new AuthError('rate_limited', 429);
      this.#buckets.set(key, { count: 1, until: now + this.#windowMs });
    }
  }
}
