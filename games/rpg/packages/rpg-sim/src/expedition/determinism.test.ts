/**
 * Spike 1 / ADR-0004: repeated-run determinism. One idle expedition and one combat run are each simulated 1,000 times
 * from freshly rebuilt inputs; every run must produce the same hash, equal to the frozen golden hash of the current
 * version (`golden.json` of the expedition and combat suites; no new golden entries). Inputs are rebuilt every run, so a
 * simulator that mutated its inputs (or kept module state) would diverge. Runs in the normal suite (Node 22 and 24 in CI).
 */
import { timelineHash } from '@engine/expedition-kernel';
import { describe, expect, it } from 'vitest';

import { ENGINE_VERSION, hashEvents, runToEnd } from '../index.ts';
import COMBAT_GOLDEN from '../combat/golden.json' with { type: 'json' };
import { partySetup } from '../combat/testing/fixtures.ts';
import { RPG_IDLE_SIMULATOR_VERSION } from './index.ts';
import GOLDEN from './golden.json' with { type: 'json' };
import { sims } from './testing/fixtures.ts';
import { HUNT, REGION_1, idleConfig, thornblade } from './testing/region1.ts';

const RUNS = 1_000;
const IDLE_CASE = 'hunt-thornblade-l1-30min-no-potions-seed-3';
const COMBAT_CASE = 'party-auto-seed-42';
const IDLE_HISTORY: Record<string, Record<string, string>> = GOLDEN;
const COMBAT_HISTORY: Record<string, Record<string, string>> = COMBAT_GOLDEN;
const hex = (n: number): string => n.toString(16).padStart(8, '0');

describe('repeated-run determinism (1,000 runs)', () => {
  it('idle expedition: identical timelineHash on every run, equal to the golden hash', () => {
    const { hunt } = sims();
    const golden = IDLE_HISTORY[RPG_IDLE_SIMULATOR_VERSION]?.[IDLE_CASE];
    expect(golden).toBeDefined();
    const hashes = new Set<string>();
    for (let i = 0; i < RUNS; i++) {
      // Inputs rebuilt every run (fresh config and actor snapshot objects).
      const t = hunt.simulate({ config: idleConfig(0), actors: [thornblade(1)], seed: 3, budget: 15, areaId: REGION_1, activityId: HUNT });
      hashes.add(hex(timelineHash(t)));
    }
    expect([...hashes]).toEqual([golden]);
  }, 60_000);

  it('combat run: identical event hash on every run, equal to the golden hash', () => {
    const golden = COMBAT_HISTORY[ENGINE_VERSION]?.[COMBAT_CASE];
    expect(golden).toBeDefined();
    const hashes = new Set<string>();
    for (let i = 0; i < RUNS; i++) hashes.add(hashEvents(runToEnd(partySetup(), 42).events));
    expect([...hashes]).toEqual([golden]);
  }, 60_000);
});
