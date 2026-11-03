import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import type { JsonValue, LiveCommandResult, LiveStep } from '@engine/live-kernel';
import plugin from '@rpg/content-plugin';
import { describe, expect, it } from 'vitest';

import { PROVISIONAL_STARTER_ATTRIBUTES, PROVISIONAL_STARTER_RULES, PROVISIONAL_STARTER_SKILLS, BASIC_ATTACK } from '../characters/validation.ts';
import { createRpgLiveGame, RETREAT_HP_COST_BP } from './game.ts';
import type { RpgLiveHeroSetup, RpgLiveSetup, RpgLiveState } from './game.ts';
import type { RpgLiveEffect } from './effects.ts';

const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
const game = createRpgLiveGame(compiled.bundle);
const HERO = '00000000-0000-4000-8000-000000000001';
const ALLY = '00000000-0000-4000-8000-000000000002';
const DEAD_HERO = '00000000-0000-4000-8000-000000000003';

const GLADE = 'loc:test_grove.glade';
const SLIMES = { id: 'group:slimes', enemies: ['enemy:test_grove.slime'] };
const WARDENS = { id: 'group:wardens', enemies: ['enemy:test_grove.warden', 'enemy:test_grove.warden', 'enemy:test_grove.warden'] };

const R1 = (name: string) => `loc:region_1.${name}`;
const EXIT = (from: string, to: string) => `exit:region_1.${from}.${to}`;

function hero(actorId = HERO, extra: Partial<RpgLiveHeroSetup> = {}): RpgLiveHeroSetup {
  return { actorId, build: { level: 1, attributes: { ...PROVISIONAL_STARTER_ATTRIBUTES }, equipment: [] },
    skills: [BASIC_ATTACK, ...PROVISIONAL_STARTER_SKILLS], rules: PROVISIONAL_STARTER_RULES, ...extra };
}
function start(setup: RpgLiveSetup, seed = 42, actors: readonly string[] = [HERO]): RpgLiveState {
  return game.init({ instanceId: 'i', participants: actors.map((actorId) => ({ actorId, accountId: `acc-${actorId}` })), seed,
    setup: setup as unknown as JsonValue });
}
function init(): RpgLiveState {
  return start({ location: GLADE, groups: [SLIMES, WARDENS], heroes: [hero()] });
}
function region1(seed = 42, extra: Partial<RpgLiveHeroSetup> = {}): RpgLiveState {
  return start({ area: 'area:region_1', heroes: [hero(HERO, extra)] }, seed);
}
function ok(result: LiveCommandResult<RpgLiveState>): LiveStep<RpgLiveState> {
  if ('rejected' in result) throw new Error(`rejected: ${result.rejected}`);
  return result;
}
function run(state: RpgLiveState, ...commands: Record<string, unknown>[]): RpgLiveState {
  return commands.reduce<RpgLiveState>((current, command) => ok(game.applyCommand(current, HERO, command as JsonValue)).state, state);
}
const travel = (exitId: string) => ({ type: 'travel', exitId });
/** Portal → causeway → orchard → terraces → pump station. */
const TO_PUMP = [travel(EXIT('portal_clearing', 'overgrown_causeway')), travel(EXIT('overgrown_causeway', 'tangle_orchard')),
  travel(EXIT('tangle_orchard', 'irrigation_terraces')), travel(EXIT('irrigation_terraces', 'pump_station'))];

function fight(state: RpgLiveState, groupId: string): { last: LiveStep<RpgLiveState>; ticks: number } {
  const engaged = ok(game.applyCommand(state, HERO, { type: 'engage', groupId }));
  expect(engaged.checkpoint).toBe(true);
  let current: LiveStep<RpgLiveState> = engaged; let ticks = 0;
  while (game.isTicking(current.state) && ticks < 10_000) { current = game.tick(current.state); ticks += 1; }
  return { last: current, ticks };
}

