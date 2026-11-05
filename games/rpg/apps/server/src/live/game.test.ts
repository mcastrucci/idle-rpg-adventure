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

describe('RPG live plugin: XP at victory and death', () => {
  const SLIMES_2 = { id: 'group:slimes_2', enemies: ['enemy:test_grove.slime'] };
  const withSlimes = (xp: number, level = 1) => start({ location: 'loc:test_grove.entrance', groups: [SLIMES, SLIMES_2, WARDENS], heroes: [hero(HERO, {
    build: { level, attributes: { ...PROVISIONAL_STARTER_ATTRIBUTES }, equipment: [] }, xp })] });
  const viewHero = (state: RpgLiveState) => (game.view(state, HERO) as unknown as { heroes: { level: number; xp: number; xpIntoLevel: number;
    xpToNext: number | null; maxHp: number }[] }).heroes[0];
  const events = (step: LiveStep<RpgLiveState>) => (step.events ?? []) as { type?: string; rewards?: Record<string, unknown>[] }[];

  it('emits one durable xpGranted effect per surviving fighter at victory and reports the level-up', () => {
    const start95 = withSlimes(95);
    const before = viewHero(start95);
    expect(before).toMatchObject({ level: 1, xp: 95, xpIntoLevel: 95, xpToNext: 100 });
    const { last } = fight(start95, SLIMES.id);
    const grants = (last.effects ?? []).filter((effect) => (effect as { type?: string }).type === 'xpGranted');
    expect(grants).toEqual([{ type: 'xpGranted', actionId: `victory:${SLIMES.id}`, actorId: HERO, xp: 10,
      xpToNext: [100, 250, 450, 700, 1000], xpTailGrowthBp: 12_500 }]);
    const rewards = events(last).find((event) => event.type === 'combatRewards')?.rewards?.[0];
    expect(rewards).toMatchObject({ actorId: HERO, xp: 10, levelBefore: 1, levelAfter: 2, xpIntoLevel: 5, xpToNext: 250 });
    expect(viewHero(last.state)).toMatchObject({ level: 2, xp: 105, xpIntoLevel: 5, xpToNext: 250 });
    expect(last.checkpoint).toBe(true); // the effect commits with this very checkpoint
  });

  it('applies the new level from the next encounter only: the finished fight used the old level, the next one the new stats', () => {
    const state = withSlimes(95);
    const engaged = ok(game.applyCommand(state, HERO, { type: 'engage', groupId: SLIMES.id }));
    const levelOneMaxHp = engaged.state.combat?.actors.find((actor) => actor.id === HERO)?.stats.maxHp;
    const { last } = fight(state, SLIMES.id);
    const next = ok(game.applyCommand(last.state, HERO, { type: 'engage', groupId: SLIMES_2.id }));
    const levelTwoMaxHp = next.state.combat?.actors.find((actor) => actor.id === HERO)?.stats.maxHp;
    expect(levelOneMaxHp).toBeDefined();
    expect(levelTwoMaxHp).toBeGreaterThan(levelOneMaxHp as number);
    expect(viewHero(last.state)?.maxHp).toBe(levelTwoMaxHp); // idle view also shows the new level's stats
    // The checkpoint taken at the victory restores the level together with the XP that caused it.
    const restored = game.restore(JSON.parse(JSON.stringify(game.serialize(last.state))) as JsonValue);
    expect(viewHero(restored)).toMatchObject({ level: 2, xp: 105 });
  });

  it('keeps XP of earlier victories and returning to the Sanctuary grants nothing', () => {
    const first = fight(withSlimes(0), SLIMES.id).last;
    const second = fight(first.state, SLIMES_2.id).last;
    expect(viewHero(second.state)).toMatchObject({ level: 1, xp: 20 });
    expect((second.effects ?? []).filter((effect) => (effect as { type?: string }).type === 'xpGranted')).toHaveLength(1);
    expect(new Set([first, second].flatMap((step) => (step.effects ?? []).map((effect) => (effect as { actionId?: string }).actionId)))
      .size).toBe(2); // distinct victory actions have distinct idempotency keys
    const returned = ok(game.applyCommand(second.state, HERO, { type: 'returnToSanctuary' }));
    expect(returned.close?.outcome).toBe('returned');
    expect((returned.effects ?? []).filter((effect) => (effect as { type?: string }).type === 'xpGranted')).toEqual([]);
    expect(viewHero(returned.state)).toMatchObject({ level: 1, xp: 20 });
  });

  it('keeps levelling past the old cap: the curve is open-ended (#129)', () => {
    // Level 6 with 1245 XP into the level (total 3745); +10 XP crosses 3750 into level 7 (1562 XP to level 8).
    const { last } = fight(withSlimes(1245, 6), SLIMES.id);
    const rewards = events(last).find((event) => event.type === 'combatRewards')?.rewards?.[0];
    expect(rewards).toMatchObject({ actorId: HERO, xp: 10, levelBefore: 6, levelAfter: 7, xpIntoLevel: 5, xpToNext: 1562 });
    expect(viewHero(last.state)).toMatchObject({ level: 7, xp: 3755, xpIntoLevel: 5, xpToNext: 1562 });
  });

  it('applies only the level-scaled death penalty at death (earned XP stays), may lose one level, never goes below level 1 / zero XP', () => {
    // Level 2 with 20 XP into the level (total 120): victory +10 -> 130, then the warden pack kills the hero and the
    // penalty floor(130 x 9.8%) = 12 (level 2 loses 980 bp) leaves total 118, still level 2 (the level starts at 100).
    const won = fight(withSlimes(20, 2), SLIMES.id).last;
    expect(viewHero(won.state)).toMatchObject({ level: 2, xp: 130 });
    const died = fight(won.state, WARDENS.id).last;
    const dead = events(died).find((event) => event.type === 'heroDied');
    expect(dead).toMatchObject({ actorId: HERO, xpLost: 12, levelBefore: 2, levelAfter: 2 });
    expect(viewHero(died.state)).toMatchObject({ level: 2, xp: 118 });
    expect((died.effects ?? []).filter((effect) => (effect as { type?: string }).type === 'xpGranted')).toEqual([]);
    const deathEffects = (died.effects ?? []).filter((effect) => (effect as { type?: string }).type === 'heroDied');
    expect(deathEffects).toHaveLength(1);
    expect(deathEffects[0]).toMatchObject({ xpToNext: [100, 250, 450, 700, 1000], xpTailGrowthBp: 12_500 });
    // De-level: total 100 (level 2, 0 into the level) loses floor(9.8) = 9 -> 91 -> level 1.
    const delevelled = fight(withSlimes(0, 2), WARDENS.id).last;
    expect(events(delevelled).find((event) => event.type === 'heroDied')).toMatchObject({ xpLost: 9, levelBefore: 2, levelAfter: 1 });
    expect(viewHero(delevelled.state)).toMatchObject({ level: 1, xp: 91 });
    // Level 6 with 200 into the level (total 2700) loses floor(2700 x 9%) = 243 -> 2457: one level down (level 5 starts at 1500).
    const sixth = fight(withSlimes(200, 6), WARDENS.id).last;
    expect(events(sixth).find((event) => event.type === 'heroDied')).toMatchObject({ xpLost: 243, levelBefore: 6, levelAfter: 5 });
    expect(viewHero(sixth.state)).toMatchObject({ level: 5, xp: 2457 });
    // Past the old cap: level 7 with 300 into the level (total 4050) loses floor(4050 x 8.8%) = 356 -> 3694 (level 6).
    const seventh = fight(withSlimes(300, 7), WARDENS.id).last;
    expect(events(seventh).find((event) => event.type === 'heroDied')).toMatchObject({ xpLost: 356, levelBefore: 7, levelAfter: 6 });
    expect(viewHero(seventh.state)).toMatchObject({ level: 6, xp: 3694 });
    // Level 1 with 0 XP loses nothing.
    const floor = fight(withSlimes(0), WARDENS.id).last;
    expect(events(floor).find((event) => event.type === 'heroDied')).toMatchObject({ xpLost: 0, levelBefore: 1, levelAfter: 1 });
    expect(viewHero(floor.state)).toMatchObject({ level: 1, xp: 0 });
  });

  it('restores a checkpoint saved at the old cap with overflow XP at its real level (#129)', () => {
    // Saved before the open-ended curve: level 6 with 4000 total XP in the state (the new curve says level 7).
    const state = withSlimes(1000, 6);
    const legacy = JSON.parse(JSON.stringify(game.serialize(state))) as { heroes: { xp: number; build: { level: number } }[] };
    legacy.heroes[0] = { ...(legacy.heroes[0] as { xp: number; build: { level: number } }), xp: 4000 };
    const restored = game.restore(legacy as unknown as JsonValue);
    expect(viewHero(restored)).toMatchObject({ level: 7, xp: 4000, xpIntoLevel: 250, xpToNext: 1562 });
  });
});

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
    expect(game.view(state)).toMatchObject({ canRetreat: false, retreatBlockedReason: 'not_in_combat' });
    expect(game.applyCommand(state, HERO, { type: 'engage' })).toEqual({ rejected: 'malformed' });
    expect(game.applyCommand(state, HERO, { type: 'travel', exitId: 'x', extra: 1 })).toEqual({ rejected: 'malformed' });
    expect(game.applyCommand(state, HERO, { type: 'setAuto', auto: false })).toEqual({ rejected: 'not_in_combat' });
    expect(game.applyCommand(state, HERO, { type: 'retreat' })).toEqual({ rejected: 'not_in_combat' });
    expect(game.applyCommand(state, ALLY, { type: 'retreat' })).toEqual({ rejected: 'not_present' });
    const engaged = ok(game.applyCommand(state, HERO, { type: 'engage', groupId: SLIMES.id }));
    expect(game.view(engaged.state)).toMatchObject({ canRetreat: true, retreatBlockedReason: null });
    const missingGroup = structuredClone(engaged.state);
    missingGroup.combatGroup = 'group:missing';
    expect(game.view(missingGroup)).toMatchObject({ canRetreat: false, retreatBlockedReason: 'unknown_group' });
    for (const command of [{ type: 'returnToSanctuary' }, travel('exit:test_grove.glade.entrance'), { type: 'engage', groupId: WARDENS.id },
      { type: 'interact', hotspotId: 'old_stump' }, { type: 'gather', nodeId: 'res:test_grove.herb_patch#0' }]) {
      expect(game.applyCommand(engaged.state, HERO, command)).toEqual({ rejected: 'in_combat' });
    }
    expect(game.removeParticipant(engaged.state, HERO)).toBeNull();
    expect(game.removeParticipant(state, HERO)?.state.heroes[0]?.present).toBe(false);
  });

  it('projects live combat HP and potion stock, and a carried potion resolves and decrements its stock', () => {
    const state = start({ location: GLADE, groups: [SLIMES], heroes: [hero(HERO, {
      rules: [], consumables: [{ item: 'item:minor_healing_potion', qty: 1 }],
    })] });
    const engaged = ok(game.applyCommand(state, HERO, { type: 'engage', groupId: SLIMES.id }));
    let current = game.tick(engaged.state).state;
    const actor = () => {
      const found = current.combat?.actors.find(candidate => candidate.id === HERO);
      if (!found) throw new Error('combat hero is missing');
      return found;
    };
    expect((game.view(current) as { heroes: { actorId: string; automationEnabled: boolean }[] })
      .heroes.find(candidate => candidate.actorId === HERO)?.automationEnabled).toBe(true);
    let ticks = 0;
    while (actor().hp === actor().stats.maxHp && ticks < 100) {
      current = game.tick(current).state;
      ticks += 1;
    }
    expect(actor()).toBeDefined();
    expect(actor().hp).toBeLessThan(actor().stats.maxHp);
    expect((game.view(current) as { heroes: { actorId: string; hp: number | null; consumables: { qty: number }[] }[] })
      .heroes.find(candidate => candidate.actorId === HERO)).toMatchObject({
        hp: actor().hp, consumables: [{ qty: 1 }],
      });

    const queued = ok(game.applyCommand(current, HERO, { type: 'useConsumable', itemId: 'item:minor_healing_potion' }));
    expect(queued.state.pending).toContainEqual({ actorId: HERO, kind: 'useConsumable', item: 'item:minor_healing_potion' });
    const resolved = game.tick(queued.state);
    current = resolved.state;
    const events = resolved.events as { type: string; event?: { type: string; actorId?: string; targetId?: string; item?: string; remaining?: number; amount?: number } }[];
    expect(events).toContainEqual(expect.objectContaining({ type: 'combat', event: expect.objectContaining({
      type: 'ConsumableUsed', actorId: HERO, item: 'item:minor_healing_potion', remaining: 0,
    }) }));
    expect(events.some(({ type, event }) => type === 'combat' && event?.type === 'Healed' && event.targetId === HERO && (event.amount ?? 0) > 0)).toBe(true);
    expect((game.view(resolved.state) as { heroes: { actorId: string; hp: number | null; consumables: { qty: number }[] }[] })
      .heroes.find(candidate => candidate.actorId === HERO)).toMatchObject({
        hp: actor().hp, consumables: [{ qty: 0 }],
      });
    // The snapshot remains unchanged mid-fight; the public view must use the combat actor as its live source.
    expect(resolved.state.heroes[0]?.consumables).toEqual([{ item: 'item:minor_healing_potion', qty: 1 }]);

    // The in-combat snapshot still advertises the starting stock, so the host may ack a second queue;
    // the engine rejects it against live actor stock when the hero next acts.
    const staleStockQueue = ok(game.applyCommand(current, HERO, { type: 'useConsumable', itemId: 'item:minor_healing_potion' }));
    current = staleStockQueue.state;
    let missingStock: { type: string; event?: { type: string; reason?: string } } | undefined;
    for (let ticks = 0; ticks < 20 && missingStock === undefined; ticks += 1) {
      const next = game.tick(current);
      missingStock = (next.events as { type: string; event?: { type: string; reason?: string } }[])
        .find(({ type, event }) => type === 'combat' && event?.type === 'InputRejected' && event.reason === 'noConsumable');
      current = next.state;
    }
    expect(missingStock?.event).toMatchObject({ type: 'InputRejected', reason: 'noConsumable' });
  });

  it('reports queued manual skill cooldown rejection without changing the cooldown', () => {
    const state = start({ location: GLADE, groups: [SLIMES], heroes: [hero(HERO, { rules: [] })] });
    const engaged = ok(game.applyCommand(state, HERO, { type: 'engage', groupId: SLIMES.id }));
    const paused = ok(game.applyCommand(engaged.state, HERO, { type: 'setAuto', auto: false }));
    const firstSkill = ok(game.applyCommand(paused.state, HERO, { type: 'useSkill', skill: 'skill:shield_bash' }));
    let current = game.tick(firstSkill.state).state;
    const actor = () => {
      const found = current.combat?.actors.find(candidate => candidate.id === HERO);
      if (!found) throw new Error('combat hero is missing');
      return found;
    };
    expect(actor().cooldowns['skill:shield_bash']).toBeGreaterThan(current.combat?.tick ?? 0);
    const readyAtTick = actor().cooldowns['skill:shield_bash'];
    const queuedAgain = ok(game.applyCommand(current, HERO, { type: 'useSkill', skill: 'skill:shield_bash' }));
    expect(queuedAgain.state.pending).toContainEqual({ actorId: HERO, kind: 'useSkill', skill: 'skill:shield_bash' });
    let rejection: { type: string; event?: { type: string; reason?: string } } | undefined;
    current = queuedAgain.state;
    for (let ticks = 0; ticks < 20 && rejection === undefined; ticks += 1) {
      const next = game.tick(current);
      rejection = (next.events as { type: string; event?: { type: string; reason?: string } }[])
        .find(({ type, event }) => type === 'combat' && event?.type === 'InputRejected' && event.reason === 'onCooldown');
      current = next.state;
    }
    expect(rejection?.event).toMatchObject({ type: 'InputRejected', reason: 'onCooldown' });
    expect(actor().cooldowns['skill:shield_bash']).toBe(readyAtTick);
  });
});

