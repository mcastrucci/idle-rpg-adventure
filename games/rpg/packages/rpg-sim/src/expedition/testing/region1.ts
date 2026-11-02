/**
 * Test helpers (not shipped behaviour): compiles the real content with the content compiler + RPG plugin (test-only
 * I/O, like the Region 1 combat smoke test) and provides provisional hero snapshots mirroring the balance-sim reference
 * builds (design region-1 §4.2–§4.3). The numbers are test inputs, not a build system.
 */
import { fileURLToPath } from 'node:url';

import { compileContent, loadContentFiles } from '@engine/content-compiler';
import type { ContentBundle } from '@engine/content-compiler';
import { createActorWorldState } from '@engine/world';
import type { ActorWorldStateInit, EvalContext } from '@engine/world';
import plugin from '@rpg/content-plugin';
import { AutomationRulesSchema } from '@rpg/rpg-schema';
import type { AutomationRule, EquipmentItem, RpgGameContext } from '@rpg/rpg-schema';
import type { AttributeMap } from '@rpg/rpg-stats';

import { rpgIdleContentFromBundle } from '../content.ts';
import type { RpgIdleContent } from '../content.ts';
import type { RpgActorSnapshot, RpgIdleConfig } from '../types.ts';

const ROOT = fileURLToPath(new URL('../../../../../content/', import.meta.url));

let cached: { bundle: ContentBundle; content: RpgIdleContent } | undefined;

/** The compiled `games/rpg/content` bundle and the idle content parsed from it (compiled once per test file). */
export function region1(): { bundle: ContentBundle; content: RpgIdleContent } {
  if (cached === undefined) {
    const result = compileContent(loadContentFiles(ROOT), plugin);
    if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
    cached = { bundle: result.bundle, content: rpgIdleContentFromBundle(result.bundle) };
  }
  return cached;
}

export const POTION = 'item:minor_healing_potion';
export const HUNT = 'idle:region_1.hunt';
export const GATHER = 'idle:region_1.gather';
export const REGION_1 = 'area:region_1';

const attrs = (STR: number, AGI: number, INT: number, VIT: number, SPI: number): AttributeMap => ({ STR, AGI, INT, VIT, SPI });
const rules = (r: unknown): AutomationRule[] => AutomationRulesSchema.parse(r);

function gear(content: RpgIdleContent, ids: readonly string[]): EquipmentItem[] {
  return ids.map((id) => {
    const it = content.combat.items[id];
    if (it?.kind !== 'equipment') throw new Error(`${id} is not equipment`);
    return it;
  });
}

const BULWARK_ATTRS: Record<number, AttributeMap> = {
  1: attrs(9, 4, 2, 10, 5),
  2: attrs(10, 4, 2, 12, 6),
  3: attrs(11, 4, 2, 14, 7),
  4: attrs(12, 4, 2, 16, 8),
  5: attrs(13, 4, 2, 18, 9),
};
const THORNBLADE_ATTRS: Record<number, AttributeMap> = {
  1: attrs(11, 9, 2, 5, 3),
  2: attrs(12, 10, 2, 6, 4),
  3: attrs(14, 11, 2, 7, 4),
  4: attrs(15, 12, 2, 8, 5),
  5: attrs(17, 13, 2, 9, 5),
};

export function bulwark(level: number, over: Partial<RpgActorSnapshot> = {}): RpgActorSnapshot {
  const { content } = region1();
  return {
    actorId: 'char:bulwark',
    build: {
      level,
      attributes: BULWARK_ATTRS[level] as AttributeMap,
      equipment: gear(content, [
        'item:rusty_sword',
        level >= 3 ? 'item:boar_hide_jerkin' : 'item:padded_vest',
        level >= 4 ? 'item:tiller_plate_buckler' : 'item:wooden_buckler',
      ]),
    },
    skills: ['skill:basic_attack', 'skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend'],
    rules: rules([
      { when: { selfHpBelowBp: 4000, hasConsumable: POTION }, do: { useConsumable: POTION } },
      { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
      { when: { selfHpBelowBp: 5500, skillReady: 'skill:mend' }, do: { useSkill: 'skill:mend', target: 'self' } },
      { when: { enemiesAtLeast: 2, skillReady: 'skill:cleave' }, do: { useSkill: 'skill:cleave' } },
      { when: { skillReady: 'skill:shield_bash' }, do: { useSkill: 'skill:shield_bash', target: 'lowestHpEnemy' } },
      { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
    ]),
    ...over,
  };
}

export function thornblade(level: number, over: Partial<RpgActorSnapshot> = {}): RpgActorSnapshot {
  const { content } = region1();
  return {
    actorId: 'char:thornblade',
    build: {
      level,
      attributes: THORNBLADE_ATTRS[level] as AttributeMap,
      equipment: gear(content, ['item:rusty_sword', level >= 3 ? 'item:boar_hide_jerkin' : 'item:padded_vest']),
    },
    skills: ['skill:basic_attack', 'skill:precise_strike', 'skill:rend', 'skill:second_wind', 'skill:cleave'],
    rules: rules([
      { when: { selfHpBelowBp: 4000, hasConsumable: POTION }, do: { useConsumable: POTION } },
      { when: { selfHasHarmfulEffect: true, skillReady: 'skill:second_wind' }, do: { useSkill: 'skill:second_wind' } },
      { when: { enemiesAtLeast: 2, skillReady: 'skill:cleave' }, do: { useSkill: 'skill:cleave' } },
      { when: { skillReady: 'skill:precise_strike' }, do: { useSkill: 'skill:precise_strike', target: 'lowestHpEnemy' } },
      { when: { skillReady: 'skill:rend' }, do: { useSkill: 'skill:rend', target: 'highestHpEnemy' } },
      { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
    ]),
    ...over,
  };
}

/** Idle config (the activity is not part of it: it is the kernel-owned `activityId` of the start request). */
export function idleConfig(potions: number, retreat: Partial<RpgIdleConfig['retreat']> = {}): RpgIdleConfig {
  return {
    consumables: potions > 0 ? [{ item: POTION, qty: potions }] : [],
    retreat: { belowHpBp: 0, onlyWhenNoHealing: true, ...retreat },
  };
}

/** Requirement evaluation context for the RPG predicates. */
export function rpgContext(init: ActorWorldStateInit = {}, defeated: readonly string[] = [], level = 1): EvalContext<RpgGameContext> {
  return { actor: createActorWorldState(init), game: { defeatedEnemies: new Set(defeated), level } };
}
