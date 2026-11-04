/**
 * Kernel contract, escrow conservation, settlement rules, determinism and resumption of `rpg.hunt` / `rpg.gather`
 * over the compiled Region 1 content.
 */
import { netHoldings } from '@engine/economy';
import {
  checkSimulatorContract,
  defaultSettle,
  estimate,
  estimateSeed,
  settleWithEscrow,
  spliceTimeline,
  stableStringify,
  timelineHash,
} from '@engine/expedition-kernel';
import type { SettleReason, Timeline } from '@engine/expedition-kernel';
import { describe, expect, it } from 'vitest';

import { ESCROW, INVENTORY, applyBagLoss, bagTotals, itemAsset, rpgIdleMetrics, rpgProgress, rpgProgressV2 } from './index.ts';
import type { RpgIdleEvent, RpgIdleState } from './index.ts';
import { idleFixtures, sims } from './testing/fixtures.ts';
import { region1 } from './testing/region1.ts';
import type { IdleFixture } from './testing/fixtures.ts';

const SIMS = sims();
const FIXTURES = idleFixtures();
const REASONS: readonly SettleReason[] = ['completed', 'cancelled', 'member_left'];
const sim = (f: IdleFixture) => SIMS[f.kind];
const run = (f: IdleFixture, seed: number): Timeline<RpgIdleEvent, RpgIdleState> =>
  sim(f).simulate({ config: f.config, actors: f.actors, seed, budget: f.budget, areaId: f.areaId, activityId: f.activityId });

describe('kernel contract (checkSimulatorContract)', () => {
  it('has zero violations on every fixture and seed, per-reason modes', () => {
    for (const kind of ['hunt', 'gather'] as const) {
      const fixtures = FIXTURES.filter((f) => f.kind === kind);
      const violations = checkSimulatorContract(SIMS[kind], fixtures, {
        settlement: { completed: 'custom', cancelled: 'default', member_left: 'default' },
      });
      expect(violations).toEqual([]);
    }
    // CPU-bound: every fixture × seed × reason × cutoff, ~5 s on a 4-vCPU runner; the default 5 s timeout flakes under load.
  }, 60_000);

  it('the fixtures cover completed, failed and retreated outcomes', () => {
    const outcomes = new Set<string>();
    for (const f of FIXTURES) for (const seed of f.seeds) outcomes.add(run(f, seed).outcome);
    expect([...outcomes].sort()).toEqual(['completed', 'failed', 'retreated']);
  });
});

describe('escrow and settlement', () => {
  it('conserves escrow at every cutoff and reason (settleWithEscrow)', () => {
    for (const f of FIXTURES) {
      for (const seed of f.seeds.slice(0, 8)) {
        const t = run(f, seed);
        for (const reason of REASONS) {
          for (let cutoff = -1; cutoff < t.segments.length; cutoff++) {
            const s = settleWithEscrow(sim(f), t, cutoff, reason, f.config, f.actors);
            // Escrowed = consumed + returned, per (actor, item).
            const escrowed = new Map(s.escrowed.map((d) => [d.asset.kind === 'stack' ? d.asset.item : '', d.qty]));
            const consumed = new Map<string, number>();
            for (const d of s.settled) if (d.from === ESCROW && d.asset.kind === 'stack') consumed.set(d.asset.item, (consumed.get(d.asset.item) ?? 0) + d.qty);
            const returned = new Map(s.returned.map((d) => [d.asset.kind === 'stack' ? d.asset.item : '', d.qty]));
            for (const [item, qty] of escrowed) expect((consumed.get(item) ?? 0) + (returned.get(item) ?? 0)).toBe(qty);
            for (const d of s.returned) expect(d).toMatchObject({ from: ESCROW, to: INVENTORY });
          }
        }
        // Cancel before the first segment returns everything.
        const none = settleWithEscrow(sim(f), t, -1, 'cancelled', f.config, f.actors);
        expect(none.settled).toEqual([]);
        expect(netHoldings(none.returned)).toEqual([]);
        expect(none.returned.reduce((s, d) => s + d.qty, 0)).toBe(f.config.consumables.reduce((s, c) => s + c.qty, 0));
      }
    }
  });

  it('a natural end grants the bag; a failure keeps ⌈50 %⌉ per asset; cancellations grant revealed segments', () => {
    let sawFailure = false;
    for (const f of FIXTURES) {
      for (const seed of f.seeds) {
        const t = run(f, seed);
        const last = t.segments.length - 1;
        const full = bagTotals(defaultSettle(t, last));
        const settled = bagTotals(sim(f).settle(t, last, 'completed'));
        if (t.outcome === 'failed') {
          sawFailure = true;
          for (const [asset, qty] of Object.entries(full)) expect(settled[asset] ?? 0).toBe(qty - Math.floor(qty / 2));
          // Before the fatal segment nothing is lost.
          if (last > 0) expect(bagTotals(sim(f).settle(t, last - 1, 'completed'))).toEqual(bagTotals(defaultSettle(t, last - 1)));
        } else {
          expect(settled).toEqual(full);
        }
        for (const reason of ['cancelled', 'member_left'] as const) {
          for (const cutoff of [-1, 0, last >> 1]) expect(sim(f).settle(t, cutoff, reason)).toEqual(defaultSettle(t, cutoff));
        }
        // Consumable use is always settled in full.
        const usedDefault = defaultSettle(t, last).filter((d) => d.from === ESCROW);
        const usedSettled = sim(f).settle(t, last, 'completed').filter((d) => d.from === ESCROW);
        expect(netHoldings(usedSettled)).toEqual(netHoldings(usedDefault));
      }
    }
    expect(sawFailure).toBe(true);
  });
});

