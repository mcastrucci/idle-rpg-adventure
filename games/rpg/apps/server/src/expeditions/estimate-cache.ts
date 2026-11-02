/**
 * In-process estimate cache: a bounded LRU of finished results plus single-flight de-duplication of in-progress
 * computations. Entries never expire by time: the key covers every input of the deterministic estimate (see
 * `estimate-key.ts`), so a hit is always the exact value a recomputation would produce. Per-process by design (see the
 * server README, Estimates): results are cheap to recompute and need no cross-process consistency.
 */
export class EstimateBusyError extends Error {
  constructor() { super('estimate_busy'); this.name = 'EstimateBusyError'; }
}

export class EstimateCache<V> {
  readonly #maxEntries: number;
  readonly #maxPending: number;
  readonly #entries = new Map<string, V>();
  readonly #pending = new Map<string, Promise<V>>();

  constructor(options: { maxEntries: number; maxPending: number }) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1) throw new RangeError('maxEntries must be a positive integer');
    if (!Number.isSafeInteger(options.maxPending) || options.maxPending < 1) throw new RangeError('maxPending must be a positive integer');
    this.#maxEntries = options.maxEntries;
    this.#maxPending = options.maxPending;
  }

  get size(): number { return this.#entries.size; }
  get pending(): number { return this.#pending.size; }

  /** Cached value (refreshing its recency) or `undefined`. */
  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  /**
   * Returns `{ value, cached }`: a cached value, the in-flight computation of the same key, or a new `compute()`.
   * Throws {@link EstimateBusyError} when `maxPending` distinct computations are already running. Failures are not
   * cached.
   */
  async getOrCompute(key: string, compute: () => Promise<V>): Promise<{ value: V; cached: boolean }> {
    const hit = this.get(key);
    if (hit !== undefined) return { value: hit, cached: true };
    let pending = this.#pending.get(key);
    if (!pending) {
      if (this.#pending.size >= this.#maxPending) throw new EstimateBusyError();
      pending = compute().then(value => { this.#set(key, value); return value; })
        .finally(() => { this.#pending.delete(key); });
      this.#pending.set(key, pending);
    }
    return { value: await pending, cached: false };
  }

  #set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
  }
}
