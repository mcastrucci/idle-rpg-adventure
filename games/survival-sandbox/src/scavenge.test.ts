import { netHoldings } from '@engine/economy';
import {
  KERNEL_VERSION,
  checkSimulatorContract,
  checkStart,
  defaultSettle,
  estimate,
  placeSegments,
  settleWithEscrow,
  spliceTimeline,
  stableStringify,
  timelineHash,
  visibleView,
} from '@engine/expedition-kernel';
import type { ContractFixture, StartRequest, Timeline } from '@engine/expedition-kernel';
import { BP_SCALE } from '@engine/sim-core';
import { describe, expect, it } from 'vitest';

import {
  ESCROW,
  PACK,
  SCAVENGE_ACTIVITY_ID,
  SUPPLY_ITEMS,
  SUPPLY_SOURCE,
  createScavengeSimulator,
  parseScavengeConfig,
  survivalActivities,
} from './scavenge.ts';
import type { ScavengeConfig, ScavengeEvent, ScavengeState, SurvivorGroup } from './scavenge.ts';
import { loadWorld, survivalContext, survivalRegistry } from './world.ts';

const sim = createScavengeSimulator();
const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);

const group = (actorId: string, over: Partial<SurvivorGroup> = {}): SurvivorGroup => ({
  actorId,
  members: 3,
  condition: 100,
  carryCapacity: 12,
  ...over,
});
// `hours` documents the intended duration; it is kernel-owned (budget/start request), not part of the config.
const config = (district: 'old_market' | 'rail_yard', _hours: 1 | 2 | 3, supplies: Partial<ScavengeConfig['supplies']> = {}): ScavengeConfig => ({
  district: `area:${district}`,
  supplies: { food: 9, water: 9, medkits: 1, ...supplies },
});

type Fixture = ContractFixture<ScavengeConfig, SurvivorGroup> & { readonly name: string };
const FIXTURES: readonly Fixture[] = [
  { name: 'old market, solo, 3h', config: config('old_market', 3), actors: [group('g:a')], budget: 3, seeds: SEEDS },
  {
    name: 'rail yard, wounded, no medkits (fails often)',
    config: config('rail_yard', 3, { medkits: 0 }),
    actors: [group('g:a', { condition: 35 })],
    budget: 3,
    seeds: SEEDS,
  },
  {
    name: 'rail yard, short on water (retreats)',
    config: config('rail_yard', 3, { water: 4 }),
    actors: [group('g:a')],
    budget: 3,
    seeds: SEEDS,
  },
  {
    name: 'old market, party of two, 2h',
    config: config('old_market', 2, { food: 4, water: 4 }),
    actors: [group('g:b', { members: 2, carryCapacity: 3 }), group('g:a', { members: 2 })],
    budget: 2,
    seeds: SEEDS,
  },
  {
    name: 'rail yard, double pace (6 hours in 3h)',
    config: config('rail_yard', 3, { food: 18, water: 18, medkits: 2 }),
    actors: [group('g:a', { condition: 60 })],
    budget: sim.budget(config('rail_yard', 3), 180, 2 * BP_SCALE),
    seeds: SEEDS,
  },
];

const run = (f: Fixture, seed: number): Timeline<ScavengeEvent, ScavengeState> =>
  sim.simulate({ config: f.config, actors: f.actors, seed, budget: f.budget });
const fixture = (i: number): Fixture => FIXTURES[i] as Fixture;

describe('config, start checks and budget', () => {
  it('parses valid configs and rejects invalid ones', () => {
    expect(parseScavengeConfig(JSON.parse(JSON.stringify(config('rail_yard', 2))))).toEqual(config('rail_yard', 2));
    const bad: unknown[] = [
      null,
      { ...config('old_market', 1), district: 'area:mall' },
      { ...config('old_market', 1), durationMin: 60 }, // duration is kernel-owned
      { ...config('old_market', 1), supplies: { food: -1, water: 1, medkits: 0 } },
      { ...config('old_market', 1), supplies: { food: 1.5, water: 1, medkits: 0 } },
      { ...config('old_market', 1), extra: true },
    ];
    for (const input of bad) expect(() => parseScavengeConfig(input)).toThrow();
  });

  it('canStart checks duration, actors, condition and supplies', () => {
    const ctx = (c: ScavengeConfig, actors: SurvivorGroup[], durationMin = 60) => sim.canStart({ config: c, actors, durationMin, paceBp: BP_SCALE });
    expect(ctx(config('old_market', 1), [group('g:a')])).toEqual({ ok: true });
    expect(ctx(config('old_market', 1), [group('g:a')], 90)).toMatchObject({ ok: false, code: 'invalid_duration' });
    expect(ctx(config('old_market', 1), [])).toMatchObject({ ok: false, code: 'no_actors' });
    expect(ctx(config('old_market', 1), [group('g:a', { condition: 0 })])).toMatchObject({ ok: false, code: 'group_incapacitated' });
    expect(ctx(config('old_market', 1, { water: 2 }), [group('g:a')])).toMatchObject({ ok: false, code: 'insufficient_supplies' });
  });

  it('budget = in-game hours, scaled by pace with integer math', () => {
    const c = config('old_market', 3);
    expect(sim.budget(c, 180, BP_SCALE)).toBe(3);
    expect(sim.budget(c, 180, 2 * BP_SCALE)).toBe(6);
    expect(sim.budget(c, 120, 15_000)).toBe(3);
    expect(sim.budget(c, 60, 5000)).toBe(1); // at least one hour
  });
});

