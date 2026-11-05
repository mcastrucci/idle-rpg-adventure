import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { LiveCombatActorDto, LiveJson, LiveViewDto, LiveWindupDto } from '@rpg/protocol';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '../../i18n/index.ts';
import type { LiveState } from '../state.ts';
import { LiveCombat } from './LiveCombat.tsx';

const actorId = '0b6f4d1e-8f43-4f1c-9a52-1d6a2f7c9e10';
const enemyId = 'enemy:ogre';
const online: LiveState = { status: 'open', attempt: 0, retryInMs: null, lastCloseCode: null, error: null };
const offline: LiveState = { ...online, status: 'reconnecting', retryInMs: 500 };
function view(overrides: Record<string, unknown> = {}): LiveViewDto {
  return {
    phase: 'combat', heroes: [{ actorId, hp: 60, maxHp: 100, present: true, consumables: [{ item: 'item:potion', qty: 2 }],
      skills: [{ id: 'skill:shield_bash', labelKey: 'skill.shield_bash.name', slot: 0, cooldownRemainingTicks: 0, cooldownTicks: 6, windupTicks: 0 },
        { id: 'skill:cleave', labelKey: 'skill.cleave.name', slot: 1, cooldownRemainingTicks: 2, cooldownTicks: 8, windupTicks: 0 }],
      automation: { enabled: false } }],
    combat: { tick: 12, groupId: 'ogre', actors: [
      { id: actorId, side: 'hero', hp: 60, maxHp: 100, alive: true, effects: [
        { id: 1, origin: 'skill:guard', originLabelKey: 'skill.guard', type: 'shield', remaining: 3, unit: 'actions', amount: 12 },
      ], auto: false, queued: null, windup: null },
      { id: 'enemy:thornback_boar', labelKey: 'enemy.thornback_boar.name', side: 'enemy', hp: 80, maxHp: 100, alive: true, effects: [], auto: false, queued: null,
        windup: { skill: 'skill:heavy_strike', labelKey: 'skill.heavy_strike.name', targetIds: [actorId], startedTick: 10, resolveAtTick: 15 } },
    ] },
    ...overrides,
  } as unknown as LiveViewDto;
}

function renderCombat(options: { snapshot?: LiveViewDto; pending?: string[]; connection?: LiveState; events?: { epoch: number; seq: number; source: 'game'; event: LiveJson }[] } = {}) {
  const submit = vi.fn(() => 'command-id');
  const props = { view: options.snapshot ?? view(), actorId, events: options.events ?? [], pendingCommandIds: options.pending ?? [],
    connection: options.connection ?? online, onSubmit: submit };
  const result = render(<LiveCombat {...props} />);
  return { ...result, submit, props };
}

