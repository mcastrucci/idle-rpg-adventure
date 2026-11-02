/**
 * Config, start checks, budget, escrow, the activity registry and the kernel's start gating with the Region 1 world.
 */
import { checkStart, unregisteredActivities } from '@engine/expedition-kernel';
import type { StartRequest } from '@engine/expedition-kernel';
import { BP_SCALE } from '@engine/sim-core';
import { poolLocations } from '@engine/world';
import type { Location } from '@engine/world';
import { createRpgPredicateRegistry } from '@rpg/rpg-schema';
import type { RpgGameContext } from '@rpg/rpg-schema';
import { describe, expect, it } from 'vitest';

import { ENGINE_VERSION } from '../version.ts';
import {
  ESCROW,
  INVENTORY,
  RPG_IDLE_SIMULATOR_VERSION,
  RPG_IDLE_VERSION,
  createRpgActivityRegistry,
  idleKindOf,
  parseRpgIdleConfig,
} from './index.ts';
import type { RpgActorSnapshot, RpgIdleConfig } from './index.ts';
import { sims } from './testing/fixtures.ts';
import { GATHER, HUNT, POTION, REGION_1, bulwark, idleConfig, region1, rpgContext, thornblade } from './testing/region1.ts';

const { bundle, content } = region1();
const { hunt, gather } = sims();

describe('identity and mapping rule', () => {
  it('uses <game>.<name> IDs and a version tied to the combat engine', () => {
    expect(hunt.id).toBe('rpg.hunt');
    expect(gather.id).toBe('rpg.gather');
    expect(hunt.version).toBe(RPG_IDLE_SIMULATOR_VERSION);
    expect(RPG_IDLE_SIMULATOR_VERSION).toBe(`${RPG_IDLE_VERSION}+${ENGINE_VERSION}`);
  });

  it('maps activities by the last ID segment', () => {
    expect(idleKindOf('idle:region_1.hunt')).toBe('hunt');
    expect(idleKindOf('idle:region_1.gather')).toBe('gather');
    expect(idleKindOf('idle:hunt')).toBe('hunt');
    expect(idleKindOf('idle:region_1.fish')).toBeNull();
    expect(idleKindOf('idle:region_1.hunter')).toBeNull();
  });

  it('registers every content idle activity, and every area activity has a simulator', () => {
    const registry = createRpgActivityRegistry(bundle);
    expect(registry.activityIds()).toEqual(['idle:region_1.gather', 'idle:region_1.hunt', 'idle:test_grove.hunt']);
    expect(registry.get(HUNT)?.id).toBe('rpg.hunt');
    expect(registry.get(GATHER)?.id).toBe('rpg.gather');
    expect(registry.get('idle:test_grove.hunt')?.id).toBe('rpg.hunt');
    expect(unregisteredActivities(bundle.world, registry)).toEqual([]);
  });
});