describe('RPG live plugin: combat', () => {
  it('wins against slimes with automation, checkpointing the end of combat back in exploring', () => {
    const { last } = fight(init(), SLIMES.id);
    expect(last.close).toBeUndefined();
    expect(last.checkpoint).toBe(true);
    expect(last.state.phase).toBe('exploring');
    expect(last.state.visited[GLADE]?.groups.find((g) => g.id === SLIMES.id)?.defeated).toBe(true);
    expect(game.isTicking(last.state)).toBe(false);
    // Defeated groups cannot be engaged again (no respawn within the instance).
    expect(game.applyCommand(last.state, HERO, { type: 'engage', groupId: SLIMES.id })).toEqual({ rejected: 'unknown_group' });
  });

  it('dies against the warden pack: phase dead and the instance closes as defeated', () => {
    const { last } = fight(init(), WARDENS.id);
    expect(last.state.phase).toBe('dead');
    expect(last.close?.outcome).toBe('defeated');
    const deaths = last.effects?.filter((effect) => (effect as { type?: string }).type === 'heroDied') as
      { actorId: string; areaId: string; locationId: string; causes: { damage: number }[] }[] | undefined;
    expect(deaths).toHaveLength(1);
    expect(deaths?.[0]).toMatchObject({ actorId: HERO, areaId: 'area:test_grove', locationId: GLADE });
    expect(deaths?.[0]?.causes.length).toBeGreaterThanOrEqual(1);
    expect(deaths?.[0]?.causes.length).toBeLessThanOrEqual(3);
    expect(deaths?.[0]?.causes.every(cause => cause.damage > 0)).toBe(true);
    expect(game.applyCommand(last.state, HERO, { type: 'returnToSanctuary' })).toEqual({ rejected: 'instance_closing' });
  });

  it('is deterministic and restores to the pre-combat checkpoint (combat tick 0)', () => {
    const a = fight(init(), WARDENS.id); const b = fight(init(), WARDENS.id);
    expect(a.ticks).toBe(b.ticks);
    const engaged = ok(game.applyCommand(init(), HERO, { type: 'engage', groupId: WARDENS.id }));
    const restored = game.restore(game.serialize(engaged.state));
    expect(restored.combat?.tick).toBe(0);
    let current: LiveStep<RpgLiveState> = { state: restored }; let ticks = 0;
    while (game.isTicking(current.state)) { current = game.tick(current.state); ticks += 1; }
    expect(ticks).toBe(a.ticks);
  });

  it('validates combat commands and defers removing a participant until combat ends', () => {
    const state = init();
    expect(game.applyCommand(state, HERO, { type: 'engage' })).toEqual({ rejected: 'malformed' });
    expect(game.applyCommand(state, HERO, { type: 'travel', exitId: 'x', extra: 1 })).toEqual({ rejected: 'malformed' });
    expect(game.applyCommand(state, HERO, { type: 'setAuto', auto: false })).toEqual({ rejected: 'not_in_combat' });
    expect(game.applyCommand(state, HERO, { type: 'retreat' })).toEqual({ rejected: 'not_in_combat' });
    expect(game.applyCommand(state, ALLY, { type: 'retreat' })).toEqual({ rejected: 'not_present' });
    const engaged = ok(game.applyCommand(state, HERO, { type: 'engage', groupId: SLIMES.id }));
    for (const command of [{ type: 'returnToSanctuary' }, travel('exit:test_grove.glade.entrance'), { type: 'engage', groupId: WARDENS.id },
      { type: 'interact', hotspotId: 'old_stump' }, { type: 'gather', nodeId: 'res:test_grove.herb_patch#0' }]) {
      expect(game.applyCommand(engaged.state, HERO, command)).toEqual({ rejected: 'in_combat' });
    }
    expect(game.removeParticipant(engaged.state, HERO)).toBeNull();
    expect(game.removeParticipant(state, HERO)?.state.heroes[0]?.present).toBe(false);
  });
});

