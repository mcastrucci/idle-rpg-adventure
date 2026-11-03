/** Region 2 compiled-content checks: route gate, durable completion rule, unlocked activity start, and real combat. */
import { fileURLToPath } from 'node:url';

import { checkStart } from '@engine/expedition-kernel';
import { BP_SCALE } from '@engine/sim-core';
import { evaluateCompletion, evaluateRequirement, poolLocations } from '@engine/world';
import type { EvalContext } from '@engine/world';
import { compileContent, loadContentFiles } from '@engine/content-compiler';
import plugin from '@rpg/content-plugin';
import { createRpgPredicateRegistry, EncounterTableSchema, EnemySchema, ItemSchema, LootTableSchema, SkillSchema } from '@rpg/rpg-schema';
import type { Enemy, EncounterTable, Item, LootTable, RpgGameContext, Skill } from '@rpg/rpg-schema';
import { describe, expect, it } from 'vitest';

import { createRpgActivityRegistry, createRpgIdleSimulators, rpgIdleContentFromBundle } from './index.ts';
import type { RpgActorSnapshot, RpgIdleConfig } from './index.ts';
import { idleConfig, bulwark, rpgContext } from './testing/region1.ts';

import { runToEnd } from '../index.ts';
import type { CombatContent, CombatEvent, HeroSetup } from '../index.ts';
import { ofType, rules } from '../combat/testing/fixtures.ts';

const ROOT = fileURLToPath(new URL('../../../../content/', import.meta.url));
const REGION_2 = 'area:region_2';
const REGION_1 = 'area:region_1';
const WARDEN = 'enemy:region_2.resonant_warden';

function compiled() {
  const result = compileContent(loadContentFiles(ROOT), plugin);
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  const c = result.bundle.collections;
  const byId = <T extends { id: string }>(list: readonly unknown[] | undefined, parse: (item: unknown) => T): Record<string, T> =>
    Object.fromEntries((list ?? []).map((item) => {
      const value = parse(item);
      return [value.id, value];
    }));
  const combat: CombatContent = {
    skills: byId<Skill>(c['skills'], (x) => SkillSchema.parse(x)),
    items: byId<Item>(c['items'], (x) => ItemSchema.parse(x)),
    enemies: byId<Enemy>(c['enemies'], (x) => EnemySchema.parse(x)),
  };
  return { bundle: result.bundle, combat, idle: rpgIdleContentFromBundle(result.bundle) };
}

function hero(combat: CombatContent, guarded: boolean): HeroSetup {
  const equipment = ['item:rusty_sword', 'item:padded_vest', 'item:wooden_buckler'].map((id) => {
    const item = combat.items[id];
    if (item?.kind !== 'equipment') throw new Error(`${id} must be equipment`);
    return item;
  });
  return {
    id: 'hero:region2_test',
    build: { level: 4, attributes: { STR: 12, AGI: 4, INT: 2, VIT: 16, SPI: 8 }, equipment },
    skills: ['skill:basic_attack', 'skill:guard'],
    rules: rules([
      ...(guarded ? [{ when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } }] : []),
      { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
    ]),
  };
}

