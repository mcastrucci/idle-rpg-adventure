import { fileURLToPath } from 'node:url';

import { compileContent, loadContentFiles, type ContentFile } from '@engine/content-compiler';
import { poolLocations } from '@engine/world';
import {
  EncounterTableSchema, EnemySchema, IdleActivitySchema, ItemSchema, LootTableSchema,
  RpgAreaSchema, RpgLocationSchema, SkillSchema,
} from '@rpg/rpg-schema';
import { describe, expect, it } from 'vitest';

import plugin from './index.ts';

const ROOT = fileURLToPath(new URL('../../../content/', import.meta.url));
const FILES = loadContentFiles(ROOT);
function compile(files: readonly ContentFile[] = FILES) {
  const result = compileContent(files, plugin);
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.bundle;
}
const BUNDLE = compile();
const skills = (BUNDLE.collections['skills'] ?? []).map(s => SkillSchema.parse(s)).filter(s => s.tags.includes('region_1'));
const enemies = (BUNDLE.collections['enemies'] ?? []).map(e => EnemySchema.parse(e)).filter(e => e.tags.includes('region_1'));
const encounters = (BUNDLE.collections['encounterTables'] ?? []).map(e => EncounterTableSchema.parse(e));
const activities = (BUNDLE.collections['idleActivities'] ?? []).map(a => IdleActivitySchema.parse(a)).filter(a => a.tags.includes('region_1'));
const area = RpgAreaSchema.parse(BUNDLE.world.areas.find(a => a.id === 'area:region_1'));
const locations = BUNDLE.world.locations.map(l => RpgLocationSchema.parse(l)).filter(l => area.locations.includes(l.id));
function getSkill(id: string) {
  const skill = skills.find(s => s.id === `skill:${id}`);
  if (!skill) throw new Error(`missing skill ${id}`);
  return skill;
}

