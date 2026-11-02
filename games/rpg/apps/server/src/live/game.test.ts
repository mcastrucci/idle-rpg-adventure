import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import type { JsonValue, LiveStep } from '@engine/live-kernel';
import plugin from '@rpg/content-plugin';
import { describe, expect, it } from 'vitest';

import { PROVISIONAL_STARTER_ATTRIBUTES, PROVISIONAL_STARTER_RULES, PROVISIONAL_STARTER_SKILLS, BASIC_ATTACK } from '../characters/validation.ts';
import { createRpgLiveGame } from './game.ts';
import type { RpgLiveSetup, RpgLiveState } from './game.ts';

const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
const game = createRpgLiveGame(compiled.bundle);
const HERO = '00000000-0000-4000-8000-000000000001';

const SLIMES = { id: 'group:slimes', enemies: ['enemy:test_grove.slime'] };
const WARDENS = { id: 'group:wardens', enemies: ['enemy:test_grove.warden', 'enemy:test_grove.warden', 'enemy:test_grove.warden'] };

function init(): RpgLiveState {
  const setup: RpgLiveSetup = { location: 'loc:test_grove.glade', groups: [SLIMES, WARDENS], heroes: [{ actorId: HERO,
    build: { level: 1, attributes: { ...PROVISIONAL_STARTER_ATTRIBUTES }, equipment: [] },
    skills: [BASIC_ATTACK, ...PROVISIONAL_STARTER_SKILLS], rules: PROVISIONAL_STARTER_RULES }] };
  return game.init({ instanceId: 'i', participants: [{ actorId: HERO, accountId: 'a' }], seed: 42, setup: setup as unknown as JsonValue });
}
function fight(state: RpgLiveState, groupId: string): { last: LiveStep<RpgLiveState>; ticks: number } {
  const engaged = game.applyCommand(state, HERO, { type: 'engage', groupId });
  if ('rejected' in engaged) throw new Error(engaged.rejected);
  expect(engaged.checkpoint).toBe(true);
  let current: LiveStep<RpgLiveState> = engaged; let ticks = 0;
  while (game.isTicking(current.state) && ticks < 10_000) { current = game.tick(current.state); ticks += 1; }
  return { last: current, ticks };
}

describe('RPG live plugin (spike)', () => {
  it('wins against slimes with automation, checkpointing the end of combat', () => {
    const { last } = fight(init(), SLIMES.id);
    expect(last.close).toBeUndefined();
    expect(last.checkpoint).toBe(true);
    expect(last.state.groups.find((g) => g.id === SLIMES.id)?.defeated).toBe(true);
    expect(game.isTicking(last.state)).toBe(false);
  });

  it('dies against the warden pack and closes the instance as defeated', () => {
    const { last } = fight(init(), WARDENS.id);
    expect(last.close?.outcome).toBe('defeated');
  });

  it('is deterministic and restores to the pre-combat checkpoint (combat tick 0)', () => {
    const a = fight(init(), WARDENS.id); const b = fight(init(), WARDENS.id);
    expect(a.ticks).toBe(b.ticks);
    const engaged = game.applyCommand(init(), HERO, { type: 'engage', groupId: WARDENS.id }) as LiveStep<RpgLiveState>;
    const restored = game.restore(game.serialize(engaged.state));
    expect(restored.combat?.tick).toBe(0);
    let current: LiveStep<RpgLiveState> = { state: restored }; let ticks = 0;
    while (game.isTicking(current.state)) { current = game.tick(current.state); ticks += 1; }
    expect(ticks).toBe(a.ticks);
  });

  it('validates commands and defers removing a participant until combat ends', () => {
    const state = init();
    expect(game.applyCommand(state, HERO, { type: 'engage' })).toEqual({ rejected: 'malformed' });
    expect(game.applyCommand(state, HERO, { type: 'setAuto', auto: false })).toEqual({ rejected: 'not_in_combat' });
    const engaged = game.applyCommand(state, HERO, { type: 'engage', groupId: SLIMES.id }) as LiveStep<RpgLiveState>;
    expect(game.applyCommand(engaged.state, HERO, { type: 'returnToSanctuary' })).toEqual({ rejected: 'in_combat' });
    expect(game.removeParticipant(engaged.state, HERO)).toBeNull();
    expect(game.removeParticipant(state, HERO)?.state.heroes[0]?.present).toBe(false);
  });
});
