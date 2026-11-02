export interface BackoffOptions {
  readonly baseMs?: number;
  readonly maxMs?: number;
  /** Uniform [0, 1). Injected so tests are exact; production uses Math.random (client-side, not game math). */
  readonly random?: () => number;
}

/**
 * Exponential backoff with "equal jitter": half the capped delay is fixed, half is random, so retries from many
 * clients spread out without ever retrying immediately. `attempt` starts at 1.
 */
export function exponentialBackoff({ baseMs = 500, maxMs = 15_000, random = Math.random }: BackoffOptions = {}) {
  return (attempt: number): number => {
    const capped = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
    const half = capped / 2;
    return Math.round(half + random() * half);
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