describe('Region 2 authored content (compiled bundle)', () => {
  it('requires the character’s own Region 1 completion and the R2 discovery threshold plus Warden victory', () => {
    const { bundle } = compiled();
    const world = bundle.world;
    const route = world.routes.find((r) => r.id === 'route:sanctuary_to_region_2');
    const area = world.areas.find((a) => a.id === REGION_2);
    if (!route?.requires || !area?.completion) throw new Error('R2 route and completion must be authored');
    expect(area.activities).toEqual(['idle:region_2.gather', 'idle:region_2.hunt']);
    const predicates = createRpgPredicateRegistry();
    const locked: EvalContext<RpgGameContext> = rpgContext();
    const conqueredR1: EvalContext<RpgGameContext> = rpgContext({ completedAreas: [REGION_1] });
    expect(evaluateRequirement(route.requires, locked, predicates).ok).toBe(false);
    expect(evaluateRequirement(route.requires, conqueredR1, predicates).ok).toBe(true);

    const ordinary = area.locations.filter((id) => world.locations.find((loc) => loc.id === id)?.tags.includes('ordinary'));
    expect(ordinary).toHaveLength(4);
    expect(area.completion.thresholdBp).toBe(7000);
    const three = ordinary.slice(0, 3);
    const beforeBoss = rpgContext({ discovered: { [REGION_2]: three } });
    const afterBoss = rpgContext({ discovered: { [REGION_2]: three } }, [WARDEN]);
    expect(evaluateCompletion(area, world.locations, beforeBoss, predicates)).toMatchObject({ requiredCount: 3, completed: false, requiredMet: false });
    expect(evaluateCompletion(area, world.locations, afterBoss, predicates)).toMatchObject({ requiredCount: 3, completed: true, requiredMet: true });

    const encounterTables = ((bundle.collections['encounterTables'] ?? []) as unknown[]).map((entry) => EncounterTableSchema.parse(entry)) as EncounterTable[];
    const lootTables = ((bundle.collections['lootTables'] ?? []) as unknown[]).map((entry) => LootTableSchema.parse(entry)) as LootTable[];
    const hunt = encounterTables.find((table) => table.id === 'enc:region_2.hunt');
    expect(hunt?.entries.flatMap((entry) => entry.enemies).some((entry) => entry.enemy === WARDEN)).toBe(false);
    const bossLoot = lootTables.find((table) => table.id === 'loot:region_2.warden');
    expect(bossLoot?.entries.map((entry) => entry.item).sort()).toEqual(['item:choirglass_blade', 'item:resonance_buckler']);
    expect(bossLoot?.guaranteed?.map((entry) => entry.item)).toEqual(['item:warden_signal']);
  });

  it('lets the R2 idle activities start only after the same area completion rule is satisfied', () => {
    const { bundle, idle } = compiled();
    const simulators = createRpgIdleSimulators(idle);
    const activities = createRpgActivityRegistry(idle);
    const actors: RpgActorSnapshot[] = [bulwark(4)];
    const predicates = createRpgPredicateRegistry();
    const area = bundle.world.areas.find((a) => a.id === REGION_2);
    if (area?.completion === undefined) throw new Error('R2 area has no completion rule');
    const pool = poolLocations(area, area.completion, bundle.world.locations);
    const three = pool.slice(0, 3);
    const beforeRequiredBoss = rpgContext({ discovered: { [REGION_2]: three } });
    const afterRequiredBoss = rpgContext({ discovered: { [REGION_2]: three } }, [WARDEN], 4);

    for (const { activityId, kind, simulator } of [
      { activityId: 'idle:region_2.gather', kind: 'gather', simulator: simulators.gather },
      { activityId: 'idle:region_2.hunt', kind: 'hunt', simulator: simulators.hunt },
    ] as const) {
      expect(activities.get(activityId)?.id).toBe(`rpg.${kind}`);
      const request = { areaId: REGION_2 as 'area:region_2', activityId, durationMin: 15, paceBp: BP_SCALE };
      const gate = (ctx: EvalContext<RpgGameContext>) => checkStart<RpgIdleConfig, RpgActorSnapshot, RpgGameContext>({
        world: bundle.world,
        request,
        activities,
        simulator,
        rawConfig: idleConfig(0),
        actors,
        evalContexts: [ctx],
        predicates,
      });
      expect(gate(beforeRequiredBoss).ok).toBe(false);
      expect(gate(afterRequiredBoss).ok).toBe(true);
    }
  });

  it('runs deterministic Warden combat from compiled content with a visible guard response window', () => {
    const { combat } = compiled();
    const makeSetup = (guarded: boolean) => ({
      heroes: [hero(combat, guarded)],
      enemies: [{ id: 'enemy:warden', enemy: WARDEN }],
      content: combat,
    });
    const guarded = runToEnd(makeSetup(true), 29, undefined, 3000);
    const replay = runToEnd(makeSetup(true), 29, undefined, 3000);
    const unguarded = runToEnd(makeSetup(false), 29, undefined, 3000);
    expect(replay.events).toEqual(guarded.events);
    expect(guarded.outcome).not.toBe('timeout');
    const telegraph = ofType(guarded.events, 'TelegraphStarted').find((event) => event.skill === 'skill:region_2.signal_pulse');
    expect(telegraph).toBeDefined();
    const start = guarded.events.findIndex((event) => event === telegraph);
    const response = guarded.events.findIndex((event, index) => index > start && event.type === 'ActionStarted' && event.actorId === 'hero:region2_test' && event.action.kind === 'skill' && event.action.skill === 'skill:guard');
    const resolution = guarded.events.findIndex((event, index) => index > start && event.type === 'DamageDealt' && event.origin === 'skill:region_2.signal_pulse');
    expect(response).toBeGreaterThan(start);
    expect(resolution).toBeGreaterThan(response);
    const signalHit = (events: readonly CombatEvent[]) => events.find((event): event is Extract<CombatEvent, { type: 'DamageDealt' }> => event.type === 'DamageDealt' && event.origin === 'skill:region_2.signal_pulse');
    const guardedHit = signalHit(guarded.events);
    const unguardedHit = signalHit(unguarded.events);
    expect(guardedHit).toBeDefined();
    expect(unguardedHit).toBeDefined();
    if (!guardedHit || !unguardedHit) throw new Error('expected the Warden signal to resolve in both fights');
    expect(guardedHit.amount).toBeLessThan(unguardedHit.amount);
  });
});
