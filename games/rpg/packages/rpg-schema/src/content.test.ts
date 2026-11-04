import { describe, expect, it } from 'vitest';

import {
  AutomationRulesSchema,
  EFFECT_TYPES,
  EffectSchema,
  EnemySchema,
  EncounterTableSchema,
  IdleActivitySchema,
  ItemSchema,
  MerchantSchema,
  LootTableSchema,
  MAX_AUTOMATION_RULES,
  ResourceNodeSchema,
  SkillSchema,
  XpCurveSchema,
  CappedXpCurveSchema,
  isBoss,
  maxLevel,
} from './index.ts';
import {
  boarLoot,
  crushingBlow,
  glowcap,
  hollowMatriarch,
  huntActivity,
  issuePaths,
  minorHealingPotion,
  rustySword,
  shieldBash,
  specAutomationRules,
  thornbackBoar,
  wellEncounters,
  xpCurve,
} from './testing/examples.ts';

describe('valid examples', () => {
  it('parses explicit merchant buy prices and infinite stock', () => {
    const merchant = MerchantSchema.parse({ id: 'merchant:region_1', offers: [
      { id: 'offer:minor_healing_potion', item: 'item:minor_healing_potion', buyPrice: { currency: 'gold', amount: 12 } },
    ] });
    expect(merchant.offers[0]).toMatchObject({ buyPrice: { currency: 'gold', amount: 12 }, stock: 'infinite' });
    expect(MerchantSchema.safeParse({ id: 'merchant:region_1', offers: [
      { id: 'offer:pot', item: 'item:minor_healing_potion', buyPrice: { currency: 'gold', amount: 0 } },
    ] }).success).toBe(false);
    expect(MerchantSchema.safeParse({ id: 'merchant:region_1', offers: [
      { id: 'offer:pot', item: 'item:minor_healing_potion', buyPrice: { currency: 'gold', amount: 2_147_483_648 } },
    ] }).success).toBe(false);
  });

  it('parses skill:shield_bash from the content-format spec', () => {
    const skill = SkillSchema.parse(shieldBash);
    expect(skill.id).toBe('skill:shield_bash');
    expect(skill.effects).toEqual([
      { type: 'damage', coeffBp: 8000, school: 'physical', to: 'target' },
      { type: 'taunt', duration: { value: 3, unit: 'attacks' }, to: 'target' },
    ]);
    expect(skill.tags).toEqual([]);
    expect(SkillSchema.parse(crushingBlow).windupTicks).toBe(3);
  });

  it('parses one effect of every type', () => {
    const d = { value: 3, unit: 'ticks' } as const;
    const effects = [
      { type: 'damage', coeffBp: 10000, school: 'magic' },
      { type: 'heal', coeffBp: 5000 },
      { type: 'shield', coeffBp: 4000, duration: d, to: 'self' },
      { type: 'dot', coeffBp: 1500, school: 'physical', duration: d },
      { type: 'hot', coeffBp: 1000, periodTicks: 2, duration: { value: 4, unit: 'actions' } },
      { type: 'stat_mod', stat: 'armor', deltaBp: -2000, duration: d },
      { type: 'stat_mod', stat: 'power', flat: 5, duration: d },
      { type: 'taunt', duration: { value: 3, unit: 'attacks' } },
      { type: 'stun', duration: d },
      { type: 'cleanse' },
    ];
    for (const effect of effects) expect(EffectSchema.safeParse(effect).success, JSON.stringify(effect)).toBe(true);
    expect(new Set(effects.map((e) => e.type))).toEqual(new Set(EFFECT_TYPES));
    expect(EffectSchema.parse(effects[3])).toMatchObject({ type: 'dot', periodTicks: 1 });
  });

  it('parses the automation rules from combat-engine §6', () => {
    expect(AutomationRulesSchema.parse(specAutomationRules)).toHaveLength(5);
  });

  it('parses items, enemies, bosses, tables, nodes, activities and the xp curve', () => {
    expect(ItemSchema.parse(minorHealingPotion).kind).toBe('consumable');
    expect(ItemSchema.parse(rustySword)).toMatchObject({ kind: 'equipment', stackable: false, tags: [] });
    expect(ItemSchema.parse({ id: 'item:rope', kind: 'material', value: 2, stackable: true, maxStack: 10 }).kind).toBe('material');
    expect(ItemSchema.parse({ id: 'item:well_key', kind: 'quest', value: 0, stackable: false }).kind).toBe('quest');

    const boar = EnemySchema.parse(thornbackBoar);
    expect(isBoss(boar)).toBe(false);
    const boss = EnemySchema.parse(hollowMatriarch);
    expect(isBoss(boss) && boss.phases).toHaveLength(2);

    const loot = LootTableSchema.parse(boarLoot);
    expect(loot.entries[1]?.qty).toEqual({ min: 1, max: 1 });
    expect(loot.guaranteed[0]?.qty).toEqual({ min: 1, max: 1 });
    expect(EncounterTableSchema.parse(wellEncounters).entries[0]?.enemies[0]?.count).toBe(1);
    expect(ResourceNodeSchema.parse(glowcap).gatherTicks).toBe(6);
    expect(IdleActivitySchema.parse(huntActivity).encountersPerHour).toBe(12);
    expect(maxLevel(XpCurveSchema.parse(xpCurve))).toBeNull(); // open-ended (#129)
    expect(maxLevel({ xpToNext: xpCurve.xpToNext })).toBe(6); // capped legacy shape
  });
});

