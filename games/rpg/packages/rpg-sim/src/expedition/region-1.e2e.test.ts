/**
 * Region 1 end to end with the compiled content bundle: start gating → budget → simulate → placement/reveal →
 * settlement with escrow → progress/report, for every POC duration. Provisional balance: the assertions are about
 * the pipeline, not about balance targets.
 */
import { netHoldings } from '@engine/economy';
import { checkStart, placeSegments, revealCutoff, settleWithEscrow, visibleView } from '@engine/expedition-kernel';
import type { StartRequest } from '@engine/expedition-kernel';
import { BP_SCALE } from '@engine/sim-core';
import { createRpgPredicateRegistry } from '@rpg/rpg-schema';
import type { RpgGameContext } from '@rpg/rpg-schema';
import { describe, expect, it } from 'vitest';

import { createRpgActivityRegistry, rpgProgress } from './index.ts';
import type { RpgActorSnapshot, RpgExpeditionSimulator, RpgIdleConfig } from './index.ts';
import { sims } from './testing/fixtures.ts';
import { GATHER, HUNT, bulwark, idleConfig, region1, rpgContext, thornblade } from './testing/region1.ts';

const { bundle, content } = region1();
const { hunt, gather } = sims();
const activities = createRpgActivityRegistry(content);
const predicates = createRpgPredicateRegistry();
const STARTS_AT = 1_800_000_000_000;
const MIN = 60_000;

function start(simulator: RpgExpeditionSimulator, activityId: string, durationMin: number, config: RpgIdleConfig, actors: RpgActorSnapshot[]) {
  const request: StartRequest = { areaId: 'area:region_1', activityId, durationMin, paceBp: BP_SCALE };
  const gate = checkStart<RpgIdleConfig, RpgActorSnapshot, RpgGameContext>({
    world: bundle.world,
    request,
    activities,
    simulator,
    config: simulator.parseConfig(JSON.parse(JSON.stringify(config))),
    actors,
    evalContexts: actors.map(() => rpgContext({ completedAreas: ['area:region_1'] })),
    predicates,
  });
  if (!gate.ok) throw new Error(`start refused: ${gate.code} ${gate.message ?? ''}`);
  return gate;
}

describe('Region 1 end to end (compiled bundle)', () => {
  for (const durationMin of [15, 30, 60, 180]) {
    it(`hunt and gather run for ${durationMin} min and settle consistently`, () => {
      for (const [simulator, activityId] of [
        [hunt, HUNT],
        [gather, GATHER],
      ] as const) {
        const config = idleConfig(activityId, 5);
        const actors = [bulwark(4)];
        const gate = start(simulator, activityId, durationMin, config, actors);
        for (const seed of [1, 2, 3]) {
          const t = simulator.simulate({ config, actors, seed, budget: gate.budget });
          expect(t.segments.length).toBeGreaterThan(0);
          expect(t.segments.length).toBeLessThanOrEqual(gate.budget);
          if (t.outcome === 'completed') expect(t.segments.length).toBe(gate.budget);
          const placed = placeSegments(t, STARTS_AT, durationMin * MIN, gate.budget);
          expect(placed.plannedEndsAtMs).toBe(STARTS_AT + durationMin * MIN);
          const last = t.segments.length - 1;
          const s = settleWithEscrow(simulator, t, last, 'completed', config, actors);
          const report = simulator.summarize(t, last);
          const progress = rpgProgress(t, last, 'completed');
          expect(report.segments).toBe(t.segments.length);
          expect(report.outcome).toBe(t.outcome);
          expect(progress.actors[0]?.xpEarned).toBe(report.xp['char:bulwark'] ?? 0);
          if (t.outcome !== 'failed') {
            const gold = netHoldings(s.deltas).find((h) => h.asset.kind === 'currency')?.qty ?? 0;
            expect(gold).toBe(report.gold);
          }
          const used = Object.values(report.consumablesUsed).reduce((a, b) => a + b, 0);
          expect(s.returned.reduce((a, d) => a + d.qty, 0)).toBe(5 - used);
        }
      }
    });
  }

  it('reveal never leaks a failure or retreat before the actual end', () => {
    let early = 0;
    for (const [config, actor] of [
      [idleConfig(HUNT, 0), thornblade(1)],
      [idleConfig(HUNT, 1, { belowHpBp: 6000 }), bulwark(1)],
    ] as const) {
      for (let seed = 1; seed <= 10; seed++) {
        const durationMin = 60;
        const gate = start(hunt, HUNT, durationMin, config, [actor]);
        const t = hunt.simulate({ config, actors: [actor], seed, budget: gate.budget });
        const placed = placeSegments(t, STARTS_AT, durationMin * MIN, gate.budget);
        if (t.outcome !== 'completed') {
          early++;
          expect(placed.endsAtMs).toBeLessThan(placed.plannedEndsAtMs);
        }
        for (let now = STARTS_AT - 1; now <= placed.plannedEndsAtMs + MIN; now += 30_000) {
          const view = visibleView(placed, now);
          const json = JSON.stringify(view);
          expect(json).not.toContain('stateAfter');
          expect(view.plannedEndsAtMs).toBe(placed.plannedEndsAtMs);
          if (now < placed.endsAtMs) {
            expect(view.ended).toBe(false);
            expect(view.outcome).toBeUndefined();
            expect(view.endedAtMs).toBeUndefined();
            expect(json).not.toContain('"type":"death"');
            expect(json).not.toContain('"type":"retreat"');
            expect(view.cutoff).toBeLessThan(t.segments.length - 1);
          } else {
            expect(view).toMatchObject({ ended: true, outcome: t.outcome, endedAtMs: placed.endsAtMs });
            expect(revealCutoff(placed, now)).toBe(t.segments.length - 1);
          }
        }
      }
    }
    expect(early).toBeGreaterThan(0);
  });
});
