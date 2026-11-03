import { describe, expect, it } from 'vitest';
import { applyBagLoss } from '@rpg/rpg-sim';

import { renderRuntimePass, runRuntimePass, summarizeRetainedBag } from './runtime-pass.ts';

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

  it('keeps death-loss odd units and excludes an escrowed consumable burn from retained loot', () => {
    const settled = applyBagLoss([
      { actorId: 'hero', asset: { kind: 'currency', currency: 'gold' }, qty: 5 },
      { actorId: 'hero', asset: { kind: 'stack', item: 'item:raw_meat' }, qty: 3, to: 'inventory' },
      { actorId: 'hero', asset: { kind: 'stack', item: 'item:minor_healing_potion' }, qty: 1, from: 'escrow' },
    ], 5000);
    expect(summarizeRetainedBag(settled)).toEqual({ gold: 3, items: { 'item:raw_meat': 2 } });
  });
});
