import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { checkStart } from '@engine/expedition-kernel';
import { createActorWorldState, validateWorld } from '@engine/world';
import type { AreaId } from '@engine/world';
import { createRpgActivityRegistry } from '@rpg/rpg-sim';
import { createRpgPredicateRegistry } from '@rpg/rpg-schema';
import { describe, expect, it } from 'vitest';
import plugin from '@rpg/content-plugin';

import type { Character } from '../characters/schema.ts';
import {
  PROVISIONAL_STARTER_ATTRIBUTES, PROVISIONAL_STARTER_RULES, PROVISIONAL_STARTER_SKILLS,
} from '../characters/validation.ts';
import { snapshotRpgActor } from './service.ts';

const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
const content = compiled.bundle;

describe('authoritative expedition snapshot', () => {
  it('starts from the validated starter character, including its implicit basic attack', () => {
    const character = {
      actorId: '9d1c321a-2f34-46bc-8e54-c5618a8368fa',
      level: 1,
      attributes: { ...PROVISIONAL_STARTER_ATTRIBUTES },
      skillLoadout: [...PROVISIONAL_STARTER_SKILLS],
      automationRules: structuredClone(PROVISIONAL_STARTER_RULES),
    } as unknown as Character;
    const snapshot = snapshotRpgActor(character, [], content);
    expect(snapshot.skills).toContain('skill:basic_attack');

    const worldResult = validateWorld(content.world, createRpgPredicateRegistry());
    if (!worldResult.ok) throw new Error('compiled RPG world failed validation');
    const activities = createRpgActivityRegistry(content);
    const activityId = 'idle:region_1.hunt';
    const simulator = activities.get(activityId);
    if (!simulator) throw new Error(`missing simulator for ${activityId}`);
    const gate = checkStart({
      world: worldResult.world,
      request: { areaId: 'area:region_1' as AreaId, activityId, durationMin: 15, paceBp: 10_000 },
      activities,
      simulator,
      rawConfig: { consumables: [], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } },
      actors: [snapshot],
      evalContexts: [{
        actor: createActorWorldState({ completedAreas: ['area:region_1'] }),
        game: { defeatedEnemies: new Set(), level: 1 },
      }],
      predicates: createRpgPredicateRegistry(),
    });
    expect(gate).toMatchObject({ ok: true });
  });
});