describe('engine start gating (checkStart)', () => {
  const world = loadWorld();
  const predicates = survivalRegistry();
  const activities = survivalActivities(sim);
  const request = (over: Partial<StartRequest> = {}): StartRequest => ({
    areaId: 'area:old_market',
    activityId: SCAVENGE_ACTIVITY_ID,
    durationMin: 120,
    paceBp: BP_SCALE,
    ...over,
  });
  const completed = survivalContext({ completedAreas: ['area:old_market', 'area:rail_yard'] });
  const gate = (req: StartRequest, c = config('old_market', 2), ctx = completed) =>
    checkStart({ world, request: req, activities, simulator: sim, config: c, actors: [group('g:a')], evalContexts: [ctx], predicates });

  it('maps activity:scavenge to survival.scavenge for every district', () => {
    for (const a of world.areas) for (const id of a.activities ?? []) expect(activities.get(id)?.id).toBe('survival.scavenge');
  });

  it('starts a completed district and returns budget and per-group escrow', () => {
    expect(gate(request())).toEqual({
      ok: true,
      budget: 2,
      escrow: [
        { actorId: 'g:a', asset: { kind: 'stack', item: SUPPLY_ITEMS.food }, qty: 9, from: SUPPLY_SOURCE, to: ESCROW },
        { actorId: 'g:a', asset: { kind: 'stack', item: SUPPLY_ITEMS.water }, qty: 9, from: SUPPLY_SOURCE, to: ESCROW },
        { actorId: 'g:a', asset: { kind: 'stack', item: SUPPLY_ITEMS.medkits }, qty: 1, from: SUPPLY_SOURCE, to: ESCROW },
      ],
    });
  });

  it('refuses districts that are not completed (engine gate), with reasons', () => {
    const fresh = survivalContext({ discovered: { 'area:old_market': ['loc:old_market.gate'] } });
    expect(gate(request(), config('old_market', 2), fresh)).toMatchObject({
      ok: false,
      code: 'start.areaNotCompleted',
      reasons: ['completion.discoveries:area:old_market', 'requires.flag:old_market.generator_restored'],
    });
  });

  it('refuses the hub, unknown durations and a config targeting another district', () => {
    expect(gate(request({ areaId: 'area:shelter' }))).toMatchObject({ ok: false, code: 'start.activityNotInArea' });
    expect(gate(request({ durationMin: 90 }))).toMatchObject({ ok: false, code: 'invalid_duration' });
    expect(gate(request(), config('rail_yard', 2))).toMatchObject({ ok: false, code: 'district_mismatch' });
  });
});

