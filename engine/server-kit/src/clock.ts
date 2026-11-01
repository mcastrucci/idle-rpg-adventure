/** Wall-clock access is injected into services; deterministic simulators receive timestamps as data. */
export interface Clock {
  nowMs(): number;
}
export class SystemClock implements Clock {
  nowMs(): number { return Date.now(); }
}
export class ManualClock implements Clock {
  #now: number;
  constructor(nowMs = 0) { this.#now = checked(nowMs); }
  nowMs(): number { return this.#now; }
  set(nowMs: number): void { this.#now = checked(nowMs); }
  advance(durationMs: number): void { this.#now = checked(this.#now + checked(durationMs)); }
}
function checked(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('clock milliseconds must be a non-negative safe integer');
  return value;
}
