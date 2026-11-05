import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveJson } from '@rpg/protocol';
import { MatriarchCombatScene } from './MatriarchCombatScene.tsx';
const hero = 'actor:max';
const boss = 'group:matriarch#0';
const combat = { groupId: 'group:matriarch', actors: [
  { id: hero, labelKey: 'hero.max.name', side: 'hero' as const, alive: true, hp: 40 },
  { id: boss, labelKey: 'enemy.hollow_matriarch.name', side: 'enemy' as const, alive: true, hp: 100 },
] };
const row = (seq: number, event: Record<string, unknown>) => ({ epoch: 1, seq, source: 'game' as const, event: event as unknown as LiveJson });
afterEach(cleanup);
describe('MatriarchCombatScene', () => {
  it('shows both shipped sprites only in Seed Vault Heart combat', () => {
    const { rerender } = render(<MatriarchCombatScene locationId="loc:region_1.seed_vault_heart" actorId={hero} combat={combat} />);
    expect(screen.getByTestId('matriarch-scene').querySelectorAll('img')).toHaveLength(2);
    rerender(<MatriarchCombatScene locationId="loc:region_1.portal_clearing" actorId={hero} combat={combat} />);
    expect(screen.queryByTestId('matriarch-scene')).toBeNull();
  });
  it('does not replay existing events and animates a new event once', () => {
    const initial = row(1, { type: 'combat', event: { type: 'DamageDealt', sourceId: hero, targetId: boss, amount: 4 } });
    const { rerender } = render(<MatriarchCombatScene locationId="loc:region_1.seed_vault_heart" actorId={hero} combat={combat} events={[initial]} />);
    expect(screen.getByTestId('matriarch-scene').querySelector('.matriarch-scene__sprite--max')?.className).toContain('--idle');
    const attack = row(2, { type: 'combat', event: { type: 'DamageDealt', sourceId: hero, targetId: boss, amount: 7 } });
    rerender(<MatriarchCombatScene locationId="loc:region_1.seed_vault_heart" actorId={hero} combat={combat} events={[initial, attack]} />);
    expect(screen.getByTestId('matriarch-scene').querySelector('.matriarch-scene__sprite--max')?.className).toContain('--attack');
    expect(screen.getByTestId('matriarch-scene').querySelector('.matriarch-scene__sprite--boss')?.className).toContain('--hit');
  });
  it('uses server defeat state for a settled pose', () => {
    const defeated = { ...combat, actors: combat.actors.map((actor) => actor.side === 'enemy' ? { ...actor, alive: false, hp: 0 } : actor) };
    render(<MatriarchCombatScene locationId="loc:region_1.seed_vault_heart" actorId={hero} combat={defeated} />);
    expect(screen.getByTestId('matriarch-scene').querySelector('.matriarch-scene__sprite--boss')?.className).toContain('--defeat');
  });
  it('keeps a truthful victory pose when the server clears the combat projection', () => {
    const { rerender } = render(<MatriarchCombatScene locationId="loc:region_1.seed_vault_heart" actorId={hero} combat={combat} events={[]} />);
    const victory = row(1, { type: 'combatEnded', outcome: 'victory', groupId: 'group:matriarch' });
    rerender(<MatriarchCombatScene locationId="loc:region_1.seed_vault_heart" actorId={hero} combat={null} events={[victory]} />);
    expect(screen.getByTestId('matriarch-scene').querySelector('.matriarch-scene__sprite--boss')?.className).toContain('--defeat');
  });

  it('ignores a victory from an unrelated historical group and baselines reconnect backlog', () => {
    const { rerender } = render(<MatriarchCombatScene locationId="loc:region_1.seed_vault_heart" actorId={hero} combat={combat} events={[]} />);
    const unrelated = row(1, { type: 'combatEnded', outcome: 'victory', groupId: 'group:other' });
    rerender(<MatriarchCombatScene locationId="loc:region_1.seed_vault_heart" actorId={hero} combat={combat} events={[unrelated]} />);
    expect(screen.queryByTestId('matriarch-scene')?.querySelector('.matriarch-scene__sprite--boss')?.className).not.toContain('--defeat');
    const replay = row(2, { type: 'combat', event: { type: 'DamageDealt', sourceId: hero, targetId: boss, amount: 4 } });
    rerender(<MatriarchCombatScene locationId="loc:region_1.seed_vault_heart" actorId={hero} combat={combat} events={[unrelated, replay]} live={false} />);
    rerender(<MatriarchCombatScene locationId="loc:region_1.seed_vault_heart" actorId={hero} combat={combat} events={[unrelated, replay]} live />);
    expect(screen.getByTestId('matriarch-scene').querySelector('.matriarch-scene__sprite--max')?.className).toContain('--idle');
  });

});
