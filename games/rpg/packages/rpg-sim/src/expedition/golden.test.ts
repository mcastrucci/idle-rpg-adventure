/**
 * Golden idle timelines: `timelineHash` (kernel, uint32 as 8 hex digits) of fixed Region 1 expeditions, frozen per
 * `RPG_IDLE_SIMULATOR_VERSION` (= `RPG_IDLE_VERSION` + the combat `ENGINE_VERSION`) in `golden.json`, an **append-only**
 * history keyed by that version.
 *
 * Update procedure (only for a deliberate behaviour change of the idle model, the combat engine, or the test content):
 *   1. Bump `RPG_IDLE_VERSION` in `simulator.ts` (a combat `ENGINE_VERSION` bump changes the key by itself).
 *   2. Run `pnpm vitest run --project @rpg/rpg-sim expedition/golden` — the failure message prints the new hashes.
 *   3. Append a new `golden.json` entry under the new version (never edit an existing entry) in the same commit and
 *      explain the change in the message.
 * The CI step `tools/golden/check-append-only.ts` rejects edits of existing (version, case) hashes. Golden cases use the
 * compiled `games/rpg/content`: a content change that alters them also needs a new entry (bump and say that only the
 * content changed).
 */
import { timelineHash } from '@engine/expedition-kernel';
import { describe, expect, it } from 'vitest';

import { RPG_IDLE_SIMULATOR_VERSION } from './index.ts';
import type { RpgActorSnapshot, RpgExpeditionSimulator, RpgIdleConfig } from './index.ts';
import GOLDEN from './golden.json' with { type: 'json' };
import { sims } from './testing/fixtures.ts';
import { GATHER, HUNT, bulwark, idleConfig, thornblade } from './testing/region1.ts';

const HISTORY: Record<string, Record<string, string>> = GOLDEN;
const { hunt, gather } = sims();

const CASES: Record<string, () => { sim: RpgExpeditionSimulator; activityId: string; config: RpgIdleConfig; actors: RpgActorSnapshot[]; seed: number; budget: number }> = {
  'hunt-bulwark-l4-60min-3potions-seed-42': () => ({ sim: hunt, activityId: HUNT, config: idleConfig(3), actors: [bulwark(4)], seed: 42, budget: 30 }),
  'hunt-thornblade-l1-30min-no-potions-seed-3': () => ({ sim: hunt, activityId: HUNT, config: idleConfig(0), actors: [thornblade(1)], seed: 3, budget: 15 }),
  'hunt-bulwark-l1-retreat-60pct-seed-5': () => ({
    sim: hunt,
    activityId: HUNT,
    config: idleConfig(1, { belowHpBp: 6000 }),
    actors: [bulwark(1)],
    seed: 5,
    budget: 15,
  }),
  'gather-bulwark-l2-60min-seed-9': () => ({ sim: gather, activityId: GATHER, config: idleConfig(1), actors: [bulwark(2)], seed: 9, budget: 10 }),
};

const hex = (n: number): string => n.toString(16).padStart(8, '0');

describe('golden idle timelines', () => {
  it('fixtures exist for the current simulator version, as the latest history entry', () => {
    const versions = Object.keys(HISTORY);
    expect(versions.at(-1)).toBe(RPG_IDLE_SIMULATOR_VERSION);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('timeline hashes match the frozen fixtures of the current version', () => {
    const actual: Record<string, string> = {};
    const outcomes: Record<string, string> = {};
    for (const [name, make] of Object.entries(CASES)) {
      const { sim, activityId, config, actors, seed, budget } = make();
      const t = sim.simulate({ config, actors, seed, budget, areaId: 'area:region_1', activityId });
      actual[name] = hex(timelineHash(t));
      outcomes[name] = t.outcome;
    }
    expect(actual, `new hashes: ${JSON.stringify(actual, null, 2)}`).toEqual(HISTORY[RPG_IDLE_SIMULATOR_VERSION]);
    // The cases cover every outcome (checked at the current version).
    expect(new Set(Object.values(outcomes))).toEqual(new Set(['completed', 'failed', 'retreated']));
  });
});