describe('Region 1 content authoring (#46 prerequisite, provisional balance)', () => {
  it('compiles all references alongside the untouched technical seed', () => {
    expect(BUNDLE.world.areas.map(a => a.id)).toContain('area:test_grove');
    expect(BUNDLE.collections['enemies']?.some(e => e.id === 'enemy:test_grove.warden')).toBe(true);
    expect(skills).toHaveLength(16);
    expect(locations).toHaveLength(11);
  });

  it('has exactly five commons and one native Fracture mini-boss with three telegraphed phases', () => {
    expect(enemies.filter(e => e.rank === 'normal').map(e => e.id)).toEqual([
      'enemy:glowcap_mite', 'enemy:hollow_creeper', 'enemy:rusted_tiller',
      'enemy:sentinel_lantern', 'enemy:thornback_boar',
    ]);
    const bosses = enemies.filter(e => e.rank === 'boss');
    expect(bosses).toHaveLength(1);
    const boss = bosses[0];
    if (!boss || boss.rank !== 'boss') throw new Error('mini-boss missing');
    expect(boss.id).toBe('enemy:hollow_matriarch');
    expect(boss.tags).toEqual(['region_1', 'mini_boss', 'native_fracture']);
    expect(boss.phases.map(p => p.fromHpBp)).toEqual([10000, 6000, 2500]);
    for (const phase of boss.phases) {
      expect(phase.telegraphs).toEqual(['skill:crushing_blow']);
      for (const id of phase.telegraphs) expect(skills.find(s => s.id === id)?.windupTicks).toBeGreaterThan(0);
    }
    expect(getSkill('crushing_blow').effects).toContainEqual(expect.objectContaining({ type: 'stun', duration: { value: 3, unit: 'ticks' } }));
  });

  it('expresses attack, tick and owner-action durations without converting units', () => {
    expect(getSkill('shield_bash').effects).toContainEqual(expect.objectContaining({ type: 'taunt', duration: { value: 3, unit: 'attacks' } }));
    expect(getSkill('guard').effects.map(e => 'duration' in e ? e.duration : null)).toEqual([
      { value: 1, unit: 'attacks' }, { value: 1, unit: 'attacks' },
    ]);
    expect(getSkill('rend').effects).toContainEqual(expect.objectContaining({ type: 'dot', periodTicks: 2, duration: { value: 10, unit: 'ticks' } }));
    expect(getSkill('verdant_frenzy').effects).toContainEqual(expect.objectContaining({ type: 'stat_mod', stat: 'haste', flat: 25, duration: { value: 4, unit: 'actions' } }));
    expect(getSkill('second_wind').effects[0]).toMatchObject({ type: 'cleanse' });
  });

  it('keeps the start, secret and boss outside the eight-location conquest pool', () => {
    if (!area.completion) throw new Error('completion missing');
    const pool = poolLocations(area, area.completion, locations);
    expect(pool).toHaveLength(8);
    expect(pool).not.toContain('loc:region_1.portal_clearing');
    expect(pool).not.toContain('loc:region_1.sunken_greenhouse');
    expect(pool).not.toContain('loc:region_1.seed_vault_heart');
    expect(area.startLocation).toBe('loc:region_1.portal_clearing');
    expect(area.completion).toMatchObject({ pool: { tag: 'ordinary' }, thresholdBp: 7000, required: { all: [{ game: 'defeated', enemy: 'enemy:hollow_matriarch' }] } });
    expect(area.completion?.frozen).toBeUndefined(); // Freeze only at publication.
    const secret = locations.find(l => l.id === 'loc:region_1.lantern_ruins')?.exits.find(e => e.to === 'loc:region_1.sunken_greenhouse');
    expect(secret).toMatchObject({ tags: ['secret'], requires: { flag: 'region_1.hatch_found' } });
    const bossExit = locations.find(l => l.id === 'loc:region_1.vault_antechamber')?.exits.find(e => e.to === 'loc:region_1.seed_vault_heart');
    expect(bossExit).toMatchObject({ requires: { flag: 'region_1.bulkhead_open' } });
  });

  it('keeps boss and secret encounters out of area-local idle hunt/gather', () => {
    expect(activities.map(a => [a.id, a.encountersPerHour])).toEqual([
      ['idle:region_1.gather', 10], ['idle:region_1.hunt', 30],
    ]);
    expect(area.activities).toEqual(['idle:region_1.hunt', 'idle:region_1.gather']);
    for (const activity of activities) {
      const table = encounters.find(t => t.id === activity.encounterTable);
      if (!table) throw new Error('idle table missing');
      expect(['enc:region_1.greenhouse', 'enc:region_1.matriarch']).not.toContain(table.id);
      expect(table.entries.reduce((sum, e) => sum + e.weight, 0)).toBe(100);
      for (const group of table.entries) for (const member of group.enemies) {
        expect(enemies.find(e => e.id === member.enemy)?.rank).toBe('normal');
      }
      expect(table.entries.some(e => e.enemies.some(m => m.enemy === 'enemy:hollow_matriarch'))).toBe(false);
      expect(activity.resourceYields.some(y => y.node === 'res:seed_cache')).toBe(false);
    }
    const hunt = encounters.find(t => t.id === 'enc:region_1.hunt');
    const xpWeighted = hunt?.entries.reduce((sum, group) => sum + group.weight * group.enemies.reduce(
      (xp, member) => xp + (enemies.find(e => e.id === member.enemy)?.xp ?? 0) * member.count, 0), 0);
    // 21.9 XP/roll before outcome/death accounting; no claim about simulator XP/hour.
    expect(xpWeighted).toBe(2190);
  });

  it('models independent resource bonus rolls and guaranteed core/cache drops', () => {
    const tables = (BUNDLE.collections['lootTables'] ?? []).map(t => LootTableSchema.parse(t));
    const scrap = tables.find(t => t.id === 'loot:region_1.scrap_gather');
    expect(scrap).toMatchObject({ nothingWeight: 90, guaranteed: [{ item: 'item:alloy_scrap', qty: { min: 1, max: 2 } }], entries: [{ item: 'item:lens_shard', weight: 10 }] });
    const cache = tables.find(t => t.id === 'loot:region_1.seed_cache');
    expect(cache).toMatchObject({ nothingWeight: 75, entries: [{ item: 'item:lantern_lens', weight: 25 }], guaranteed: [{ item: 'item:healing_potion' }, { item: 'item:seed_capsule' }] });
    expect(tables.find(t => t.id === 'loot:region_1.matriarch')?.guaranteed).toContainEqual({ item: 'item:heartwood_core', qty: { min: 1, max: 1 } });
    const items = (BUNDLE.collections['items'] ?? []).map(i => ItemSchema.parse(i));
    expect(items.find(i => i.id === 'item:minor_healing_potion')).toMatchObject({ kind: 'consumable', value: 3, maxStack: 20 });
  });

  it('has a stable canonical content hash regardless of filesystem order or JSON formatting', () => {
    const reformatted = [...FILES].reverse().map(f => ({ file: f.file, text: JSON.stringify(JSON.parse(f.text)) }));
    expect(compile(reformatted).contentHash).toBe(BUNDLE.contentHash);
    expect(compile().contentHash).toBe(BUNDLE.contentHash);
    const changed = FILES.map(f => f.file === 'enemies/region_1.json'
      ? { ...f, text: f.text.replace('"maxHp": 440', '"maxHp": 441') } : f);
    expect(compile(changed).contentHash).not.toBe(BUNDLE.contentHash);
  });
});