describe('RPG live plugin: exploration (#38)', () => {
  it('shows only the viewing actor their corpse hotspot at its exact location', () => {
    const state = init();
    const hero = state.heroes.find(candidate => candidate.actorId === HERO);
    if (!hero) throw new Error('test hero is missing');
    hero.corpses.push({ id: '33333333-3333-4333-8333-333333333333', areaId: state.area,
      locationId: state.location, expiresAt: 12345, stacks: [], gold: 0, uniques: [] });
    const ownerView = game.view(state, HERO) as { hotspots: { id: string }[] };
    const otherView = game.view(state, '00000000-0000-4000-8000-000000000002') as { hotspots: { id: string }[] };
    expect(ownerView.hotspots.map(h => h.id)).toContain('corpse:33333333-3333-4333-8333-333333333333');
    expect(otherView.hotspots.map(h => h.id)).not.toContain('corpse:33333333-3333-4333-8333-333333333333');
  });

  it('rolls enemy groups deterministically per instance seed and location, independent of the route taken', () => {
    const viaCauseway = run(region1(7), travel(EXIT('portal_clearing', 'overgrown_causeway')), travel(EXIT('overgrown_causeway', 'tangle_orchard')));
    const viaWell = run(region1(7), travel(EXIT('portal_clearing', 'overgrown_causeway')), travel(EXIT('overgrown_causeway', 'old_well')),
      travel(EXIT('old_well', 'irrigation_terraces')), travel(EXIT('irrigation_terraces', 'tangle_orchard')));
    const orchard = viaCauseway.visited[R1('tangle_orchard')]?.groups;
    expect(orchard).toHaveLength(2); // open decision #14: two rolls per combat location
    expect(viaWell.visited[R1('tangle_orchard')]?.groups).toEqual(orchard);
    expect(orchard?.map((g) => g.id)).toEqual([`${R1('tangle_orchard')}/0`, `${R1('tangle_orchard')}/1`]);
    const allowed = new Set(['enemy:thornback_boar', 'enemy:hollow_creeper', 'enemy:glowcap_mite']);
    expect(orchard?.every((g) => g.enemies.length > 0 && g.enemies.every((e) => allowed.has(e)) && !g.boss)).toBe(true);
    expect(region1(7).visited[R1('portal_clearing')]?.groups).toEqual([]); // no encounter table at the safe start
    // Other seeds produce other rolls somewhere (the roll really depends on the instance seed).
    const rolls = new Set([1, 2, 3, 4, 5, 6].map((seed) => JSON.stringify(run(region1(seed), ...TO_PUMP).visited)));
    expect(rolls.size).toBeGreaterThan(1);
  });

  it('never re-rolls a visited location within the instance (no respawn)', () => {
    let state = run(region1(), travel(EXIT('portal_clearing', 'overgrown_causeway')));
    const causeway = R1('overgrown_causeway');
    const group = state.visited[causeway]?.groups[0];
    if (!group) throw new Error('expected a group');
    state = structuredClone(state);
    (state.visited[causeway]?.groups[0] as { defeated: boolean }).defeated = true;
    state = run(state, travel(EXIT('overgrown_causeway', 'portal_clearing')), travel(EXIT('portal_clearing', 'overgrown_causeway')));
    expect(state.visited[causeway]?.groups[0]).toEqual({ ...group, defeated: true });
  });

  it('discovers locations once per present participant and commits them as effects with the checkpoint', () => {
    const state = start({ area: 'area:region_1', heroes: [hero(HERO), hero(ALLY, { world: { discovered: [R1('overgrown_causeway')],
      objectives: [], completedAreas: [] } })] }, 42, [HERO, ALLY]);
    // The start location is discovered on entry and waits in the outbox for the first durable write.
    expect(state.outbox).toHaveLength(2);
    const first = ok(game.applyCommand(state, HERO, travel(EXIT('portal_clearing', 'overgrown_causeway'))));
    expect(first.checkpoint).toBe(true);
    expect(first.effects).toMatchObject([
      { type: 'discovery', actorId: HERO, areaId: 'area:region_1', locationId: R1('portal_clearing') },
      { type: 'discovery', actorId: ALLY, areaId: 'area:region_1', locationId: R1('portal_clearing') },
      { type: 'discovery', actorId: HERO, areaId: 'area:region_1', locationId: R1('overgrown_causeway') },
    ]);
    expect(first.state.outbox).toEqual([]);
    expect(first.events).toContainEqual({ type: 'discovered', locationId: R1('overgrown_causeway'), actorIds: [HERO] });
    const back = ok(game.applyCommand(first.state, ALLY, travel(EXIT('overgrown_causeway', 'portal_clearing'))));
    expect(back.effects).toBeUndefined(); // already discovered by both
    // A participant who left is not credited.
    const left = game.removeParticipant(back.state, ALLY);
    if (!left) throw new Error('expected removal');
    const onward = ok(game.applyCommand(left.state, HERO, travel(EXIT('portal_clearing', 'overgrown_causeway'))));
    const old = ok(game.applyCommand(onward.state, HERO, travel(EXIT('overgrown_causeway', 'old_well'))));
    expect(old.effects).toMatchObject([{ type: 'discovery', actorId: HERO, areaId: 'area:region_1', locationId: R1('old_well') }]);
  });

  it('rejects unknown, locked and secret exits server-side', () => {
    const state = region1();
    expect(game.applyCommand(state, HERO, travel('exit:nowhere'))).toEqual({ rejected: 'unknown_exit' });
    expect(game.applyCommand(state, HERO, travel(EXIT('old_well', 'glowcap_grotto')))).toEqual({ rejected: 'unknown_exit' }); // not here
    const glade = start({ location: GLADE, heroes: [hero()] });
    expect(game.applyCommand(glade, HERO, travel('exit:test_grove.glade.den'))).toEqual({ rejected: 'exit_locked' }); // levelAtLeast 2
    const level2 = start({ location: GLADE, heroes: [hero(HERO, { build: { level: 2, attributes: { ...PROVISIONAL_STARTER_ATTRIBUTES }, equipment: [] } })] });
    expect(game.applyCommand(level2, HERO, travel('exit:test_grove.glade.den'))).toEqual({ rejected: 'boss_room_requires_confirmation' });
    const ruins = run(state, ...TO_PUMP, travel(EXIT('pump_station', 'lantern_ruins')));
    // Secret exit gated by a flag: reported as unknown until revealed.
    expect(game.applyCommand(ruins, HERO, travel(EXIT('lantern_ruins', 'sunken_greenhouse')))).toEqual({ rejected: 'unknown_exit' });
    expect(game.view(ruins)).not.toMatchObject({ exits: expect.arrayContaining([expect.objectContaining({ to: R1('sunken_greenhouse') })]) });
  });

  it('applies declarative hotspot effects once: the panel reveals the greenhouse, the lever opens the bulkhead', () => {
    const ruins = run(region1(), ...TO_PUMP, travel(EXIT('pump_station', 'lantern_ruins')));
    const searched = ok(game.applyCommand(ruins, HERO, { type: 'interact', hotspotId: 'cracked_panel' }));
    expect(searched.checkpoint).toBe(true);
    expect(searched.events).toEqual([{ type: 'hotspotInteracted', hotspotId: 'cracked_panel', hotspotType: 'search',
      textKey: 'hotspot.region_1.cracked_panel', repeat: false, flagsSet: ['region_1.hatch_found'],
      revealedExits: [EXIT('lantern_ruins', 'sunken_greenhouse')] }]);
    const again = ok(game.applyCommand(searched.state, HERO, { type: 'interact', hotspotId: 'cracked_panel' }));
    expect(again.checkpoint).toBeUndefined();
    expect(again.events).toMatchObject([{ repeat: true, flagsSet: [], revealedExits: [] }]);
    expect(again.state.flags).toEqual(['region_1.hatch_found']);
    const greenhouse = run(again.state, travel(EXIT('lantern_ruins', 'sunken_greenhouse')));
    expect(greenhouse.location).toBe(R1('sunken_greenhouse'));
    expect(run(greenhouse, travel(EXIT('sunken_greenhouse', 'lantern_ruins'))).location).toBe(R1('lantern_ruins'));
    expect(game.applyCommand(ruins, HERO, { type: 'interact', hotspotId: 'nope' })).toEqual({ rejected: 'unknown_hotspot' });

    const antechamber = run(region1(), ...TO_PUMP, travel(EXIT('pump_station', 'vault_antechamber')));
    const boss = { type: 'enterBossRoom', exitId: EXIT('vault_antechamber', 'seed_vault_heart'), confirm: false };
    expect(game.applyCommand(antechamber, HERO, boss)).toEqual({ rejected: 'exit_locked' }); // unmet flag keeps it blocked
    const lever = run(region1(), ...TO_PUMP, { type: 'interact', hotspotId: 'bulkhead_lever' }, travel(EXIT('pump_station', 'vault_antechamber')));
    expect(ok(game.applyCommand(lever, HERO, boss)).events).toMatchObject([{ type: 'bossRoomWarning' }]);
    // Lore hotspots set nothing.
    const lore = ok(game.applyCommand(region1(), HERO, { type: 'interact', hotspotId: 'portal_glyphs' }));
    expect(lore.events).toMatchObject([{ hotspotType: 'lore', flagsSet: [], revealedExits: [] }]);
  });

  it('enters the boss room only after a risk summary and an explicit confirmation; the boss aggroes and blocks retreat', () => {
    const antechamber = run(region1(), ...TO_PUMP, { type: 'interact', hotspotId: 'bulkhead_lever' }, travel(EXIT('pump_station', 'vault_antechamber')));
    const exitId = EXIT('vault_antechamber', 'seed_vault_heart');
    expect(game.applyCommand(antechamber, HERO, travel(exitId))).toEqual({ rejected: 'boss_room_requires_confirmation' });
    expect(game.applyCommand(antechamber, HERO, { type: 'enterBossRoom', exitId, confirm: true })).toEqual({ rejected: 'confirmation_required' });
    expect(game.applyCommand(antechamber, HERO, { type: 'enterBossRoom', exitId: EXIT('vault_antechamber', 'pump_station'), confirm: false }))
      .toEqual({ rejected: 'not_a_boss_room' });
    const warned = ok(game.applyCommand(antechamber, HERO, { type: 'enterBossRoom', exitId, confirm: false }));
    expect(warned.checkpoint).toBeUndefined();
    expect(warned.state.location).toBe(R1('vault_antechamber'));
    expect(warned.events).toEqual([{ type: 'bossRoomWarning', exitId, risk: {
      locationId: R1('seed_vault_heart'), enemies: [{ enemy: 'enemy:hollow_matriarch', rank: 'boss', level: 6 }],
      heroes: [{ actorId: HERO, hp: expect.any(Number), maxHp: expect.any(Number), healingConsumables: 0 }],
      retreatAllowed: false, onDeath: ['live.death.run_bag_to_corpse', 'live.death.xp_penalty'],
      deathConsequences: [{ actorId: HERO, xpBeforeTotal: 0, xpLost: 0, runBag: { items: [], gold: 0, uniques: [] } }] } }]);
    const entered = ok(game.applyCommand(warned.state, HERO, { type: 'enterBossRoom', exitId, confirm: true }));
    expect(entered.checkpoint).toBe(true);
    expect(entered.state).toMatchObject({ phase: 'combat', location: R1('seed_vault_heart'), combatGroup: `${R1('seed_vault_heart')}/0` });
    expect(entered.state.visited[R1('seed_vault_heart')]?.groups).toEqual([{ id: `${R1('seed_vault_heart')}/0`,
      enemies: ['enemy:hollow_matriarch'], boss: true, defeated: false }]); // open decision #14: one roll in a boss room
    expect(entered.effects).toMatchObject([{ type: 'discovery', actorId: HERO, areaId: 'area:region_1', locationId: R1('seed_vault_heart') }]);
    expect(game.applyCommand(entered.state, HERO, { type: 'retreat' })).toEqual({ rejected: 'retreat_not_allowed' });
    // A won boss fight credits the fighters and makes the cleared boss room a return point.
    const won = structuredClone(entered.state);
    let step: LiveStep<RpgLiveState> = { state: won };
    const combat = step.state.combat;
    if (!combat) throw new Error('expected combat');
    for (const actor of combat.actors) if (actor.side === 'enemy') { actor.hp = 1; }
    for (let i = 0; i < 2000 && game.isTicking(step.state); i += 1) step = game.tick(step.state);
    expect(step.state.phase).toBe('exploring');
    expect(step.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'bossDefeated', actorId: HERO, areaId: 'area:region_1', enemyIds: ['enemy:hollow_matriarch'] }),
      expect.objectContaining({ type: 'xpGranted', actorId: HERO, xp: expect.any(Number) }),
      expect.objectContaining({ type: 'lootGranted', actorId: HERO }),
    ]));
    expect(step.state.heroes[0]?.world.objectives).toContain('defeated:enemy:hollow_matriarch');
    expect(ok(game.applyCommand(step.state, HERO, { type: 'returnToSanctuary' })).close?.outcome).toBe('returned');
  });

  it('credits only present heroes for a boss victory, including a present hero who died during combat', () => {
    const state = start({ area: 'area:region_1', location: R1('seed_vault_heart'), groups: [
      { id: 'group:matriarch', enemies: ['enemy:hollow_matriarch'] },
    ], heroes: [hero(HERO), hero(ALLY), hero(DEAD_HERO)] }, 43, [HERO, ALLY, DEAD_HERO]);
    const engaged = ok(game.applyCommand(state, HERO, { type: 'engage', groupId: 'group:matriarch' }));
    const fighting = structuredClone(engaged.state);
    const absent = fighting.heroes.find((candidate) => candidate.actorId === ALLY);
    const deadButPresent = fighting.combat?.actors.find((actor) => actor.side === 'hero' && actor.id === DEAD_HERO);
    const enemy = fighting.combat?.actors.find((actor) => actor.side === 'enemy');
    if (!absent || !deadButPresent || !enemy) throw new Error('expected a party boss encounter');
    // Grace removal is deferred during combat. Keep the actor in the fight but mark the participant absent to model
    // a departure marker arriving while the combat checkpoint still carries the original combat actors.
    expect(game.removeParticipant(fighting, ALLY)).toBeNull();
    absent.present = false;
    deadButPresent.hp = 0;
    deadButPresent.alive = false;
    enemy.hp = 1;

    let step: LiveStep<RpgLiveState> = { state: fighting };
    for (let tick = 0; tick < 2000 && game.isTicking(step.state); tick += 1) step = game.tick(step.state);
    expect(step.state.phase).toBe('exploring');
    expect(step.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'bossDefeated', actorId: HERO, enemyIds: ['enemy:hollow_matriarch'] }),
      expect.objectContaining({ type: 'bossDefeated', actorId: DEAD_HERO, enemyIds: ['enemy:hollow_matriarch'] }),
      expect.objectContaining({ type: 'xpGranted', actorId: HERO }),
    ]));
    const effects = (step.effects ?? []) as unknown as RpgLiveEffect[];
    expect(effects.some(effect => effect.type === 'bossDefeated' && effect.actorId === ALLY)).toBe(false);
    expect(step.state.heroes.find((candidate) => candidate.actorId === DEAD_HERO)?.world.objectives)
      .toContain('defeated:enemy:hollow_matriarch');
  });

  it('allows returning to the Sanctuary only out of combat from the start, a safe location or a cleared boss room', () => {
    const portal = region1();
    const returned = ok(game.applyCommand(portal, HERO, { type: 'returnToSanctuary' }));
    expect(returned.close?.outcome).toBe('returned');
    expect(returned.state.phase).toBe('closing');
    expect(returned.effects).toMatchObject([{ type: 'discovery', actorId: HERO, areaId: 'area:region_1', locationId: R1('portal_clearing') }]);
    const causeway = run(portal, travel(EXIT('portal_clearing', 'overgrown_causeway')));
    expect(game.applyCommand(causeway, HERO, { type: 'returnToSanctuary' })).toEqual({ rejected: 'not_safe_location' });
    const antechamber = run(portal, ...TO_PUMP, travel(EXIT('pump_station', 'vault_antechamber')));
    expect(ok(game.applyCommand(antechamber, HERO, { type: 'returnToSanctuary' })).close?.outcome).toBe('returned');
    const group = causeway.visited[R1('overgrown_causeway')]?.groups[0]?.id ?? '';
    const fighting = ok(game.applyCommand(causeway, HERO, { type: 'engage', groupId: group })).state;
    expect(game.applyCommand(fighting, HERO, { type: 'returnToSanctuary' })).toEqual({ rejected: 'in_combat' });
    expect(game.view(antechamber)).toMatchObject({ canReturn: true });
    expect(game.view(causeway)).toMatchObject({ canReturn: false });
  });

  it('retreats from a non-boss fight at an HP cost, back to the previous location, leaving the group undefeated', () => {
    const causeway = run(region1(), travel(EXIT('portal_clearing', 'overgrown_causeway')));
    const group = causeway.visited[R1('overgrown_causeway')]?.groups[0]?.id ?? '';
    const engaged = ok(game.applyCommand(causeway, HERO, { type: 'engage', groupId: group }));
    let current: LiveStep<RpgLiveState> = engaged;
    for (let i = 0; i < 3; i += 1) current = game.tick(current.state);
    expect(current.state.phase).toBe('combat');
    const actor = current.state.combat?.actors.find((a) => a.id === HERO);
    if (!actor) throw new Error('expected hero');
    const retreated = ok(game.applyCommand(current.state, HERO, { type: 'retreat' }));
    expect(retreated.checkpoint).toBe(true);
    const cost = Math.floor(actor.stats.maxHp * RETREAT_HP_COST_BP / 10_000);
    expect(retreated.state).toMatchObject({ phase: 'exploring', combat: null, location: R1('portal_clearing'),
      previous: R1('overgrown_causeway') });
    expect(retreated.state.heroes[0]?.hp).toBe(Math.max(1, actor.hp - cost));
    expect(retreated.events).toContainEqual({ type: 'combatEnded', outcome: 'retreated', groupId: group });
    expect(retreated.state.visited[R1('overgrown_causeway')]?.groups.find((g) => g.id === group)?.defeated).toBe(false);
    // The group is still there to fight later.
    const back = run(retreated.state, travel(EXIT('portal_clearing', 'overgrown_causeway')));
    expect(ok(game.applyCommand(back, HERO, { type: 'engage', groupId: group })).state.phase).toBe('combat');
  });

  it('gathers each resource node once per instance', () => {
    const grotto = run(region1(), travel(EXIT('portal_clearing', 'overgrown_causeway')), travel(EXIT('overgrown_causeway', 'old_well')),
      travel(EXIT('old_well', 'glowcap_grotto')));
    expect(game.view(grotto)).toMatchObject({ resources: [{ nodeId: 'res:glowcap#0', gathered: false }, { nodeId: 'res:glowcap#1', gathered: false }] });
    const first = ok(game.applyCommand(grotto, HERO, { type: 'gather', nodeId: 'res:glowcap#0' }));
    expect(first.checkpoint).toBe(true);
    expect(first.events).toMatchObject([{ type: 'gathered', nodeId: 'res:glowcap#0', resource: 'res:glowcap',
      lootTable: 'loot:region_1.glowcap_gather', actorId: HERO, drops: expect.any(Array), gold: expect.any(Number) }]);
    expect(first.effects).toContainEqual(expect.objectContaining({ type: 'lootGranted', actionId: `gather:${R1('glowcap_grotto')}/res:glowcap#0`, actorId: HERO }));
    expect(first.state.runBag[HERO]).toBeDefined();
    expect(game.applyCommand(first.state, HERO, { type: 'gather', nodeId: 'res:glowcap#0' })).toEqual({ rejected: 'already_gathered' });
    expect(game.applyCommand(first.state, HERO, { type: 'gather', nodeId: 'res:glowcap#1' })).not.toHaveProperty('rejected');
    expect(game.applyCommand(first.state, HERO, { type: 'gather', nodeId: 'res:glowcap#2' })).toEqual({ rejected: 'unknown_node' });
  });

  it('uses healing consumables out of combat against the snapshot loadout', () => {
    const state = region1(42, { consumables: [{ item: 'item:minor_healing_potion', qty: 1 }, { item: 'item:sap_tonic', qty: 1 }] });
    expect(game.applyCommand(state, HERO, { type: 'useConsumable', itemId: 'item:minor_healing_potion' })).toEqual({ rejected: 'full_hp' });
    expect(game.applyCommand(state, HERO, { type: 'useConsumable', itemId: 'item:healing_potion' })).toEqual({ rejected: 'no_such_consumable' });
    const maxHp = (game.view(state) as { heroes: { maxHp: number }[] }).heroes[0]?.maxHp ?? 0;
    const hurt = structuredClone(state);
    (hurt.heroes[0] as { hp: number | null }).hp = 1;
    const drank = ok(game.applyCommand(hurt, HERO, { type: 'useConsumable', itemId: 'item:minor_healing_potion' }));
    expect(drank.checkpoint).toBe(true);
    expect(drank.state.heroes[0]).toMatchObject({ hp: 1 + Math.floor(maxHp * 3000 / 10_000),
      consumables: [{ item: 'item:minor_healing_potion', qty: 0 }, { item: 'item:sap_tonic', qty: 1 }], used: { 'item:minor_healing_potion': 1 } });
    expect(game.applyCommand(drank.state, HERO, { type: 'useConsumable', itemId: 'item:minor_healing_potion' })).toEqual({ rejected: 'no_such_consumable' });
    // A heal-over-time heals its whole duration out of combat (300 bp every 2 ticks for 10 ticks).
    const tonic = ok(game.applyCommand(drank.state, HERO, { type: 'useConsumable', itemId: 'item:sap_tonic' }));
    expect(tonic.state.heroes[0]?.hp).toBe(1 + Math.floor(maxHp * 3000 / 10_000) + 5 * Math.floor(maxHp * 300 / 10_000));
  });

  it('round-trips exploration state through serialize/restore (crash recovery keeps flags, discoveries and rolls)', () => {
    const explored = run(region1(), ...TO_PUMP, { type: 'interact', hotspotId: 'bulkhead_lever' }, { type: 'gather', nodeId: 'res:alloy_scrap#0' });
    const restored = game.restore(JSON.parse(JSON.stringify(game.serialize(explored))) as JsonValue);
    expect(restored).toEqual(explored);
    expect(game.view(restored)).toEqual(game.view(explored));
  });
});