describe('unique minting of equipment drops (kernel 0.3)', () => {
  it('equipment drops are unique_mint grants, every other drop stays a stack', () => {
    const { content } = region1();
    const kinds = new Set<string>();
    for (const f of FIXTURES) {
      for (const seed of f.seeds) {
        for (const s of run(f, seed).segments) {
          for (const d of s.deltas) {
            if (d.asset.kind === 'unique_mint') {
              kinds.add('unique_mint');
              expect(content.combat.items[d.asset.item]?.kind).toBe('equipment');
              expect(d.from).toBeUndefined();
              expect(d.to).toBe(INVENTORY);
              expect(itemAsset(content, d.asset.item)).toEqual({ kind: 'unique_mint', item: d.asset.item });
            } else if (d.asset.kind === 'stack') {
              kinds.add('stack');
              expect(content.combat.items[d.asset.item]?.kind).not.toBe('equipment');
            }
          }
        }
      }
    }
    expect(kinds).toEqual(new Set(['stack', 'unique_mint']));
  });

  it('the death loss reduces minted instances like any grant (the odd unit stays)', () => {
    const sword = { kind: 'unique_mint', item: 'item:sapforged_blade' } as const;
    expect(applyBagLoss([{ actorId: 'h', asset: sword, qty: 3, to: INVENTORY }], 5000)).toEqual([{ actorId: 'h', asset: sword, qty: 2, to: INVENTORY }]);
    expect(applyBagLoss([{ actorId: 'h', asset: sword, qty: 1, to: INVENTORY }], 5000)).toEqual([{ actorId: 'h', asset: sword, qty: 1, to: INVENTORY }]);
  });
});

describe('estimates with the XP extractor (rpgIdleMetrics)', () => {
  it('aggregates XP per hero with the kernel percentiles, consistent with rpgProgress', () => {
    const f = FIXTURES[1] as IdleFixture; // mostly failing
    const input = { config: f.config, actors: f.actors, budget: f.budget, areaId: f.areaId, activityId: f.activityId };
    const est = estimate(sim(f), input, 30, 11, { metrics: rpgIdleMetrics });
    const id = f.actors[0]?.actorId ?? '';
    const xp = est.metrics.find((m) => m.key === `xp:${id}`);
    const died = est.metrics.find((m) => m.key === `died:${id}`);
    const values: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t = sim(f).simulate({ ...input, seed: estimateSeed(11, i) });
      values.push(rpgProgress(t, t.segments.length - 1, 'completed').actors[0]?.xpEarned ?? 0);
    }
    values.sort((a, b) => a - b);
    expect(xp).toEqual({ key: `xp:${id}`, min: values[0], p10: values[2], p50: values[14], p90: values[26], max: values[29] });
    expect(est.outcomes.failed).toBeGreaterThan(0);
    expect(died?.max).toBe(1);
    expect(estimate(sim(f), input, 30, 11, { metrics: rpgIdleMetrics })).toEqual(est);
  });
});

describe('progress channel (rpgProgress)', () => {
  it('reports XP and kills per hero, no ledger XP, and the death penalty only for a covered death at a natural end', () => {
    for (const f of FIXTURES) {
      for (const seed of f.seeds.slice(0, 10)) {
        const t = run(f, seed);
        const last = t.segments.length - 1;
        const p = rpgProgress(t, last, 'completed');
        const report = sim(f).summarize(t, last);
        expect(p.actors.map((a) => a.actorId)).toEqual(f.actors.map((a) => a.actorId));
        expect(p.actors[0]?.xpEarned).toBe(report.xp[f.actors[0]?.actorId ?? ''] ?? 0);
        expect(p.died).toBe(t.outcome === 'failed');
        expect(p.applyDeathPenalty).toBe(t.outcome === 'failed');
        expect(p).not.toHaveProperty('deathXpLossBp'); // level-scaled since rpg-idle@2.1.0 (#129): a stats rule, not a simulator output
        expect(rpgProgressV2(t, last, 'completed').deathXpLossBp).toBe(t.outcome === 'failed' ? 1_000 : 0); // frozen 2.0.0 channel
        if (last >= 1) expect(rpgProgress(t, last - 1, 'completed').died).toBe(false);
        expect(rpgProgress(t, last, 'cancelled').applyDeathPenalty).toBe(false);
        for (const s of t.segments) for (const d of s.deltas) expect(d.asset.kind === 'currency' ? d.asset.currency : 'item').not.toMatch(/xp/i);
      }
    }
  });
});

describe('determinism and resumption', () => {
  it('same inputs ⇒ same timeline hash; different seeds differ', () => {
    const f = FIXTURES[0] as IdleFixture;
    expect(timelineHash(run(f, 7))).toBe(timelineHash(run(structuredClone(f), 7)));
    expect(timelineHash(run(f, 7))).not.toBe(timelineHash(run(f, 8)));
  });

  it('resuming from stateAfter[k-1] with the same seed reproduces the suffix exactly', () => {
    for (const f of FIXTURES) {
      for (const seed of f.seeds.slice(0, 5)) {
        const t = run(f, seed);
        for (let k = 1; k < t.segments.length; k++) {
          const prev = t.segments[k - 1];
          if (prev?.stateAfter === undefined) throw new Error('missing stateAfter');
          const resumed = sim(f).simulate({
            config: f.config,
            actors: f.actors,
            seed,
            budget: f.budget - k,
            areaId: f.areaId,
            activityId: f.activityId,
            from: { segment: k, state: structuredClone(prev.stateAfter) },
          });
          expect(stableStringify(spliceTimeline(t, k, resumed))).toBe(stableStringify(t));
        }
      }
    }
  });
});