describe('config', () => {
  const valid: RpgIdleConfig = idleConfig(3, { belowHpBp: 3000 });

  it('parses valid configs (round-trip) and rejects invalid ones', () => {
    expect(hunt.parseConfig(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    const bad: unknown[] = [
      null,
      { ...valid, durationMin: 60 }, // kernel-owned
      { ...valid, activity: HUNT }, // kernel-owned since rpg-idle@2.0.0 (start request activityId)
      { ...valid, consumables: [{ item: 'item:glowcap', qty: 1 }] }, // not a consumable
      { ...valid, consumables: [{ item: POTION, qty: 0 }] },
      { ...valid, consumables: [{ item: POTION, qty: 1.5 }] },
      { ...valid, consumables: [{ item: POTION, qty: 1 }, { item: POTION, qty: 1 }] },
      { ...valid, retreat: { belowHpBp: 10_001, onlyWhenNoHealing: true } },
      { ...valid, retreat: { belowHpBp: 100 } },
      { ...valid, extra: 1 },
    ];
    for (const input of bad) expect(() => parseRpgIdleConfig(input, content)).toThrow();
    expect(gather.parseConfig(idleConfig(0))).toEqual(idleConfig(0));
  });
});

describe('canStart, budget and escrow', () => {
  const start = (actors: RpgActorSnapshot[], config = idleConfig(2), durationMin = 60) =>
    hunt.canStart({ config, actors, durationMin, paceBp: BP_SCALE, areaId: REGION_1, activityId: HUNT });

  it('accepts valid starts and rejects invalid durations, actors and rules', () => {
    expect(start([bulwark(3)])).toEqual({ ok: true });
    expect(start([bulwark(3)], idleConfig(2), 45)).toMatchObject({ ok: false, code: 'rpg.invalidDuration' });
    expect(start([])).toMatchObject({ ok: false, code: 'rpg.noActors' });
    expect(start([bulwark(3), bulwark(4)])).toMatchObject({ ok: false, code: 'rpg.invalidActor' }); // duplicate ID
    expect(start([bulwark(3, { hp: 0 })])).toMatchObject({ ok: false, code: 'rpg.invalidActor' });
    expect(start([bulwark(3, { hp: 100_000 })])).toMatchObject({ ok: false, code: 'rpg.invalidActor' });
    expect(start([bulwark(3, { skills: ['skill:basic_attack'] })])).toMatchObject({ ok: false, code: 'rpg.invalidActor' }); // rules use unequipped skills
    expect(start([bulwark(3, { skills: ['skill:nope'], rules: [] })])).toMatchObject({ ok: false, code: 'rpg.invalidActor' });
    expect(
      start([thornblade(3, { rules: [{ when: {}, do: { useConsumable: 'item:glowcap' } }, ...thornblade(3).rules.slice(1)] })]),
    ).toMatchObject({ ok: false, code: 'rpg.invalidActor' });
    expect(start([bulwark(3)], { ...idleConfig(0), consumables: [{ item: 'item:glowcap', qty: 1 }] })).toMatchObject({
      ok: false,
      code: 'rpg.invalidConsumable',
    });
    const direct = (activityId?: string) =>
      gather.canStart({ config: idleConfig(0), actors: [bulwark(3)], durationMin: 60, paceBp: BP_SCALE, ...(activityId === undefined ? {} : { activityId }) });
    expect(direct(HUNT)).toMatchObject({ ok: false, code: 'rpg.activityKindMismatch' });
    expect(direct('idle:region_1.nope')).toMatchObject({ ok: false, code: 'rpg.unknownActivity' });
    expect(direct()).toMatchObject({ ok: false, code: 'rpg.noActivity' });
    expect(direct(GATHER)).toEqual({ ok: true });
  });

  it('simulate needs the kernel-owned activityId of its kind', () => {
    const input = { config: idleConfig(0), actors: [bulwark(3)], seed: 1, budget: 2 };
    expect(() => hunt.simulate(input)).toThrow(/activityId/);
    expect(() => hunt.simulate({ ...input, activityId: GATHER })).toThrow(/not a hunt activity/);
    expect(hunt.simulate({ ...input, activityId: HUNT }).segments.length).toBeGreaterThan(0);
  });

  it('budget = ⌊segmentsPerHour × durationMin × paceBp / 600000⌋, at least 1 (activity = kernel-owned target)', () => {
    const c = idleConfig(0);
    const h = { areaId: REGION_1, activityId: HUNT } as const;
    const g = { areaId: REGION_1, activityId: GATHER } as const;
    expect([15, 30, 60, 180].map((m) => hunt.budget(c, m, BP_SCALE, h))).toEqual([7, 15, 30, 90]);
    expect([15, 30, 60, 180].map((m) => gather.budget(c, m, BP_SCALE, g))).toEqual([2, 5, 10, 30]);
    expect(hunt.budget(c, 60, 12_500, h)).toBe(37); // 37.5 floored
    expect(gather.budget(c, 1, BP_SCALE, g)).toBe(1);
    expect(() => hunt.budget(c, 60, BP_SCALE)).toThrow(/activityId/);
  });

  it('escrows the configured consumables per actor, inventory → escrow', () => {
    expect(hunt.escrow?.(idleConfig(3), [thornblade(2), bulwark(2)])).toEqual([
      { actorId: 'char:bulwark', asset: { kind: 'stack', item: POTION }, qty: 3, from: INVENTORY, to: ESCROW },
      { actorId: 'char:thornblade', asset: { kind: 'stack', item: POTION }, qty: 3, from: INVENTORY, to: ESCROW },
    ]);
    expect(hunt.escrow?.(idleConfig(0), [bulwark(2)])).toEqual([]);
  });
});

describe('kernel start gating (checkStart) with the Region 1 world', () => {
  const world = bundle.world;
  const predicates = createRpgPredicateRegistry();
  const activities = createRpgActivityRegistry(content);
  const request = (over: Partial<StartRequest> = {}): StartRequest => ({
    areaId: 'area:region_1',
    activityId: HUNT,
    durationMin: 60,
    paceBp: BP_SCALE,
    ...over,
  });
  const gate = (ctx = rpgContext(), req = request(), config: unknown = idleConfig(2)) =>
    checkStart<RpgIdleConfig, RpgActorSnapshot, RpgGameContext>({
      world,
      request: req,
      activities,
      simulator: req.activityId === GATHER ? gather : hunt,
      rawConfig: config,
      actors: [bulwark(4)],
      evalContexts: [ctx],
      predicates,
    });

  it('refuses an area that is not completed, with reasons', () => {
    expect(gate()).toMatchObject({
      ok: false,
      code: 'start.areaNotCompleted',
      reasons: ['completion.discoveries:area:region_1', 'requires.game.defeated:enemy:hollow_matriarch'],
    });
  });

  it('starts once the area is completed (recorded, or discoveries + mini-boss) and returns budget and escrow', () => {
    const escrow = [{ actorId: 'char:bulwark', asset: { kind: 'stack', item: POTION }, qty: 2, from: INVENTORY, to: ESCROW }];
    expect(gate(rpgContext({ completedAreas: ['area:region_1'] }))).toEqual({ ok: true, config: idleConfig(2), budget: 30, escrow });
    const area = world.areas.find((a) => a.id === 'area:region_1');
    if (area?.completion === undefined) throw new Error('region_1 has no completion rule');
    const pool = poolLocations(area, area.completion, world.locations as Location[]);
    const conquered = rpgContext({ discovered: { 'area:region_1': pool } }, ['enemy:hollow_matriarch'], 4);
    expect(gate(conquered)).toEqual({ ok: true, config: idleConfig(2), budget: 30, escrow });
    expect(gate(conquered, request({ activityId: GATHER, durationMin: 180 }), idleConfig(2))).toEqual({ ok: true, config: idleConfig(2), budget: 30, escrow });
  });

  it('refuses mismatched activities and simulators', () => {
    const done = rpgContext({ completedAreas: ['area:region_1'] });
    expect(gate(done, request({ activityId: 'idle:test_grove.hunt' }))).toMatchObject({ ok: false, code: 'start.activityNotInArea' });
    expect(gate(done, request({ durationMin: 45 }))).toMatchObject({ ok: false, code: 'rpg.invalidDuration' });
    // The activity comes from the request only (kernel 0.3): a config still carrying one is invalid, never trusted.
    expect(gate(done, request(), { ...idleConfig(0), activity: 'idle:test_grove.hunt' })).toMatchObject({ ok: false, code: 'start.invalidConfig' });
    expect(gate(done, request(), { consumables: 'none' })).toMatchObject({ ok: false, code: 'start.invalidConfig' });
  });
});
