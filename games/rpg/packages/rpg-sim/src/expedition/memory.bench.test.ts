/**
 * Spike 1 / ADR-0004 memory and GC measurements (opt-in, not part of `pnpm check`): the public `step` (deep-copies the
 * state every tick) versus `runToEnd` (one working state mutated in place) over the same 10,000-tick fight, plus the
 * 90-segment (180 min) Region 1 precompute and a 200-run `estimate`. Run with `--expose-gc` so every case starts after a
 * forced collection (without it the numbers are still printed, but cases are not isolated):
 *
 *   NODE_OPTIONS=--expose-gc RPG_MEMORY_BENCH=1 pnpm exec vitest run --project @rpg/rpg-sim expedition/memory.bench --silent=false
 *
 * Reported per case: wall time, heap used before / after / peak (peak = maximum of samples taken every 100 ticks or at
 * every simulated run, so it is a lower bound of the true peak), allocated bytes (lower bound: sum of positive increments
 * between consecutive samples, which misses what a collection freed in between) and the GC entries seen by a
 * `PerformanceObserver` (`entryTypes: ['gc']`): count and total pause, split by minor (scavenge) and major.
 * Wall-clock and heap readings are test-only; the simulator itself never reads a clock.
 */
import { constants, PerformanceObserver } from 'node:perf_hooks';
import type { PerformanceEntry } from 'node:perf_hooks';

import { estimate } from '@engine/expedition-kernel';
import { BP_SCALE } from '@engine/sim-core';
import { describe, expect, it } from 'vitest';

import { createCombat, runToEnd, step } from '../index.ts';
import type { CombatState } from '../index.ts';
import { stalemateSetup } from '../combat/testing/fixtures.ts';
import { rpgIdleMetrics } from './index.ts';
import { sims } from './testing/fixtures.ts';
import { HUNT, REGION_1, idleConfig, thornblade } from './testing/region1.ts';

const TICKS = 10_000;
const MB = 1024 * 1024;
const gc = (globalThis as { gc?: () => void }).gc;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Row {
  readonly case: string;
  readonly reps: number;
  readonly msPerRep: string;
  readonly heapBeforeMB: string;
  readonly heapAfterMB: string;
  readonly heapPeakMB: string;
  readonly allocatedMB: string;
  readonly allocMBperS: string;
  readonly gcMinor: number;
  readonly gcMajor: number;
  readonly gcPauseMs: string;
}

/** Runs `body(sample)` once per rep after a forced GC; `sample()` records a heap reading. */
async function measure(label: string, reps: number, body: (sample: () => void) => void): Promise<Row> {
  gc?.();
  await tick();
  const entries: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
  observer.observe({ entryTypes: ['gc'] });
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  let last = before;
  let allocated = 0;
  const sample = (): void => {
    const used = process.memoryUsage().heapUsed;
    if (used > last) allocated += used - last;
    if (used > peak) peak = used;
    last = used;
  };
  const t0 = process.hrtime.bigint();
  for (let r = 0; r < reps; r++) body(sample);
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  sample();
  const after = process.memoryUsage().heapUsed;
  await tick();
  entries.push(...observer.takeRecords());
  observer.disconnect();
  const kind = (e: PerformanceEntry): number => (e as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind ?? 0;
  const minor = entries.filter((e) => kind(e) === constants.NODE_PERFORMANCE_GC_MINOR);
  const major = entries.filter((e) => kind(e) !== constants.NODE_PERFORMANCE_GC_MINOR);
  const pause = entries.reduce((sum, e) => sum + e.duration, 0);
  return {
    case: label,
    reps,
    msPerRep: (wallMs / reps).toFixed(1),
    heapBeforeMB: (before / MB).toFixed(1),
    heapAfterMB: (after / MB).toFixed(1),
    heapPeakMB: (peak / MB).toFixed(1),
    allocatedMB: (allocated / MB).toFixed(0),
    allocMBperS: ((allocated / MB) / (wallMs / 1000)).toFixed(0),
    gcMinor: minor.length,
    gcMajor: major.length,
    gcPauseMs: pause.toFixed(1),
  };
}

describe.runIf(process.env['RPG_MEMORY_BENCH'] === '1')('memory and GC measurements', () => {
  it('step vs runToEnd (10,000 ticks), 90-segment precompute, 200-run estimate', async () => {
    const { hunt } = sims();
    const config = idleConfig(5);
    const target = { areaId: REGION_1, activityId: HUNT } as const;
    const budget = hunt.budget(config, 180, BP_SCALE, target);
    expect(budget).toBe(90);
    const actor = thornblade(4);

    // Warm-up (JIT), not measured.
    runToEnd(stalemateSetup(), 1, undefined, 1_000);
    for (let s = 0; s < 5; s++) hunt.simulate({ config, actors: [actor], seed: 10_000 + s, budget, ...target });

    const rows: Row[] = [];
    let stepEvents = 0;
    let runEvents = 0;

    rows.push(
      await measure('step x10,000 (copies state each tick)', 3, (sample) => {
        let state: CombatState = createCombat(stalemateSetup(), 1);
        let events = 0;
        while (state.tick < TICKS) {
          const r = step(state, []);
          state = r.state;
          events += r.events.length;
          if (state.tick % 100 === 0) sample();
        }
        stepEvents = events;
        expect(state.outcome).toBeNull();
      }),
    );
    rows.push(
      await measure('runToEnd 10,000 ticks (mutates in place)', 3, (sample) => {
        const r = runToEnd(stalemateSetup(), 1, (state) => {
          if (state.tick % 100 === 0) sample();
          return [];
        });
        runEvents = r.events.length;
        expect(r.ticks).toBe(TICKS);
      }),
    );
    // Same fight, same seed: both styles must emit the same number of events.
    expect(stepEvents).toBe(runEvents);

    rows.push(
      await measure('precompute 180 min (90 segments), 20 runs', 20, (sample) => {
        const t = hunt.simulate({ config, actors: [actor], seed: 7, budget, ...target });
        expect(t.segments.length).toBeGreaterThan(0);
        sample();
      }),
    );
    rows.push(
      await measure('estimate, 200 runs of 180 min', 1, (sample) => {
        const est = estimate(hunt, { config, actors: [actor], budget, ...target }, 200, 1, {
          metrics: (timeline) => {
            sample();
            return rpgIdleMetrics(timeline);
          },
        });
        expect(est.runs).toBe(200);
      }),
    );

    console.log(`node ${process.version}, gc exposed: ${gc !== undefined}`);
    console.table(rows);
    console.log(JSON.stringify({ node: process.version, gcExposed: gc !== undefined, rows }));
  }, 300_000);
});
