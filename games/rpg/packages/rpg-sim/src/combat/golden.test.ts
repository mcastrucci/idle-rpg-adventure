/**
 * Golden replays (combat-engine §10): `(setup, seed, inputs) → hashEvents(events)`, frozen per ENGINE_VERSION.
 *
 * Update procedure (only for a deliberate behaviour change):
 *   1. Bump `ENGINE_VERSION` in `src/version.ts`.
 *   2. Run `pnpm vitest run --project @rpg/rpg-sim golden` — the failure message prints the new hashes.
 *   3. Replace `GOLDEN` below (version + hashes) in the same commit and explain the behaviour change in the message.
 * A hash change without a version bump (or vice versa) fails this suite on purpose.
 * Exception: editing the test content in `testing/fixtures.ts` changes these inputs, not the engine — update the hashes
 * without a version bump and say so in the commit message.
 */
import { describe, expect, it } from 'vitest';

import { ENGINE_VERSION, hashEvents, runToEnd } from '../index.ts';
import type { CombatInput, CombatPolicy, CombatSetup } from '../index.ts';
import { bossSetup, manualGuardPolicy, partySetup, stalemateSetup } from './testing/fixtures.ts';

const GOLDEN = {
  engineVersion: 'rpg-sim@1.0.0',
  cases: {
    'party-auto-seed-42': '4a5745712a617e5d',
    'boss-manual-guard-seed-7': 'fe03c4e323165310',
    'boss-scripted-inputs-seed-7': '0d872321acfc781a',
    'stalemate-timeout-seed-3': '4c5e8789e891acc3',
  } as Record<string, string>,
};

/** Fixed live inputs, including invalid ones (rejections are part of the replay). */
const SCRIPT: Record<number, CombatInput[]> = {
  2: [{ actorId: 'hero:a', kind: 'setAuto', auto: false }],
  3: [{ actorId: 'hero:a', kind: 'useSkill', skill: 'skill:shield_bash' }],
  9: [{ actorId: 'hero:a', kind: 'useSkill', skill: 'skill:nope' }],
  10: [{ actorId: 'hero:a', kind: 'useSkill', skill: 'skill:guard' }],
  20: [{ actorId: 'hero:a', kind: 'setAuto', auto: true }],
};
const scripted: CombatPolicy = (state) => SCRIPT[state.tick + 1] ?? [];

const CASES: Record<string, () => { setup: CombatSetup; seed: number; policy?: CombatPolicy; maxTicks?: number }> = {
  'party-auto-seed-42': () => ({ setup: partySetup(), seed: 42 }),
  'boss-manual-guard-seed-7': () => ({ setup: bossSetup(), seed: 7, policy: manualGuardPolicy }),
  'boss-scripted-inputs-seed-7': () => ({ setup: bossSetup(), seed: 7, policy: scripted }),
  'stalemate-timeout-seed-3': () => ({ setup: stalemateSetup(), seed: 3, maxTicks: 400 }),
};

describe('golden replays', () => {
  it('fixtures belong to the current ENGINE_VERSION', () => {
    expect(GOLDEN.engineVersion).toBe(ENGINE_VERSION);
  });

  it('event hashes match the frozen fixtures', () => {
    const actual: Record<string, string> = {};
    for (const [name, make] of Object.entries(CASES)) {
      const { setup, seed, policy, maxTicks } = make();
      actual[name] = hashEvents(runToEnd(setup, seed, policy, maxTicks).events);
    }
    expect(actual, `new hashes: ${JSON.stringify(actual, null, 2)}`).toEqual(GOLDEN.cases);
  });
});
