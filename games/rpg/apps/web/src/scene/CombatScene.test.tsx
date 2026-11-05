import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveJson } from '@rpg/protocol';

import { CombatScene, MATRIARCH_LOCATION } from './CombatScene.tsx';
import { buildSpriteIndex } from './regionArt.ts';

const hero = 'actor:max';
const SPRITES = buildSpriteIndex([{ baseUrl: '/a/', sprites: [
  { id: 'hero_max', image: 'hero_max.png' }, { id: 'enemy:glowcap_mite', image: 'glowcap_mite.png' }, { id: 'enemy:thornback_boar', image: 'thornback_boar.png' },
  { id: 'enemy:hollow_creeper', image: 'hollow_creeper.png' }, { id: 'enemy:hollow_matriarch', image: 'hollow_matriarch.png' }] }]);
const actor = (id: string, slug: string | null, alive = true) => ({ id, side: 'enemy' as const, alive, hp: alive ? 10 : 0, ...(slug ? { labelKey: `enemy.${slug}.name` } : {}) });
const me = { id: hero, labelKey: 'hero.max.name', side: 'hero' as const, alive: true, hp: 40 };
const fight = (...enemies: ReturnType<typeof actor>[]) => ({ groupId: 'group:a', actors: [me, ...enemies] });
const row = (seq: number, event: Record<string, unknown>) => ({ epoch: 1, seq, source: 'game' as const, event: event as unknown as LiveJson });
const hit = (seq: number, source: string, target: string) => row(seq, { type: 'combat', event: { type: 'DamageDealt', sourceId: source, targetId: target, amount: 4 } });
const slotOf = (id: string) => screen.getByTestId('combat-scene').querySelector(`[data-actor="${id}"]`);
const scene = (props: Partial<Parameters<typeof CombatScene>[0]> = {}) =>
  <CombatScene locationId="loc:region_1.irrigation_terraces" actorId={hero} sprites={SPRITES} {...props} />;

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('CombatScene sprites', () => {
  it('draws the hero and every enemy of the group from the manifest, and nothing outside a fight', () => {
    const { rerender } = render(scene());
    expect(screen.queryByTestId('combat-scene')).toBeNull();
    rerender(scene({ combat: fight(actor('g#0', 'glowcap_mite'), actor('g#1', 'thornback_boar')) }));
    const images = [...screen.getByTestId('combat-scene').querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(images).toEqual(['/a/hero_max.png', '/a/glowcap_mite.png', '/a/thornback_boar.png']);
    rerender(scene({ combat: null }));
    expect(screen.queryByTestId('combat-scene')).toBeNull();
  });

  it('lays 1 to 4 enemies out in distinct, deterministic slots', () => {
    const names = ['glowcap_mite', 'thornback_boar', 'hollow_creeper', 'hollow_matriarch'];
    for (const count of [1, 2, 3, 4]) {
      const enemies = names.slice(0, count).map((slug, index) => actor(`g#${index}`, slug));
      const { unmount } = render(scene({ combat: fight(...enemies) }));
      const slots = [...screen.getByTestId('combat-scene').querySelectorAll<HTMLElement>('.combat-scene__slot--enemy')];
      expect(slots).toHaveLength(count);
      expect(new Set(slots.map((slot) => `${slot.style.getPropertyValue('--x')}:${slot.style.getPropertyValue('--bottom')}`)).size).toBe(count);
      unmount();
    }
  });

  it('draws a labelled silhouette for an enemy with no sprite, and for an image that fails to load', () => {
    render(scene({ combat: fight(actor('g#0', 'glass_wisp'), actor('g#1', 'glowcap_mite')) }));
    const wisp = slotOf('g#0');
    expect(wisp?.getAttribute('data-kind')).toBe('silhouette');
    expect(wisp?.textContent).toBe('Glass Wisp');
    expect(wisp?.querySelector('img')).toBeNull();
    const mite = slotOf('g#1');
    expect(mite?.getAttribute('data-kind')).toBe('sprite');
    act(() => { mite?.querySelector('img')?.dispatchEvent(new Event('error')); });
    expect(slotOf('g#1')?.getAttribute('data-kind')).toBe('silhouette');
    expect(slotOf(hero)?.getAttribute('data-kind')).toBe('sprite');
  });

  it('is decorative: hidden from assistive technology and never intercepts a tap', () => {
    render(scene({ combat: fight(actor('g#0', 'glowcap_mite')) }));
    expect(screen.getByTestId('combat-scene').getAttribute('aria-hidden')).toBe('true');
    const css = readFileSync('games/rpg/apps/web/src/scene/combat-scene.css', 'utf8');
    expect(css).toMatch(/\.combat-scene \{[^}]*pointer-events: none/);
  });

  it('turns every tween into a static pose under reduced motion', () => {
    const css = readFileSync('games/rpg/apps/web/src/scene/combat-scene.css', 'utf8');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('animation: none');
    expect(reduced).toMatch(/--defeat \{[^}]*opacity: \.35/);
  });
});

describe('CombatScene motion', () => {
  it('does not replay existing events and animates the attacker and the target of a new event once', () => {
    const combat = fight(actor('g#0', 'glowcap_mite'), actor('g#1', 'thornback_boar'));
    const initial = hit(1, hero, 'g#0');
    const { rerender } = render(scene({ combat, events: [initial] }));
    expect(slotOf(hero)?.querySelector('img')?.className).toContain('--idle');
    rerender(scene({ combat, events: [initial, hit(2, 'g#1', hero)] }));
    expect(slotOf('g#1')?.querySelector('img')?.className).toContain('--attack');
    expect(slotOf(hero)?.querySelector('img')?.className).toContain('--hit');
    expect(slotOf('g#0')?.querySelector('img')?.className).toContain('--idle');
  });

  it('uses server defeat state, per enemy, for a settled pose', () => {
    render(scene({ combat: fight(actor('g#0', 'glowcap_mite', false), actor('g#1', 'thornback_boar')) }));
    expect(slotOf('g#0')?.getAttribute('data-pose')).toBe('defeat');
    expect(slotOf('g#1')?.getAttribute('data-pose')).toBe('idle');
  });

  it('shows the victory pose briefly after a common fight, then leaves the scene to the backdrop', () => {
    vi.useFakeTimers();
    const combat = fight(actor('g#0', 'glowcap_mite'));
    const { rerender } = render(scene({ combat, events: [], lingerMs: 1000 }));
    rerender(scene({ combat: null, events: [row(1, { type: 'combatEnded', outcome: 'victory', groupId: 'group:a' })], lingerMs: 1000 }));
    expect(slotOf('g#0')?.getAttribute('data-pose')).toBe('defeat');
    act(() => { vi.advanceTimersByTime(1100); });
    expect(screen.queryByTestId('combat-scene')).toBeNull();
  });

  it('keeps the defeated Matriarch on screen after the win (#166 pilot), through the same path', () => {
    vi.useFakeTimers();
    const combat = fight(actor('g#0', 'hollow_matriarch'));
    const { rerender } = render(scene({ locationId: MATRIARCH_LOCATION, combat, events: [], lingerMs: 1000 }));
    expect(screen.getByTestId('combat-scene').querySelectorAll('img')).toHaveLength(2);
    rerender(scene({ locationId: MATRIARCH_LOCATION, combat: null, events: [row(1, { type: 'combatEnded', outcome: 'victory', groupId: 'group:a' })], lingerMs: 1000 }));
    act(() => { vi.advanceTimersByTime(5000); });
    expect(slotOf('g#0')?.getAttribute('data-pose')).toBe('defeat');
  });

  it('ignores a victory from an unrelated group and baselines a reconnect backlog', () => {
    const combat = fight(actor('g#0', 'glowcap_mite'));
    const { rerender } = render(scene({ combat, events: [] }));
    const unrelated = row(1, { type: 'combatEnded', outcome: 'victory', groupId: 'group:other' });
    rerender(scene({ combat, events: [unrelated] }));
    expect(slotOf('g#0')?.getAttribute('data-pose')).toBe('idle');
    const replay = hit(2, hero, 'g#0');
    rerender(scene({ combat, events: [unrelated, replay], live: false }));
    rerender(scene({ combat, events: [unrelated, replay], live: true }));
    expect(slotOf(hero)?.querySelector('img')?.className).toContain('--idle');
    expect(slotOf('g#0')?.querySelector('img')?.className).toContain('--idle');
  });

  it('resets every pose when a new group starts', () => {
    const first = fight(actor('g#0', 'glowcap_mite'));
    const { rerender } = render(scene({ combat: first, events: [] }));
    rerender(scene({ combat: first, events: [hit(1, hero, 'g#0')] }));
    expect(slotOf(hero)?.querySelector('img')?.className).toContain('--attack');
    rerender(scene({ combat: { ...fight(actor('h#0', 'thornback_boar')), groupId: 'group:b' }, events: [hit(1, hero, 'g#0')] }));
    expect(slotOf(hero)?.querySelector('img')?.className).toContain('--idle');
    expect(slotOf('h#0')?.querySelector('img')?.className).toContain('--idle');
  });
});
