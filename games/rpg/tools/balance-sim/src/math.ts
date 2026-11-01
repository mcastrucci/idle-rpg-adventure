/**
 * Integer aggregate helpers. Rates are basis points (10000 = 100%), means are hundredths (`x100`), percentiles use the
 * nearest-rank method on sorted integers. No floats are produced, so a report is byte-identical across platforms.
 */

/** `⌊num × 10000 / den⌋`, or 0 when `den` is 0. */
export function ratioBp(num: number, den: number): number {
  return den === 0 ? 0 : Math.floor((num * 10_000) / den);
}

/** Mean in hundredths: `⌊sum × 100 / n⌋`, or 0 when `n` is 0. */
export function meanX100(sum: number, n: number): number {
  return n === 0 ? 0 : Math.floor((sum * 100) / n);
}

/** Integer mean `⌊sum / n⌋`, or 0 when `n` is 0. */
export function meanInt(sum: number, n: number): number {
  return n === 0 ? 0 : Math.floor(sum / n);
}

/** Nearest-rank percentile (`p` in 1..100) of an ascending-sorted list; `null` when empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p * sorted.length) / 100);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

export function sortedAsc(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function fixed2(x100: number): string {
  const sign = x100 < 0 ? '-' : '';
  const abs = Math.abs(x100);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** `9750` → `97.50%`. */
export function formatBp(bp: number): string {
  return `${fixed2(bp)}%`;
}

/** `125` → `1.25`. */
export function formatX100(x100: number): string {
  return fixed2(x100);
}

/** Inclusive integer range `a..b`. */
export function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}
