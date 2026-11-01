/**
 * Spike 1 / ADR-0013 measurements (opt-in, not part of `pnpm check`): precompute time of a 180-minute Region 1 hunt
 * and of a 200-run `estimate`. Run with
 *
 *   RPG_IDLE_BENCH=1 pnpm vitest run --project @rpg/rpg-sim expedition/bench --silent=false
 *
 * Wall-clock timing is test-only (`process.hrtime`); the simulator itself never reads a clock.
 */
import { estimate } from '@engine/expedition-kernel';
import { BP_SCALE } from '@engine/sim-core';
import { describe, expect, it } from 'vitest';

import { sims } from './testing/fixtures.ts';
import { HUNT, bulwark, idleConfig, thornblade } from './testing/region1.ts';

const RUNS = 60;
const ms = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;
const pct = (sorted: readonly number[], p: number): number => sorted[Math.max(0, Math.ceil((p * sorted.length) / 100) - 1)] ?? 0;

describe.runIf(process.env['RPG_IDLE_BENCH'] === '1')('idle precompute measurements', () => {
  const { hunt } = sims();
  const config = idleConfig(HUNT, 5);
  const budget = hunt.budget(config, 180, BP_SCALE);

  it('180-min Region 1 hunt: p50/p95 precompute and a 200-run estimate', () => {
    expect(budget).toBe(90);
    for (const [label, actor] of [
      ['bulwark L4', bulwark(4)],
      ['thornblade L4', thornblade(4)],
    ] as const) {
      // Warm-up (JIT), not measured.
      for (let s = 0; s < 5; s++) hunt.simulate({ config, actors: [actor], seed: 10_000 + s, budget });
      const times: number[] = [];
      let segments = 0;
      for (let seed = 1; seed <= RUNS; seed++) {
        const t0 = process.hrtime.bigint();
        const t = hunt.simulate({ config, actors: [actor], seed, budget });
        times.push(ms(t0));
        segments += t.segments.length;
      }
      times.sort((a, b) => a - b);
      const t1 = process.hrtime.bigint();
      const est = estimate(hunt, { config, actors: [actor], budget }, 200, 1);
      const estimateMs = ms(t1);
      console.log(
        JSON.stringify({
          label,
          runs: RUNS,
          meanSegments: segments / RUNS,
          p50Ms: pct(times, 50).toFixed(1),
          p95Ms: pct(times, 95).toFixed(1),
          maxMs: (times.at(-1) ?? 0).toFixed(1),
          estimate200Ms: estimateMs.toFixed(0),
          outcomeRatesBp: est.outcomeRatesBp,
          node: process.version,
        }),
      );
    }
  }, 120_000);
});
