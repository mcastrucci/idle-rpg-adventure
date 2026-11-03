import { describe, expect, it } from 'vitest';
import { applyBagLoss } from '@rpg/rpg-sim';

import { renderRuntimePass, renderRuntimePassStarterKitComparison, resolveStarterKit, runRuntimePass, runRuntimePassStarterKitComparison, summarizeRetainedBag } from './runtime-pass.ts';

describe('bounded runtime evidence pass', () => {
  it('replays deterministic production-path cells with explicit policy denominators', () => {
    const first = runRuntimePass({ runs: 4 });
    const second = runRuntimePass({ runs: 4 });
    expect(renderRuntimePass(first)).toBe(renderRuntimePass(second));
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.idleSimulatorVersion).toBe('rpg-idle@2.0.0+rpg-sim@1.1.0');
    expect(first.rows).toHaveLength(12);
    expect(first.rows.map(({ model, level, carriedPotions }) => [model, level, carriedPotions])).toEqual(
      ['idle-default-regen', 'idle-no-regen-counterfactual'].flatMap((model) =>
        [1, 3, 5].flatMap((level) => [0, 5].map((potions) => [model, level, potions]))),
    );
    const levelOneNoSupplies = first.rows.find((row) => row.model === 'idle-default-regen' && row.level === 1 && row.carriedPotions === 0);
    const levelOneWithSupplies = first.rows.find((row) => row.model === 'idle-default-regen' && row.level === 1 && row.carriedPotions === 5);
    expect(levelOneNoSupplies).toMatchObject({ timeouts: 0, meanPotionsUsed: 0 });
    expect(levelOneWithSupplies?.meanPotionsUsed).toBeGreaterThan(0);
    expect(levelOneWithSupplies?.meanPotionsUsed).toBeLessThanOrEqual(5);
    expect(first.rows.some((row) => row.deaths > 0 && row.netXpPerRequestedHour < row.grossXpPerRequestedHour)).toBe(true);
    expect(levelOneNoSupplies?.meanGoldRetained).toBeGreaterThan(0);
    expect(Object.keys(levelOneNoSupplies?.meanItemsRetained ?? {}).length).toBeGreaterThan(0);
    expect(first.plannedBudget).toBe(30);
  });

  it('keeps the no-argument report on the historical naked 100-run seed-56 mode', () => {
    const report = runRuntimePass();
    expect(report).toMatchObject({ seedRoot: 56, runsPerCell: 100,
      command: 'node games/rpg/tools/balance-sim/src/runtime-pass.ts', contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(report.rows).toHaveLength(12);
  }, 20_000);

  it('keeps death-loss odd units and excludes an escrowed consumable burn from retained loot', () => {
    const settled = applyBagLoss([
      { actorId: 'hero', asset: { kind: 'currency', currency: 'gold' }, qty: 5 },
      { actorId: 'hero', asset: { kind: 'stack', item: 'item:raw_meat' }, qty: 3, to: 'inventory' },
      { actorId: 'hero', asset: { kind: 'stack', item: 'item:minor_healing_potion' }, qty: 1, from: 'escrow' },
    ], 5000);
    expect(summarizeRetainedBag(settled)).toEqual({ gold: 3, items: { 'item:raw_meat': 2 } });
  });

  it('resolves the three production starter items from validated content and rejects missing or wrong-slot gear', () => {
    const report = runRuntimePassStarterKitComparison({ runs: 1 });
    expect(report.equipment.map(({ id, slot }) => [id, slot])).toEqual([
      ['item:rusty_sword', 'weapon'], ['item:padded_vest', 'chest'], ['item:wooden_buckler', 'offhand'],
    ]);
    expect(report.equipment.every(item => Object.keys(item.stats).length > 0)).toBe(true);
    expect(() => resolveStarterKit([])).toThrow(/starter kit item item:rusty_sword/);
    expect(() => resolveStarterKit([
      { id: 'item:rusty_sword', kind: 'equipment', slot: 'chest', value: 0, stats: {}, stackable: false },
    ])).toThrow(/not in slot weapon/);
  });

  it('creates deterministic paired naked and starter-kit idle rows for each level, supply, and regen mode', () => {
    const first = runRuntimePassStarterKitComparison({ runs: 2 });
    const second = runRuntimePassStarterKitComparison({ runs: 2 });
    expect(renderRuntimePassStarterKitComparison(first)).toBe(renderRuntimePassStarterKitComparison(second));
    expect(first.rows).toHaveLength(12);
    expect(first.rows.every(row => row.naked.level === row.starterKit.level &&
      row.naked.carriedPotions === row.starterKit.carriedPotions && row.naked.runs === 2 && row.starterKit.runs === 2)).toBe(true);
    expect(first.rows.map(row => [row.model, row.level, row.carriedPotions])).toEqual(
      ['idle-default-regen', 'idle-no-regen-counterfactual'].flatMap(model => [1, 3, 5].flatMap(level => [0, 5].map(p => [model, level, p]))));
    const noSupplyL1 = first.rows.find(row => row.model === 'idle-default-regen' && row.level === 1 && row.carriedPotions === 0);
    expect(noSupplyL1?.starterKit.meanCombatTicks).not.toBe(noSupplyL1?.naked.meanCombatTicks);
    expect(runRuntimePass({ runs: 1 }).rows).toHaveLength(12);
  });
});