describe('invalid fixtures fail with useful paths', () => {
  it('rejects a float coeffBp', () => {
    const bad = { ...shieldBash, effects: [{ type: 'damage', coeffBp: 8000.5, school: 'physical' }] };
    expect(issuePaths(SkillSchema, bad)).toEqual(['effects.0.coeffBp']);
  });

  it('rejects an unknown effect type', () => {
    const bad = { ...shieldBash, effects: [shieldBash.effects[0], { type: 'teleport' }] };
    expect(issuePaths(SkillSchema, bad)).toEqual(['effects.1.type']);
  });

  it('rejects a bad duration unit', () => {
    const bad = { ...shieldBash, effects: [{ type: 'taunt', duration: { value: 3, unit: 'seconds' } }] };
    expect(issuePaths(SkillSchema, bad)).toEqual(['effects.0.duration.unit']);
  });

  it('rejects non-positive or float durations', () => {
    expect(issuePaths(EffectSchema, { type: 'stun', duration: { value: 0, unit: 'ticks' } })).toEqual(['duration.value']);
    expect(issuePaths(EffectSchema, { type: 'stun', duration: { value: 1.5, unit: 'ticks' } })).toEqual(['duration.value']);
  });

  it('rejects wrong ID prefixes', () => {
    expect(issuePaths(SkillSchema, { ...shieldBash, id: 'item:shield_bash' })).toEqual(['id']);
    expect(issuePaths(EnemySchema, { ...thornbackBoar, lootTable: 'item:boar_common' })).toEqual(['lootTable']);
    expect(issuePaths(EncounterTableSchema, { id: 'enc:x', entries: [{ weight: 1, enemies: [{ enemy: 'skill:boar' }] }] })).toEqual([
      'entries.0.enemies.0.enemy',
    ]);
    const result = SkillSchema.safeParse({ ...shieldBash, id: 'skill:Shield-Bash' });
    expect(result.error?.issues[0]?.message).toBe('must be a namespaced ID like "skill:name"');
  });

  it('rejects stat_mod with both or neither of deltaBp/flat, and unknown stats', () => {
    const d = { value: 1, unit: 'ticks' };
    expect(issuePaths(EffectSchema, { type: 'stat_mod', stat: 'power', deltaBp: 100, flat: 1, duration: d })).toEqual(['deltaBp']);
    expect(issuePaths(EffectSchema, { type: 'stat_mod', stat: 'power', duration: d })).toEqual(['deltaBp']);
    expect(issuePaths(EffectSchema, { type: 'stat_mod', stat: 'luck', flat: 1, duration: d })).toEqual(['stat']);
  });

  it('rejects unknown fields (strict schemas)', () => {
    expect(issuePaths(SkillSchema, { ...shieldBash, cooldown: 3 })).toEqual(['']);
  });

  it('rejects a non-increasing xp curve', () => {
    const tailGrowthBp = 12_500;
    expect(issuePaths(XpCurveSchema, { xpToNext: [100, 250, 250, 700], tailGrowthBp })).toEqual(['xpToNext.2']);
    expect(issuePaths(XpCurveSchema, { xpToNext: [100, 90], tailGrowthBp })).toEqual(['xpToNext.1']);
    expect(issuePaths(XpCurveSchema, { xpToNext: [100, 150.5], tailGrowthBp })).toEqual(['xpToNext.1']);
    expect(issuePaths(CappedXpCurveSchema, { xpToNext: [100, 90] })).toEqual(['xpToNext.1']);
  });

  it('requires a tail that grows the last table entry (#129)', () => {
    expect(issuePaths(XpCurveSchema, { xpToNext: [100, 250] })).toEqual(['tailGrowthBp']);
    expect(issuePaths(XpCurveSchema, { xpToNext: [100, 250], tailGrowthBp: 10_000 })).toEqual(['tailGrowthBp']);
    expect(issuePaths(XpCurveSchema, { xpToNext: [100, 250], tailGrowthBp: 100_001 })).toEqual(['tailGrowthBp']);
    expect(issuePaths(XpCurveSchema, { xpToNext: [100, 250], tailGrowthBp: 1.5 })).toEqual(['tailGrowthBp']);
    // 250 x 1.0001 floors back to 250: not strictly increasing.
    expect(issuePaths(XpCurveSchema, { xpToNext: [100, 250], tailGrowthBp: 10_001 })).toEqual(['tailGrowthBp']);
    expect(issuePaths(XpCurveSchema, { xpToNext: [100, 250], tailGrowthBp: 10_040 })).toEqual([]);
  });

  it(`rejects more than ${MAX_AUTOMATION_RULES} automation rules`, () => {
    const fallback = { when: {}, do: { useSkill: 'skill:basic_attack' } };
    const result = AutomationRulesSchema.safeParse(Array.from({ length: MAX_AUTOMATION_RULES + 1 }, () => fallback));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/at most 6 automation rules/);
    expect(AutomationRulesSchema.safeParse(Array.from({ length: MAX_AUTOMATION_RULES }, () => fallback)).success).toBe(true);
  });

  it('rejects unknown rule conditions, actions and targets', () => {
    expect(issuePaths(AutomationRulesSchema, [{ when: { moonIsFull: true }, do: { useSkill: 'skill:a' } }])).toEqual(['0.when']);
    expect(issuePaths(AutomationRulesSchema, [{ when: { selfHpBelowBp: 12000 }, do: { useSkill: 'skill:a' } }])).toEqual([
      '0.when.selfHpBelowBp',
    ]);
    expect(issuePaths(AutomationRulesSchema, [{ when: {}, do: { flee: true } }])).toEqual(['0.do']);
    expect(issuePaths(AutomationRulesSchema, [{ when: {}, do: { useSkill: 'skill:a', target: 'randomAlly' } }])).toEqual(['0.do']);
  });

  it('selfHasHarmfulEffect: accepted (only `true`) in automation and enemy AI rules', () => {
    const cleanse = { when: { selfHasHarmfulEffect: true }, do: { useSkill: 'skill:second_wind' } };
    expect(AutomationRulesSchema.parse([cleanse])[0]?.when.selfHasHarmfulEffect).toBe(true);
    expect(issuePaths(AutomationRulesSchema, [{ ...cleanse, when: { selfHasHarmfulEffect: false } }])).toEqual([
      '0.when.selfHasHarmfulEffect',
    ]);
    const boar = { ...thornbackBoar, ai: [{ when: { selfHasHarmfulEffect: true }, do: { useSkill: 'skill:gore' } }, ...thornbackBoar.ai] };
    expect(EnemySchema.safeParse(boar).success).toBe(true);
  });

  it('guard / negatedByGuard: accepted on guards and attack stuns, rejected elsewhere', () => {
    const d = { value: 1, unit: 'attacks' } as const;
    const guardedBlow = {
      ...crushingBlow,
      effects: [crushingBlow.effects[0], { type: 'stun', duration: { value: 2, unit: 'ticks' }, negatedByGuard: true }],
    };
    expect(SkillSchema.parse(guardedBlow).effects[1]).toMatchObject({ type: 'stun', negatedByGuard: true, to: 'target' });
    expect(EffectSchema.safeParse({ type: 'stat_mod', stat: 'armor', flat: 150, duration: d, guard: true }).success).toBe(true);
    expect(EffectSchema.safeParse({ type: 'shield', coeffBp: 5000, duration: d, guard: true }).success).toBe(true);

    // Only `true`; only on shields and beneficial stat_mods; negatedByGuard only on target stuns of attack skills.
    expect(issuePaths(EffectSchema, { type: 'shield', coeffBp: 5000, duration: d, guard: false })).toEqual(['guard']);
    expect(issuePaths(EffectSchema, { type: 'stat_mod', stat: 'armor', flat: -5, duration: d, guard: true })).toEqual(['guard']);
    expect(issuePaths(EffectSchema, { type: 'hot', coeffBp: 5000, duration: d, guard: true })).toEqual(['']);
    expect(issuePaths(EffectSchema, { type: 'dot', coeffBp: 5000, school: 'magic', duration: d, negatedByGuard: true })).toEqual(['']);
    expect(issuePaths(EffectSchema, { type: 'stun', duration: d, negatedByGuard: true, to: 'self' })).toEqual(['negatedByGuard']);
    const selfStun = { ...guardedBlow, targeting: 'self', effects: [guardedBlow.effects[1]] };
    expect(issuePaths(SkillSchema, selfStun)).toEqual(['effects.0.negatedByGuard']);
    const noDamage = { ...guardedBlow, effects: [guardedBlow.effects[1]] };
    expect(issuePaths(SkillSchema, noDamage)).toEqual(['effects.0.negatedByGuard']);
    const potion = { ...minorHealingPotion, use: [{ type: 'stun', duration: d, negatedByGuard: true }] };
    expect(issuePaths(ItemSchema, potion)).toEqual(['use']);
  });

  it('rejects inconsistent item stacking and equipment without a slot', () => {
    expect(issuePaths(ItemSchema, { ...minorHealingPotion, maxStack: undefined })).toEqual(['maxStack']);
    expect(issuePaths(ItemSchema, { ...minorHealingPotion, stackable: false })).toEqual(['maxStack']);
    expect(issuePaths(ItemSchema, { ...rustySword, slot: undefined })).toEqual(['slot']);
    expect(issuePaths(ItemSchema, { ...rustySword, stackable: true })).toEqual(['stackable']);
    expect(issuePaths(ItemSchema, { ...rustySword, stats: { power: 1.5 } })).toEqual(['stats.power']);
    expect(issuePaths(ItemSchema, { ...rustySword, kind: 'artifact' })).toEqual(['kind']);
  });

  it('rejects enemies referencing skills they do not have', () => {
    const bad = { ...thornbackBoar, ai: [{ when: {}, do: { useSkill: 'skill:fireball' } }] };
    expect(issuePaths(EnemySchema, bad)).toEqual(['ai.0.do.useSkill']);
    expect(issuePaths(EnemySchema, { ...thornbackBoar, stats: { power: 3 } })).toEqual(['stats.maxHp']);
    expect(issuePaths(EnemySchema, { ...thornbackBoar, ai: [{ when: { hasConsumable: 'item:x' }, do: { useSkill: 'skill:gore' } }] })).toEqual([
      'ai.0.when',
    ]);
  });

  it('rejects malformed boss phases', () => {
    const [p0, p1] = hollowMatriarch.phases as [(typeof hollowMatriarch.phases)[0], (typeof hollowMatriarch.phases)[0]];
    expect(issuePaths(EnemySchema, { ...hollowMatriarch, phases: [{ ...p0, fromHpBp: 9000 }, p1] })).toEqual(['phases.0.fromHpBp']);
    expect(issuePaths(EnemySchema, { ...hollowMatriarch, phases: [p0, { ...p1, fromHpBp: 10000 }] })).toEqual(['phases.1.fromHpBp']);
    expect(issuePaths(EnemySchema, { ...hollowMatriarch, phases: [{ ...p0, rotation: ['skill:unknown'], telegraphs: [] }] })).toEqual([
      'phases.0.rotation.0',
      'phases',
    ]);
    expect(issuePaths(EnemySchema, { ...hollowMatriarch, phases: [{ ...p0, telegraphs: ['skill:summon_roots'] }] })).toEqual([
      'phases.0.telegraphs.0',
    ]);
    expect(issuePaths(EnemySchema, { ...hollowMatriarch, rank: 'normal' })).toEqual(['']);
    expect(issuePaths(EnemySchema, { ...thornbackBoar, rank: 'boss' })).toEqual(['phases']);
  });

  it('rejects bad loot tables, encounter tables and idle activities', () => {
    expect(issuePaths(LootTableSchema, { ...boarLoot, gold: { min: 5, max: 1 } })).toEqual(['gold.max']);
    expect(issuePaths(LootTableSchema, { ...boarLoot, entries: [{ item: 'item:boar_hide', weight: 0 }] })).toEqual(['entries.0.weight']);
    expect(issuePaths(LootTableSchema, { id: 'loot:empty', rolls: 0 })).toEqual(['']);
    expect(issuePaths(EncounterTableSchema, { id: 'enc:empty', entries: [] })).toEqual(['entries']);
    expect(issuePaths(IdleActivitySchema, { ...huntActivity, encounterTable: undefined })).toEqual(['encounterTable']);
    expect(issuePaths(IdleActivitySchema, { id: 'idle:nothing', encountersPerHour: 0 })).toEqual(['']);
  });
});
