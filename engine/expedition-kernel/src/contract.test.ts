import { describe, expect, it } from 'vitest';

import { COIN, coinCollector } from './__tests__/coin-collector.ts';
import type { CoinActor, CoinConfig, CoinEvent, CoinReport, CoinState } from './__tests__/coin-collector.ts';
import { TORCH, torchCollector } from './__tests__/torch-collector.ts';
import { checkSimulatorContract, defaultSettle, settlementBoundViolations } from './index.ts';
import type { ContractFixture, ContractRule, ExpeditionSimulator } from './index.ts';

type Sim = ExpeditionSimulator<CoinConfig, CoinActor, CoinEvent, CoinState, CoinReport>;

const fixtures: ContractFixture<CoinConfig, CoinActor>[] = [
  { name: 'safe', config: { maxCoins: 7, hazardBp: 0 }, actors: [{ id: 'b' }, { id: 'a' }], budget: 10, seeds: [1, 2, 3] },
  { name: 'risky', config: { maxCoins: 3, hazardBp: 2500 }, actors: [{ id: 'a' }], budget: 20, seeds: [4, 5, 6, 7] },
  { name: 'retreat', config: { maxCoins: 9, hazardBp: 0, retreatAtCoins: 15 }, actors: [{ id: 'x' }], budget: 30, seeds: [8] },
];

function rules(sim: Sim, options?: Parameters<typeof checkSimulatorContract>[2]): Set<ContractRule> {
  return new Set(checkSimulatorContract(sim, fixtures, options).map((v) => v.rule));
}