describe('RPG live plugin: scene geometry (#154)', () => {
  // The fixture below overrides the authored Region 1 geometry with simple rects over real lantern_ruins IDs (a secret exit, a flag hotspot).
  const RUINS = R1('lantern_ruins');
  const rect = (x: number, y: number) => ({ x, y, width: 40, height: 20 });
  const sceneGame = createRpgLiveGame({ ...compiled.bundle, scenes: { [RUINS]: { width: 543, height: 724, background: 'scenes/region_1/lantern_ruins.png',
    exits: { [EXIT('lantern_ruins', 'tangle_orchard')]: rect(0, 100), [EXIT('lantern_ruins', 'pump_station')]: rect(100, 100),
      [EXIT('lantern_ruins', 'sunken_greenhouse')]: { x: 200, y: 301, width: 20, height: 41 } },
    hotspots: { cracked_panel: rect(300, 400) }, enemyAnchors: {}, resources: { 'res:alloy_scrap#0': { x: 5, y: 5 } } } } });
  const sceneOf = (view: unknown) => (view as { scene?: { width: number; height: number; regions: { id: string; kind: string; x: number; y: number; r: number }[] } }).scene;
  const atRuins = () => run(region1(), ...TO_PUMP, travel(EXIT('pump_station', 'lantern_ruins')));

  it('never sends a region for an undiscovered secret exit, and sends it once the hatch is found', () => {
    const ruins = atRuins();
    const before = sceneGame.view(ruins, HERO);
    expect(sceneOf(before)).toEqual({ width: 543, height: 724, regions: [
      { id: EXIT('lantern_ruins', 'tangle_orchard'), kind: 'exit', x: 20, y: 110, r: 20 },
      { id: EXIT('lantern_ruins', 'pump_station'), kind: 'exit', x: 120, y: 110, r: 20 },
      { id: 'cracked_panel', kind: 'hotspot', x: 320, y: 410, r: 20 }] });
    expect(JSON.stringify(before)).not.toContain('sunken_greenhouse');
    const searched = ok(sceneGame.applyCommand(ruins, HERO, { type: 'interact', hotspotId: 'cracked_panel' })).state;
    const after = sceneGame.view(searched, HERO);
    expect(sceneOf(after)?.regions.map((region) => region.id)).toContain(EXIT('lantern_ruins', 'sunken_greenhouse'));
    expect(sceneOf(after)?.regions.find((region) => region.id === EXIT('lantern_ruins', 'sunken_greenhouse'))).toMatchObject({ x: 210, y: 322, r: 21 });
    // Every region matches an exit or hotspot of the same view, whose state (open, done) the client reads from there.
    const listed = new Set([...(after as { exits: { id: string }[] }).exits, ...(after as { hotspots: { id: string }[] }).hotspots].map((entry) => entry.id));
    for (const region of sceneOf(after)?.regions ?? []) expect(listed.has(region.id)).toBe(true);
  });

  it('omits scene for locations without geometry and when the bundle has no scenes', () => {
    const noScenes = createRpgLiveGame({ ...compiled.bundle, scenes: {} });
    expect(sceneOf(sceneGame.view(region1(), HERO))).toBeUndefined();
    expect(sceneOf(noScenes.view(atRuins(), HERO))).toBeUndefined();
    expect('scene' in (noScenes.view(atRuins(), HERO) as object)).toBe(false);
  });

  it('sends the authored Region 1 geometry (#168), and still hides the secret exit region until the hatch is found', () => {
    const view = sceneOf(game.view(atRuins(), HERO));
    expect(view).toMatchObject({ width: 1086, height: 1448 });
    const ids = view?.regions.map((region) => region.id);
    expect(ids).toEqual([EXIT('lantern_ruins', 'tangle_orchard'), EXIT('lantern_ruins', 'pump_station'), 'cracked_panel']);
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
    expect(game.view(entered.state)).toMatchObject({ canRetreat: false, retreatBlockedReason: 'boss' });
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

  it('blocks retreat from an ordinary group in a boss room', () => {
    const state = start({ area: 'area:region_1', location: R1('seed_vault_heart'), groups: [SLIMES], heroes: [hero()] });
    const engaged = ok(game.applyCommand(state, HERO, { type: 'engage', groupId: SLIMES.id }));
    expect(engaged.state.visited[R1('seed_vault_heart')]?.groups[0]?.boss).toBe(false);
    expect(game.view(engaged.state)).toMatchObject({ canRetreat: false, retreatBlockedReason: 'boss' });
    expect(game.applyCommand(engaged.state, HERO, { type: 'retreat' })).toEqual({ rejected: 'retreat_not_allowed' });
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
