import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { LiveJson, LiveServerFrame, LiveViewDto } from '@rpg/protocol';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LiveState } from '../state.ts';
import { LiveCombat } from './LiveCombat.tsx';

const actorId = '0b6f4d1e-8f43-4f1c-9a52-1d6a2f7c9e10';
const enemyId = 'enemy:ogre';
const online: LiveState = { status: 'open', attempt: 0, retryInMs: null, lastCloseCode: null, error: null };
const offline: LiveState = { ...online, status: 'reconnecting', retryInMs: 500 };
const ack = (status: 'applied' | 'rejected', reason?: string): Extract<LiveServerFrame, { type: 'live.ack' }> => ({
  type: 'live.ack', instanceId: 'instance', commandId: 'command', status, duplicate: false,
  ...(status === 'rejected' ? { reason: reason ?? 'onCooldown' } : {}),
});

function view(overrides: Record<string, unknown> = {}): LiveViewDto {
  return {
    phase: 'combat', heroes: [{ actorId, hp: 60, maxHp: 100, present: true, consumables: [{ item: 'item:potion', qty: 2 }],
      skills: [{ id: 'skill:guard', labelKey: 'skill.guard', slot: 0, cooldownRemainingTicks: 0, cooldownTicks: 6, windupTicks: 0 },
        { id: 'skill:cleave', labelKey: 'skill.cleave', slot: 1, cooldownRemainingTicks: 2, cooldownTicks: 8, windupTicks: 0 }],
      automation: { enabled: false } }],
    combat: { tick: 12, groupId: 'ogre', actors: [
      { id: actorId, side: 'hero', hp: 60, maxHp: 100, alive: true, effects: [
        { id: 1, origin: 'skill:guard', originLabelKey: 'skill.guard', type: 'shield', remaining: 3, unit: 'actions', amount: 12 },
      ], auto: false, queued: null, windup: null },
      { id: enemyId, labelKey: 'enemy.ogre', side: 'enemy', hp: 80, maxHp: 100, alive: true, effects: [], auto: false, queued: null,
        windup: { skill: 'skill:heavy_strike', skillLabelKey: 'skill.heavy_strike', targetIds: [actorId], startedTick: 10, resolveAtTick: 15 } },
    ] },
    ...overrides,
  } as unknown as LiveViewDto;
}

function renderCombat(options: { snapshot?: LiveViewDto; pending?: string[]; ack?: Extract<LiveServerFrame, { type: 'live.ack' }> | null; connection?: LiveState; events?: { epoch: number; seq: number; source: 'game'; event: LiveJson }[] } = {}) {
  const submit = vi.fn(() => 'command-id');
  const props = { view: options.snapshot ?? view(), actorId, events: options.events ?? [], pendingCommandIds: options.pending ?? [],
    lastAck: options.ack ?? null, connection: options.connection ?? online, onSubmit: submit };
  const result = render(<LiveCombat {...props} />);
  return { ...result, submit, props };
}

describe('LiveCombat', () => {
  afterEach(cleanup);

  it('shows an authoritative telegraph countdown and submits one manual response without re-render duplicates', () => {
    const { rerender, submit, props } = renderCombat({ events: [{ epoch: 1, seq: 1, source: 'game', event: {
      type: 'combat', event: { type: 'TelegraphStarted', actorId: enemyId, skill: 'skill:heavy_strike', tick: 10, resolveAtTick: 15 },
    } as unknown as LiveJson }] });
    expect(screen.getByText('Resolves in 3 ticks')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Slot 1.*Guard/i }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ type: 'useSkill', skill: 'skill:guard' });
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
    expect(screen.getByText(/Cooldown 2 ticks/)).toBeTruthy();
  });

  it('keeps pending actions visible while disconnected, disables new submits, and reports server rejection', () => {
    const { submit } = renderCombat({ connection: offline, pending: ['pending-command'], ack: ack('rejected', 'onCooldown') });
    expect(screen.getByText(/Offline · actions paused/)).toBeTruthy();
    expect(screen.getByText('Action awaiting server acknowledgement.')).toBeTruthy();
    expect(screen.getByText(/server rejected.*onCooldown/i)).toBeTruthy();
    const skill = screen.getByRole('button', { name: /Slot 1.*Guard/i }) as HTMLButtonElement;
    expect(skill.disabled).toBe(true);
    fireEvent.click(skill);
    expect(submit).not.toHaveBeenCalled();
  });

  it('submits auto and consumable intents, shows stock, and expands the combat event log', () => {
    const { submit } = renderCombat({ events: [{ epoch: 1, seq: 2, source: 'game', event: {
      type: 'combat', event: { type: 'DamageDealt', sourceId: enemyId, targetId: actorId, amount: 7, tick: 12 },
    } as unknown as LiveJson }] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto' }));
    fireEvent.click(screen.getByRole('button', { name: /Use potion.*Stock 2/i }));
    expect(submit).toHaveBeenNthCalledWith(1, { type: 'setAuto', auto: true });
    expect(submit).toHaveBeenNthCalledWith(2, { type: 'useConsumable', itemId: 'item:potion' });
    fireEvent.click(screen.getByRole('button', { name: /Combat log/ }));
    expect(within(screen.getByRole('list', { name: 'Combat event log' })).getByText(/DamageDealt/)).toBeTruthy();
  });

  it('reports applied acknowledgement and keeps reduced-motion behavior in CSS', () => {
    renderCombat({ ack: ack('applied') });
    expect(screen.getByText('Last action accepted by the server.')).toBeTruthy();
    const css = readFileSync('games/rpg/apps/web/src/live/combat/combat.css', 'utf8');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('transition: none');
  });
});
