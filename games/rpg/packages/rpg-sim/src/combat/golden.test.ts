/**
 * Golden replays (combat-engine §10): `(setup, seed, inputs) → hashEvents(events)`, frozen per ENGINE_VERSION in
 * `golden.json`, an **append-only** history keyed by engine version (one entry per released behaviour).
 *
 * Update procedure (only for a deliberate behaviour change):
 *   1. Bump `ENGINE_VERSION` in `src/version.ts`.
 *   2. Run `pnpm vitest run --project @rpg/rpg-sim golden` — the failure message prints the new hashes.
 *   3. Append a new `golden.json` entry for the new version (never edit an existing entry) in the same commit and explain
 *      the behaviour change in the message.
 * What fails CI:
 *   - a behaviour change without updated hashes (hash mismatch below);
 *   - a version bump without a fixture entry, or an entry that is not the latest one (tests below);
 *   - updated hashes without a version bump: the CI step `tools/golden/check-append-only.ts` rejects changing or removing
 *     any (version, case) hash that exists on the base commit. New cases may be added to the current entry.
 * Editing test content in `testing/fixtures.ts` that changes an existing case's hash therefore also needs a new entry
 * (bump the version and say in the commit message that only the inputs changed).
 */
import { describe, expect, it } from 'vitest';

import { ENGINE_VERSION, hashEvents, runToEnd } from '../index.ts';
import type { CombatInput, CombatPolicy, CombatSetup } from '../index.ts';
import GOLDEN from './golden.json' with { type: 'json' };
import { GUARD_RULES, bossSetup, bruteSetup, manualGuardPolicy, partySetup, stalemateSetup } from './testing/fixtures.ts';

const HISTORY: Record<string, Record<string, string>> = GOLDEN;

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
  // Since rpg-sim@1.1.0 (#71): guarded vs unguarded crushing-blow stuns.
  'brute-naive-seed-5': () => ({ setup: bruteSetup(), seed: 5 }),
  'brute-guard-rules-seed-5': () => ({ setup: bruteSetup(GUARD_RULES), seed: 5 }),
};

describe('golden replays', () => {
  it('fixtures exist for the current ENGINE_VERSION, as the latest history entry', () => {
    const versions = Object.keys(HISTORY);
    expect(versions).toContain(ENGINE_VERSION);
    expect(versions.at(-1)).toBe(ENGINE_VERSION);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('event hashes match the frozen fixtures of the current version', () => {
    const actual: Record<string, string> = {};
    for (const [name, make] of Object.entries(CASES)) {
      const { setup, seed, policy, maxTicks } = make();
      actual[name] = hashEvents(runToEnd(setup, seed, policy, maxTicks).events);
    }
    expect(actual, `new hashes: ${JSON.stringify(actual, null, 2)}`).toEqual(HISTORY[ENGINE_VERSION]);
  });

  it('every replay records the engine version that produced it', () => {
    const { setup, seed } = CASES['party-auto-seed-42']?.() ?? { setup: partySetup(), seed: 42 };
    const first = runToEnd(setup, seed, undefined, 1).events[0];
    expect(first).toMatchObject({ type: 'CombatStarted', engineVersion: ENGINE_VERSION });
  });
});