describe('LiveCombat', () => {
  afterEach(() => { cleanup(); setLocale('en', { persist: false }); });

  it('names the telegraphed skill from the protocol windup labelKey in the active locale', () => {
    // Typed with the protocol DTOs, so a renamed or misspelled field fails the type check.
    const windup: LiveWindupDto = { skill: 'skill:unlisted_slam', labelKey: 'skill.crushing_blow.name', targetIds: [actorId], startedTick: 10, resolveAtTick: 15 };
    const boar: LiveCombatActorDto = { id: 'enemy:thornback_boar', labelKey: 'enemy.thornback_boar.name', side: 'enemy', hp: 80, maxHp: 100, alive: true, effects: [], queued: null, windup };
    const snapshot = view({ combat: { tick: 12, groupId: 'ogre', actors: [
      { id: actorId, side: 'hero', hp: 60, maxHp: 100, alive: true, effects: [], auto: false, queued: null, windup: null }, boar,
    ] } });
    const en = renderCombat({ snapshot });
    expect(screen.getByText(/is winding up Crushing Blow/)).toBeTruthy();
    expect(screen.queryByText(/Unlisted Slam/i)).toBeNull();
    en.unmount();
    setLocale('es', { persist: false });
    renderCombat({ snapshot });
    expect(screen.getByText(/Golpe Aplastante/)).toBeTruthy();
  });

  it('shows an authoritative telegraph countdown and submits one manual response without re-render duplicates', () => {
    const { rerender, submit, props } = renderCombat({ events: [{ epoch: 1, seq: 1, source: 'game', event: {
      type: 'combat', event: { type: 'TelegraphStarted', actorId: enemyId, skill: 'skill:heavy_strike', tick: 10, resolveAtTick: 15 },
    } as unknown as LiveJson }] });
    expect(screen.getByText('Resolves in 3 ticks')).toBeTruthy();
    expect(screen.getByText('Target: You')).toBeTruthy();
    expect(screen.getByText('Shield Bash')).toBeTruthy();
    expect(screen.getByText(/Thornback Boar is winding up Heavy Strike/)).toBeTruthy();
    expect(screen.getByText('80% HP')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Slot 1.*Shield Bash/i }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ type: 'useSkill', skill: 'skill:shield_bash' });
    rerender(<LiveCombat {...props} view={view({ combat: { ...(view() as unknown as { combat: object }).combat, tick: 13 } })} />);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Resolves in 2 ticks')).toBeTruthy();
  });

  it('renders effect durations with their declared units, skill cooldowns and server queued input', () => {
    const snapshot = view({ combat: { tick: 12, groupId: 'ogre', actors: [
      { id: actorId, side: 'hero', hp: 60, maxHp: 100, alive: true, effects: [
        { id: 5, origin: 'skill:poison', type: 'dot', remaining: 4, unit: 'attacks', school: 'nature' },
      ], auto: false, queued: { kind: 'useSkill', skill: 'skill:cleave', target: null }, windup: null },
      { id: enemyId, side: 'enemy', hp: 80, maxHp: 100, alive: true, effects: [], queued: null, windup: null },
    ] } });
    renderCombat({ snapshot });
    expect(screen.getByText(/4 attacks remaining/)).toBeTruthy();
    expect(screen.getByText(/Queued:/)).toBeTruthy();
    expect(screen.getByText(/Cooldown remaining: 2 ticks/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Slot 2.*Cleave/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/click replaces your single queued action/i)).toBeTruthy();
  });

  it('keeps pending actions visible while disconnected, disables new submits, and reports server rejection', () => {
    const { submit } = renderCombat({ connection: offline, pending: ['pending-command'], events: [
      { epoch: 1, seq: 1, source: 'game', event: { type: 'combatStarted', groupId: 'ogre' } as unknown as LiveJson },
      { epoch: 1, seq: 2, source: 'game', event: { type: 'combat', event: { type: 'InputRejected', actorId, kind: 'useSkill', reason: 'onCooldown' } } as unknown as LiveJson },
    ] });
    expect(screen.getByText(/Offline · actions paused/)).toBeTruthy();
    expect(screen.getByText('Command sent; waiting for server receipt.')).toBeTruthy();
    expect(screen.getByText(/Your skill was rejected: on cooldown/i)).toBeTruthy();
    const skill = screen.getByRole('button', { name: /Slot 1.*Shield Bash/i }) as HTMLButtonElement;
    expect(skill.disabled).toBe(true);
    fireEvent.click(skill);
    expect(submit).not.toHaveBeenCalled();
  });

  it('submits auto and consumable intents, shows stock, and expands the combat event log', () => {
    const { submit } = renderCombat({ events: [{ epoch: 1, seq: 2, source: 'game', event: {
      type: 'combat', event: { type: 'DamageDealt', sourceId: enemyId, targetId: actorId, amount: 7, tick: 12 },
    } as unknown as LiveJson }] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto' }));
    fireEvent.click(screen.getByRole('button', { name: /Use Potion.*Stock 2/i }));
    expect(submit).toHaveBeenNthCalledWith(1, { type: 'setAuto', auto: true });
    expect(submit).toHaveBeenNthCalledWith(2, { type: 'useConsumable', itemId: 'item:potion' });
    fireEvent.click(screen.getByRole('button', { name: /Combat log/ }));
    expect(within(screen.getByRole('list', { name: 'Combat event log' })).getByText(/Ogre dealt 7 damage to You/)).toBeTruthy();
  });

  it('keeps reduced-motion behavior in CSS', () => {
    renderCombat();
    const css = readFileSync('games/rpg/apps/web/src/live/combat/combat.css', 'utf8');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('transition: none');
  });

  it('keeps the warning region mounted as attacks begin and resolve', () => {
    const active = view();
    const combat = active.combat;
    if (!combat) throw new Error('Expected combat in fixture');
    const idle = { ...active, combat: { ...combat, actors: combat.actors.map((actor) => ({ ...actor, windup: null })) } };
    const { container, props, rerender } = renderCombat({ snapshot: idle });
    const warnings = container.querySelector('.live-combat__telegraphs');
    const controls = container.querySelector('.live-combat__controls');
    expect(warnings?.nextElementSibling).toBe(controls);
    expect(warnings?.childElementCount).toBe(0);

    rerender(<LiveCombat {...props} view={active} />);
    expect(warnings?.querySelector('[role="status"]')).toBeTruthy();
    expect(warnings?.nextElementSibling).toBe(controls);

    rerender(<LiveCombat {...props} view={idle} />);
    expect(warnings?.childElementCount).toBe(0);
    expect(warnings?.nextElementSibling).toBe(controls);
  });

  it('renders compact party frames with a clear own-hero marker and accessible authoritative HP', () => {
    const base = view() as unknown as { combat: { actors: Array<Record<string, unknown>> } };
    const party = [actorId, '2b6f4d1e-8f43-4f1c-9a52-1d6a2f7c9e11', '3b6f4d1e-8f43-4f1c-9a52-1d6a2f7c9e12', '4b6f4d1e-8f43-4f1c-9a52-1d6a2f7c9e13'];
    const snapshot = view({ combat: { ...base.combat, actors: [
      ...party.map((id, index) => ({ id, side: 'hero', hp: 60 - index, maxHp: 100, alive: true, effects: [], queued: null, windup: null })),
      ...base.combat.actors.filter((actor) => actor['side'] === 'enemy'),
    ] } });
    const { container } = renderCombat({ snapshot });
    const partyGrid = container.querySelector('.live-combat__actor-grid--hero');
    expect(partyGrid?.children).toHaveLength(4);
    expect(partyGrid?.querySelector('.live-combat__actor--self')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'You HP 60 of 100' }).getAttribute('aria-valuenow')).toBe('60');
    expect(screen.getByRole('button', { name: /Combat log/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps ally queues in their frames without presenting them as my pending action', () => {
    const snapshot = view({ combat: { tick: 12, groupId: 'ogre', actors: [
      { id: actorId, side: 'hero', hp: 60, maxHp: 100, alive: true, effects: [], auto: false,
        queued: { kind: 'useSkill', skill: 'skill:cleave', target: null }, windup: null },
      { id: '2b6f4d1e-8f43-4f1c-9a52-1d6a2f7c9e11', side: 'hero', hp: 50, maxHp: 100, alive: true, effects: [], auto: false,
        queued: { kind: 'useSkill', skill: 'skill:shield_bash', target: null }, windup: null },
      { id: enemyId, side: 'enemy', hp: 80, maxHp: 100, alive: true, effects: [], queued: null, windup: null },
    ] } });
    const { container } = renderCombat({ snapshot });
    expect(screen.getByText('Queued: Cleave')).toBeTruthy();
    expect(container.querySelector('.live-combat__actor-grid--hero')?.textContent).toContain('Shield Bash');
    expect(screen.queryByText(/Queued: .*Shield Bash/)).toBeNull();
  });

  it('submits retreat only when the server projection allows it and explains a boss lock', () => {
    const allowed = view({ canRetreat: true, retreatBlockedReason: null });
    const { submit, rerender, props } = renderCombat({ snapshot: allowed });
    const retreat = screen.getByRole('button', { name: 'Retreat' }) as HTMLButtonElement;
    expect(retreat.disabled).toBe(false);
    expect(screen.getByText('Retreat returns the party to its previous location, when available, at an HP cost. The encounter remains undefeated.')).toBeTruthy();
    fireEvent.click(retreat);
    expect(submit).toHaveBeenCalledWith({ type: 'retreat' });

    const boss = view({ canRetreat: false, retreatBlockedReason: 'boss' });
    rerender(<LiveCombat {...props} view={boss} />);
    expect((screen.getByRole('button', { name: 'Retreat' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Retreat is unavailable during a boss encounter.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retreat' }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('disables retreat while offline, while a command is pending, or when my hero is down', () => {
    const allowed = view({ canRetreat: true, retreatBlockedReason: null });
    const { rerender, props } = renderCombat({ snapshot: allowed });
    const button = () => screen.getByRole('button', { name: 'Retreat' }) as HTMLButtonElement;

    rerender(<LiveCombat {...props} view={allowed} pendingCommandIds={['pending']} />);
    expect(button().disabled).toBe(true);
    expect(screen.getByText('Wait for the pending command to be confirmed.')).toBeTruthy();

    rerender(<LiveCombat {...props} view={allowed} connection={offline} />);
    expect(button().disabled).toBe(true);
    expect(screen.getByText('Reconnect before retreating.')).toBeTruthy();

    const combat = (allowed as unknown as { combat: { actors: Array<Record<string, unknown>> } }).combat;
    const down = view({ canRetreat: true, retreatBlockedReason: null, combat: { ...combat,
      actors: combat.actors.map((actor) => actor['id'] === actorId ? { ...actor, alive: false } : actor) } });
    rerender(<LiveCombat {...props} view={down} />);
    expect(button().disabled).toBe(true);
    expect(screen.getByText('A living hero is required to retreat.')).toBeTruthy();
  });

  it('shows actual own-action queue, rejection, and activation from production event wrappers only', () => {
    const actionEvent = (payload: Record<string, unknown>, seq: number) => ({ epoch: 1, seq, source: 'game' as const,
      event: { type: 'combat', event: payload } as unknown as LiveJson });
    const snapshot = view({ combat: { tick: 14, groupId: 'ogre', actors: [
      { id: actorId, side: 'hero', hp: 60, maxHp: 100, alive: true, effects: [], auto: false,
        queued: { kind: 'useConsumable', item: 'item:potion', target: null }, windup: null },
      { id: enemyId, side: 'enemy', hp: 80, maxHp: 100, alive: true, effects: [], queued: null, windup: null },
    ] } });
    const { rerender, props } = renderCombat({ snapshot, events: [
      actionEvent({ type: 'combatStarted', groupId: 'ogre', tick: 1 }, 1),
      actionEvent({ type: 'InputRejected', actorId, kind: 'useSkill', reason: 'onCooldown', tick: 12 }, 2),
    ] });
    expect(screen.getByText(/Queued: item Potion/i)).toBeTruthy();
    expect(screen.getByText(/Your skill was rejected: on cooldown/i)).toBeTruthy();
    rerender(<LiveCombat {...props} events={[...props.events, actionEvent({ type: 'ActionStarted', actorId,
      action: { kind: 'skill', skill: 'skill:shield_bash' }, source: 'auto', tick: 14 }, 3)]} />);
    expect(screen.getByText(/Your skill was rejected: on cooldown/i)).toBeTruthy();
    expect(screen.getByText(/You started Shield Bash \(auto\)\./)).toBeTruthy();
  });

  it('retains current fight feedback after its marker leaves the event window and clears it on a new group', () => {
    const wrapped = (event: Record<string, unknown>, seq: number) => ({ epoch: 1, seq, source: 'game' as const,
      event: { type: 'combat', event } as unknown as LiveJson });
    const start = { epoch: 1, seq: 1, source: 'game' as const,
      event: { type: 'combatStarted', groupId: 'ogre' } as unknown as LiveJson };
    const first = renderCombat({ events: [start, wrapped({ type: 'InputRejected', actorId, kind: 'useSkill', reason: 'onCooldown' }, 2)] });
    expect(screen.getByText(/Your skill was rejected: on cooldown/i)).toBeTruthy();
    first.rerender(<LiveCombat {...first.props} events={[wrapped({ type: 'DamageDealt', sourceId: enemyId, targetId: actorId, amount: 9, hpAfter: 51 }, 3)]} />);
    expect(screen.getByText(/Your skill was rejected: on cooldown/i)).toBeTruthy();
    expect(screen.getByText(/You took 9 damage; 51 HP remaining/)).toBeTruthy();
    first.rerender(<LiveCombat {...first.props} view={view({ combat: { ...(view() as unknown as { combat: object }).combat, groupId: 'new-group' } })}
      events={[wrapped({ type: 'DamageDealt', sourceId: enemyId, targetId: actorId, amount: 9, hpAfter: 51 }, 3)]} />);
    expect(screen.queryByText(/Your skill was rejected: on cooldown/i)).toBeNull();
    expect(screen.queryByText(/You took 9 damage/)).toBeNull();
  });

  it('clears action feedback when the current combat ends', () => {
    const { rerender, props } = renderCombat({ events: [
      { epoch: 1, seq: 1, source: 'game', event: { type: 'combatStarted', groupId: 'ogre' } as unknown as LiveJson },
      { epoch: 1, seq: 2, source: 'game', event: { type: 'combat', event: { type: 'InputRejected', actorId, kind: 'useSkill', reason: 'onCooldown' } } as unknown as LiveJson },
    ] });
    expect(screen.getByText(/Your skill was rejected: on cooldown/i)).toBeTruthy();
    rerender(<LiveCombat {...props} events={[...props.events, { epoch: 1, seq: 3, source: 'game',
      event: { type: 'combat', event: { type: 'CombatEnded', outcome: 'defeat' } } as unknown as LiveJson }]} />);
    expect(screen.queryByText(/Your skill was rejected: on cooldown/i)).toBeNull();
  });

  it('disables empty stock and does not let prior-combat feedback confirm the current encounter', () => {
    const snapshot = view({ heroes: [{ ...(view() as unknown as { heroes: Array<Record<string, unknown>> }).heroes[0], consumables: [{ item: 'item:potion', qty: 0 }] }] });
    const { submit } = renderCombat({ snapshot, events: [
      { epoch: 1, seq: 1, source: 'game', event: { type: 'combat', event: { type: 'ActionStarted', actorId,
        action: { kind: 'skill', skill: 'skill:shield_bash' }, source: 'manual', tick: 2 } } as unknown as LiveJson },
      { epoch: 1, seq: 2, source: 'game', event: { type: 'combatStarted', groupId: 'ogre', tick: 12 } as unknown as LiveJson },
    ] });
    expect((screen.getByRole('button', { name: /Use Potion.*Stock 0/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/You started Shield Bash \(manual\)\./)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Slot 1.*Shield Bash/i }));
    expect(submit).toHaveBeenCalledWith({ type: 'useSkill', skill: 'skill:shield_bash' });
  });

  it('shows actual potion use and healing with the authoritative zero-stock projection', () => {
    const queuedSnapshot = view({ combat: { tick: 12, groupId: 'ogre', actors: [
      { id: actorId, side: 'hero', hp: 40, maxHp: 100, alive: true, effects: [], auto: false,
        queued: { kind: 'useSkill', skill: 'skill:cleave', target: null }, windup: null },
      { id: enemyId, side: 'enemy', hp: 80, maxHp: 100, alive: true, effects: [], queued: null, windup: null },
    ] } });
    const props = { snapshot: queuedSnapshot, events: [
      { epoch: 1, seq: 1, source: 'game' as const, event: { type: 'combatStarted', groupId: 'ogre' } as unknown as LiveJson },
    ] };
    const { rerender } = renderCombat(props);
    expect(screen.getByText(/Queued: Cleave/)).toBeTruthy();
    const updatedView = view({ heroes: [{ ...(view() as unknown as { heroes: Array<Record<string, unknown>> }).heroes[0],
      hp: 65, consumables: [{ item: 'item:potion', qty: 0 }] }], combat: { tick: 14, groupId: 'ogre', actors: [
      { id: actorId, side: 'hero', hp: 65, maxHp: 100, alive: true, effects: [], auto: false, queued: null, windup: null },
      { id: enemyId, side: 'enemy', hp: 80, maxHp: 100, alive: true, effects: [], queued: null, windup: null },
    ] } });
    rerender(<LiveCombat {...{ view: updatedView, events: [
      ...props.events,
      { epoch: 1, seq: 2, source: 'game' as const, event: { type: 'combat', event: { type: 'ConsumableUsed', actorId,
        item: 'item:potion', remaining: 0, tick: 13 } } as unknown as LiveJson },
      { epoch: 1, seq: 3, source: 'game' as const, event: { type: 'combat', event: { type: 'Healed', sourceId: actorId,
        targetId: actorId, origin: 'item:potion', amount: 25, periodic: false, hpAfter: 65, tick: 13 } } as unknown as LiveJson },
    ], actorId, pendingCommandIds: [], connection: online, onSubmit: vi.fn() }} />);
    expect(screen.queryByText(/Queued: You · Cleave/)).toBeNull();
    expect(screen.getByText(/You healed 25 HP/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Combat log/ }));
    expect(within(screen.getByRole('list', { name: 'Combat event log' })).getByText(/You used Potion; 0 remaining/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Use Potion.*Stock 0/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