describe('simulation', () => {
  it('covers every outcome across the fixtures', () => {
    const outcomes = new Set(FIXTURES.flatMap((f) => f.seeds.map((s) => run(f, s).outcome)));
    expect([...outcomes].sort()).toEqual(['completed', 'failed', 'retreated']);
  });

  it('consumes food and water per member per hour from escrow and never exceeds carry capacity', () => {
    for (const f of FIXTURES) {
      for (const seed of f.seeds) {
        const t = run(f, seed);
        const holdings = netHoldings(defaultSettle(t, t.segments.length - 1));
        for (const a of f.actors) {
          const qty = (item: string) => holdings.find((h) => h.actorId === a.actorId && h.asset.kind === 'stack' && h.asset.item === item)?.qty ?? 0;
          expect(qty(SUPPLY_ITEMS.food)).toBe(-a.members * t.segments.length);
          expect(qty(SUPPLY_ITEMS.water)).toBe(-a.members * t.segments.length);
          const carried = t.segments.flatMap((s) => s.deltas).filter((d) => d.actorId === a.actorId && d.to === PACK).reduce((n, d) => n + d.qty, 0);
          expect(carried).toBeLessThanOrEqual(a.carryCapacity);
        }
        for (const d of t.segments.flatMap((s) => s.deltas)) {
          expect(d.to === PACK || d.from === ESCROW).toBe(true);
        }
      }
    }
  });

  it('fails exactly when a group is down and retreats when supplies run out', () => {
    for (const f of FIXTURES) {
      for (const seed of f.seeds) {
        const t = run(f, seed);
        const last = t.segments[t.segments.length - 1];
        const types = last?.events.map((e) => e.type) ?? [];
        if (t.outcome === 'failed') expect(types).toContain('down');
        if (t.outcome === 'retreated') expect(types).toContain('retreat');
        if (t.outcome === 'completed') expect(t.segments.length).toBe(f.budget);
        for (const s of t.segments.slice(0, -1)) expect(s.events.some((e) => e.type === 'down' || e.type === 'retreat')).toBe(false);
      }
    }
  });

  it('resuming from stateAfter with the same seed reproduces the original suffix', () => {
    for (const f of FIXTURES) {
      for (const seed of f.seeds.slice(0, 6)) {
        const t = run(f, seed);
        for (let k = 1; k < t.segments.length; k++) {
          const state = t.segments[k - 1]?.stateAfter as ScavengeState;
          const resumed = sim.simulate({ config: f.config, actors: f.actors, seed, budget: f.budget - k, from: { segment: k, state } });
          expect(stableStringify(spliceTimeline(t, k, resumed))).toBe(stableStringify(t));
        }
      }
    }
  });
});

describe('kernel contract', () => {
  it('passes checkSimulatorContract with per-reason modes (custom only for completed) on every fixture', () => {
    expect(checkSimulatorContract(sim, FIXTURES, { settlement: { completed: 'custom', cancelled: 'default', member_left: 'default' } })).toEqual([]);
  });

  it('passes with the inferred (all custom) mode too: the failure penalty stays within the default bound', () => {
    expect(checkSimulatorContract(sim, FIXTURES)).toEqual([]);
  });

  it('returns unused supplies through the kernel at every cutoff (also before the first hour)', () => {
    for (const f of FIXTURES) {
      for (const seed of f.seeds.slice(0, 8)) {
        const t = run(f, seed);
        for (let cutoff = -1; cutoff < t.segments.length; cutoff++) {
          for (const reason of ['completed', 'cancelled'] as const) {
            if (reason === 'completed' && cutoff !== t.segments.length - 1) continue;
            const s = settleWithEscrow(sim, t, cutoff, reason, f.config, f.actors);
            const hours = cutoff + 1;
            for (const a of f.actors) {
              const returned = (item: string) =>
                s.returned.find((d) => d.actorId === a.actorId && d.asset.kind === 'stack' && d.asset.item === item)?.qty ?? 0;
              expect(returned(SUPPLY_ITEMS.food)).toBe(f.config.supplies.food - a.members * hours);
              expect(returned(SUPPLY_ITEMS.water)).toBe(f.config.supplies.water - a.members * hours);
            }
            for (const d of s.returned) expect(d).toMatchObject({ from: ESCROW, to: SUPPLY_SOURCE });
          }
        }
      }
    }
  });

  it('failure keeps supply consumption and loses half of the finds (integer)', () => {
    const f = fixture(1);
    const failed = f.seeds.map((s) => run(f, s)).filter((t) => t.outcome === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const t of failed) {
      const last = t.segments.length - 1;
      const settled = netHoldings(sim.settle(t, last, 'completed'));
      const full = netHoldings(defaultSettle(t, last));
      for (const h of full) {
        const got = settled.find((x) => x.actorId === h.actorId && stableStringify(x.asset) === stableStringify(h.asset))?.qty ?? 0;
        expect(got).toBe(h.qty > 0 ? h.qty - Math.floor(h.qty / 2) : h.qty);
      }
      // Cancelled / member_left settle up to the cutoff by default rules.
      expect(sim.settle(t, last, 'cancelled')).toEqual(defaultSettle(t, last));
      expect(sim.settle(t, last, 'member_left')).toEqual(defaultSettle(t, last));
      expect(sim.summarize(t, last)).toMatchObject({ outcome: 'failed', causeOfFailure: expect.stringMatching(/^(threat:|infection)/) });
    }
  });
});