describe('checkSimulatorContract', () => {
  it('accepts the coin collector', () => {
    expect(checkSimulatorContract(coinCollector, fixtures)).toEqual([]);
  });

  it('detects non-determinism through shared mutable state', () => {
    let calls = 0;
    const leaky: Sim = {
      ...coinCollector,
      simulate(input) {
        calls++;
        const t = coinCollector.simulate(input);
        return { ...t, segments: t.segments.map((s) => ({ ...s, events: [...s.events, { type: 'found', actorId: 'z', coins: calls }] })) };
      },
    };
    expect(rules(leaky)).toContain('determinism');
  });

  it('detects non-contiguous indices', () => {
    const gappy: Sim = {
      ...coinCollector,
      simulate(input) {
        const t = coinCollector.simulate(input);
        return { ...t, segments: t.segments.map((s) => ({ ...s, index: s.index * 2 })) };
      },
    };
    expect(rules(gappy)).toContain('structure');
  });

  it('detects float quantities', () => {
    const floaty: Sim = {
      ...coinCollector,
      simulate(input) {
        const t = coinCollector.simulate(input);
        return { ...t, segments: t.segments.map((s) => ({ ...s, deltas: s.deltas.map((d) => ({ ...d, qty: d.qty / 3 })) })) };
      },
    };
    const violations = checkSimulatorContract(floaty, fixtures);
    expect(violations.some((v) => v.rule === 'structure' && /qty/.test(v.message))).toBe(true);
  });

  it('detects zero weights', () => {
    const weightless: Sim = {
      ...coinCollector,
      simulate(input) {
        const t = coinCollector.simulate(input);
        return { ...t, segments: t.segments.map((s) => ({ ...s, weight: 0 })) };
      },
    };
    const violations = checkSimulatorContract(weightless, fixtures);
    expect(violations.some((v) => v.rule === 'structure' && /weight/.test(v.message))).toBe(true);
  });

  it('detects budget overruns', () => {
    const greedy: Sim = { ...coinCollector, simulate: (input) => coinCollector.simulate({ ...input, budget: input.budget + 5 }) };
    expect(rules(greedy)).toContain('budget');
  });

  it('detects settlement leaking deltas of later segments', () => {
    const leaky: Sim = { ...coinCollector, settle: (t) => t.segments.flatMap((s) => s.deltas) };
    expect(rules(leaky, { settlement: 'default' })).toContain('settle-cutoff');
    expect(rules(leaky)).not.toContain('settle-cutoff'); // custom settlement: not checked against the default
  });

  it('detects non-integer or non-deterministic custom settlement', () => {
    let n = 0;
    const halves: Sim = {
      ...coinCollector,
      settle: (t, cutoff) => defaultSettle(t, cutoff).map((d) => ({ ...d, qty: d.qty / 2 })),
    };
    const drifting: Sim = {
      ...coinCollector,
      settle: (t, cutoff) => [...defaultSettle(t, cutoff), { actorId: 'a', asset: { kind: 'currency', currency: 'c' }, qty: ++n }],
    };
    expect(rules(halves)).toContain('settle-delta');
    expect(rules(drifting)).toContain('settle-determinism');
  });

  it('detects input mutation', () => {
    const mutating: Sim = {
      ...coinCollector,
      simulate(input) {
        (input.actors as CoinActor[]).reverse();
        return coinCollector.simulate(input);
      },
    };
    expect(rules(mutating)).toContain('input-mutation');
  });

  it('detects non-JSON timelines', () => {
    const nan: Sim = {
      ...coinCollector,
      simulate(input) {
        const t = coinCollector.simulate(input);
        return { ...t, segments: t.segments.map((s) => ({ ...s, events: [{ type: 'found', actorId: 'a', coins: Number.NaN }] })) };
      },
    };
    expect(rules(nan)).toContain('json');
  });

  it('detects broken resumption', () => {
    const restartsAtZero: Sim = {
      ...coinCollector,
      simulate: (input) => {
        const { from, ...rest } = input;
        return from === undefined ? coinCollector.simulate(rest) : coinCollector.simulate({ ...rest, budget: rest.budget });
      },
    };
    expect(rules(restartsAtZero)).toContain('resume');
  });

  it('reports thrown errors and bad fixtures instead of throwing', () => {
    const throwing: Sim = {
      ...coinCollector,
      simulate: () => {
        throw new Error('boom');
      },
    };
    const violations = checkSimulatorContract(throwing, fixtures);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.rule === 'threw' && /boom/.test(v.message))).toBe(true);
    expect(checkSimulatorContract(coinCollector, [{ ...fixtures[0], budget: 0 } as ContractFixture<CoinConfig, CoinActor>])[0]?.rule).toBe('fixture');
  });

  it('detects a parseConfig that does not round-trip', () => {
    const lossy: Sim = { ...coinCollector, parseConfig: () => ({ maxCoins: 1, hazardBp: 0 }) };
    expect(rules(lossy)).toContain('config-roundtrip');
  });

  it('checks the simulator identity', () => {
    expect(rules({ ...coinCollector, id: 'Coin Collector' })).toContain('identity');
    expect(rules({ ...coinCollector, version: '' })).toContain('identity');
  });

  it('applies settlement modes per reason', () => {
    // Leaks everything on cancel only: caught in default mode for `cancelled`, by the bound in custom mode.
    const leakOnCancel: Sim = {
      ...coinCollector,
      settle: (t, cutoff, reason) => (reason === 'cancelled' ? t.segments.flatMap((s) => s.deltas) : defaultSettle(t, cutoff)),
    };
    const perReason = checkSimulatorContract(leakOnCancel, fixtures, { settlement: { completed: 'custom', cancelled: 'default' } });
    expect(new Set(perReason.map((v) => v.rule))).toEqual(new Set(['settle-cutoff']));
    expect(perReason.every((v) => /cancelled/.test(v.message))).toBe(true);
    expect(rules(leakOnCancel, { settlement: 'custom' })).toEqual(new Set(['settle-bound']));
    expect(rules(leakOnCancel, { settlement: { cancelled: 'custom' } })).toEqual(new Set(['settle-bound']));
  });

  it('custom mode allows penalties but never extra gains', () => {
    const halved: Sim = {
      ...coinCollector,
      settle: (t, cutoff) => defaultSettle(t, cutoff).map((d) => ({ ...d, qty: d.qty - Math.floor(d.qty / 2) })),
    };
    const bonus: Sim = {
      ...coinCollector,
      settle: (t, cutoff) => [...defaultSettle(t, cutoff), { actorId: 'a', asset: COIN, qty: 1, to: 'run_bag' }],
    };
    expect(checkSimulatorContract(halved, fixtures)).toEqual([]);
    expect(rules(bonus)).toContain('settle-bound');
  });

  it('settlementBoundViolations: gains capped by the default, costs may shrink to zero but not turn into gains', () => {
    const ref = [
      { actorId: 'a', asset: COIN, qty: 5 },
      { actorId: 'a', asset: TORCH, qty: 2, from: 'escrow' },
    ];
    expect(settlementBoundViolations([{ actorId: 'a', asset: COIN, qty: 5 }], ref)).toEqual([]);
    expect(settlementBoundViolations([{ actorId: 'a', asset: COIN, qty: 6 }], ref)).toHaveLength(1);
    expect(settlementBoundViolations([{ actorId: 'a', asset: TORCH, qty: 1, to: 'inventory' }], ref)).toHaveLength(1);
    expect(settlementBoundViolations([{ actorId: 'b', asset: COIN, qty: 1 }], ref)).toHaveLength(1);
  });

  it('checks that a cancel after the end settles exactly like the natural end (cancel-after-end)', () => {
    let n = 0;
    const flaky: Sim = {
      ...coinCollector,
      settle: (t, cutoff, reason) => (reason === 'completed' && cutoff === t.segments.length - 1 && n++ % 4 === 2 ? [] : defaultSettle(t, cutoff)),
    };
    expect(rules(flaky, { settlement: 'custom' })).toContain('cancel-after-end');
    expect(rules(coinCollector)).not.toContain('cancel-after-end');
  });

  it('passes the fixture target (areaId/activityId) to simulate, including resumption', () => {
    const seen = new Set<string>();
    const targeted: Sim = {
      ...coinCollector,
      simulate(input) {
        seen.add(`${input.areaId ?? '-'}|${input.activityId ?? '-'}|${input.from === undefined ? 'fresh' : 'resumed'}`);
        return coinCollector.simulate(input);
      },
    };
    const fixture = { ...fixtures[0], areaId: 'area:mine', activityId: 'activity:dig' } as ContractFixture<CoinConfig, CoinActor>;
    expect(checkSimulatorContract(targeted, [fixture])).toEqual([]);
    expect(seen).toEqual(new Set(['area:mine|activity:dig|fresh', 'area:mine|activity:dig|resumed']));
  });

  it('checks escrow declaration and conservation', () => {
    const torchFixtures = fixtures.map((f) => ({ ...f }));
    expect(checkSimulatorContract(torchCollector, torchFixtures)).toEqual([]);
    const greedy: Sim = {
      ...torchCollector,
      settle: (t, cutoff) => [...defaultSettle(t, cutoff), { actorId: 'a', asset: TORCH, qty: 99, from: 'escrow' }],
    };
    expect(rules(greedy)).toContain('escrow');
    const malformed: Sim = { ...torchCollector, escrow: () => [{ actorId: 'a', asset: TORCH, qty: 1, to: 'escrow' }] };
    expect(rules(malformed)).toContain('escrow');
    let n = 0;
    const drifting: Sim = { ...torchCollector, escrow: () => [{ actorId: 'a', asset: TORCH, qty: ++n, from: 'inventory', to: 'escrow' }] };
    expect(rules(drifting)).toContain('escrow');
  });
});