describe('placement and reveal', () => {
  const HOUR = 3_600_000;

  it('never reveals a failure (or an early end) before it happens', () => {
    let checked = 0;
    for (const f of FIXTURES) {
      for (const seed of f.seeds) {
        const t = run(f, seed);
        if (t.outcome === 'completed') continue;
        const durationMs = f.budget * 60 * 60_000; // budget = hours at pace ×1 (the double-pace fixture just compresses them)
        const placed = placeSegments(t, 1_000, durationMs, f.budget);
        expect(placed.endsAtMs).toBeLessThanOrEqual(placed.plannedEndsAtMs);
        for (let now = 0; now < placed.endsAtMs; now += 60_000) {
          const v = visibleView(placed, now);
          expect(v.ended).toBe(false);
          expect('outcome' in v).toBe(false);
          expect('endedAtMs' in v).toBe(false);
          expect(v.plannedEndsAtMs).toBe(1_000 + durationMs);
          expect(v.segments.length).toBeLessThan(t.segments.length);
          const json = JSON.stringify(v);
          expect(json).not.toMatch(/"(down|retreat)"|stateAfter|endsAtMs/);
        }
        const atEnd = visibleView(placed, placed.endsAtMs);
        expect(atEnd).toMatchObject({ ended: true, outcome: t.outcome, endedAtMs: placed.endsAtMs });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('places one segment per hour at pace x1', () => {
    const f = fixture(0);
    const placed = placeSegments(run(f, 42), 0, 3 * HOUR, 3);
    expect(placed.segments.map((s) => s.revealAtMs)).toEqual([HOUR, 2 * HOUR, 3 * HOUR]);
    expect(visibleView(placed, HOUR + 1).segments.map((s) => s.index)).toEqual([0]);
  });
});

describe('estimate', () => {
  it('produces sane integer ranges', () => {
    const f = fixture(1);
    const est = estimate(sim, { config: f.config, actors: f.actors, budget: f.budget }, 400, 42);
    expect(est.outcomes.completed + est.outcomes.retreated + est.outcomes.failed).toBe(400);
    expect(est.outcomes.failed).toBeGreaterThan(0);
    expect(est.outcomes.completed).toBeGreaterThan(0);
    const actor = f.actors[0] as SurvivorGroup;
    for (const a of est.assets) {
      expect(a.min).toBeLessThanOrEqual(a.p10);
      expect(a.p10).toBeLessThanOrEqual(a.p50);
      expect(a.p50).toBeLessThanOrEqual(a.p90);
      expect(a.p90).toBeLessThanOrEqual(a.max);
      for (const v of [a.min, a.p10, a.p50, a.p90, a.max]) expect(Number.isSafeInteger(v)).toBe(true);
      const item = a.asset.kind === 'stack' ? a.asset.item : '';
      if (item === SUPPLY_ITEMS.food || item === SUPPLY_ITEMS.water) {
        expect(a.min).toBeGreaterThanOrEqual(-actor.members * f.budget);
        expect(a.max).toBeLessThanOrEqual(-actor.members);
      } else if (item === SUPPLY_ITEMS.medkits) {
        expect(a.max).toBe(0);
      } else {
        expect(a.min).toBeGreaterThanOrEqual(0);
        expect(a.max).toBeLessThanOrEqual(actor.carryCapacity);
      }
    }
    expect(estimate(sim, { config: f.config, actors: f.actors, budget: f.budget }, 50, 7)).toEqual(
      estimate(sim, { config: f.config, actors: f.actors, budget: f.budget }, 50, 7),
    );
  });
});

describe('golden timeline', () => {
  // Updated deliberately in simulator 2.0.0 / kernel 0.2.0: hours now use the kernel's segmentStreams
  // (deriveSeed(seed, 'segment', i) instead of the sandbox's own 'hour' label), so every roll changed.
  it('is frozen for rail yard, 3h, seed 42 (bump SCAVENGE_SIMULATOR_VERSION if this changes)', () => {
    expect(KERNEL_VERSION).toBe('0.2.0');
    const t = sim.simulate({ config: config('rail_yard', 3), actors: [group('g:a')], seed: 42, budget: 3 });
    expect({ outcome: t.outcome, hours: t.segments.length, hash: timelineHash(t) }).toEqual({ outcome: 'completed', hours: 3, hash: 1968916264 });
  });
});
