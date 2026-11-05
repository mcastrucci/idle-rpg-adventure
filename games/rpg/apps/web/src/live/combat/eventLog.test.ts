// @vitest-environment node
import type { LiveJson } from '@rpg/protocol';
import { parseLiveServerFrame } from '@rpg/protocol';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '../../i18n/index.ts';
import type { Locale } from '../../i18n/locale.ts';
import { COMBAT_EVENT_TYPES, formatEvent, GAME_EVENT_TYPES } from './eventLog.ts';

const me = '0b6f4d1e-8f43-4f1c-9a52-1d6a2f7c9e10';
const mate = '1c7a5e2f-9a54-4a2d-8b63-2e7b3a8d0f21';
const actors = [
  { id: me, side: 'hero' as const }, { id: mate, side: 'hero' as const },
  { id: 'enemy:thornback_boar', labelKey: 'enemy.thornback_boar.name', side: 'enemy' as const },
];

/** One representative payload per live event type, shaped like what the server game and host emit. */
const COMBAT_SAMPLES: Readonly<Record<string, Record<string, LiveJson>>> = {
  CombatStarted: { heroes: [me], enemies: ['enemy:thornback_boar'] },
  ActionStarted: { actorId: me, action: { kind: 'skill', skill: 'skill:cleave' }, targetIds: ['enemy:thornback_boar'], source: 'manual' },
  TelegraphStarted: { actorId: 'enemy:thornback_boar', skill: 'skill:crushing_blow', targetIds: [me], resolveAtTick: 15 },
  ActionInterrupted: { actorId: 'enemy:thornback_boar', skill: 'skill:crushing_blow', reason: 'stunned' },
  ActionSkipped: { actorId: 'enemy:thornback_boar', reason: 'stunned' },
  DamageDealt: { sourceId: me, targetId: 'enemy:thornback_boar', amount: 7, absorbed: 0, crit: false, periodic: false, hpAfter: 40 },
  Healed: { sourceId: mate, targetId: me, amount: 5, periodic: false, hpAfter: 60 },
  EffectApplied: { effectUid: 1, effect: 'stun', sourceId: me, targetId: 'enemy:thornback_boar', origin: 'skill:shield_bash', duration: { value: 2, unit: 'ticks' } },
  EffectExpired: { effectUid: 1, effect: 'shield', targetId: me, reason: 'duration' },
  Cleansed: { sourceId: mate, targetId: me, removed: 2 },
  EffectNegated: { sourceId: 'enemy:thornback_boar', targetId: me, origin: 'skill:gore', effect: 'dot', reason: 'guarded' },
  ConsumableUsed: { actorId: me, item: 'item:minor_healing_potion', remaining: 1 },
  ActorDied: { actorId: 'enemy:thornback_boar', killerId: me },
  PhaseChanged: { actorId: 'enemy:thornback_boar', phase: 2, fromHpBp: 5000 },
  AutoToggled: { actorId: me, auto: true },
  InputRejected: { actorId: me, kind: 'useSkill', reason: 'onCooldown' },
  CombatEnded: { outcome: 'victory' },
};
const GAME_SAMPLES: Readonly<Record<string, Record<string, LiveJson>>> = {
  traveled: { exitId: 'exit:north', from: 'location:a', to: 'location:b' },
  discovered: { locationId: 'location:b', actorIds: [me] },
  combatStarted: { groupId: 'group:1', boss: true },
  combatEnded: { outcome: 'defeat', groupId: 'group:1' },
  combatRewards: { groupId: 'group:1', rewards: [{ actorId: me, xp: 12, gold: 3, drops: [] }] },
  retreated: { from: 'location:b', to: 'location:a', hpCost: 4 },
  bossRoomWarning: { exitId: 'exit:north' },
  hotspotInteracted: { hotspotId: 'hotspot:statue', hotspotType: 'lore', textKey: 'live.text' },
  gathered: { nodeId: 'node:1', resource: 'resource:herb', lootTable: 'table:herb', drops: [], gold: 0 },
  consumableUsed: { actorId: me, itemId: 'item:minor_healing_potion', hpBefore: 20, hp: 40 },
  returned: { locationId: 'location:sanctuary' },
  heroLeft: { actorId: mate },
  heroDied: { actorId: me, causes: [], xpLost: 10, levelBefore: 2, levelAfter: 2 },
  corpseRecovered: { actorId: me, repeat: false },
  participant: { actorId: mate, status: 'connected' },
};

function sample(type: string): LiveJson {
  if (type === 'combat') return { type, event: { type: 'CombatStarted', heroes: [me], enemies: [] } };
  return { type, ...(GAME_SAMPLES[type] ?? {}) };
}
function combatSample(type: string): LiveJson {
  return { type: 'combat', event: { type, seq: 1, tick: 3, ...(COMBAT_SAMPLES[type] ?? {}) } };
}
function protocolSet(name: string): string[] {
  const source = readFileSync(fileURLToPath(new URL('../../../../../packages/protocol/src/live.ts', import.meta.url)), 'utf8');
  const body = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`).exec(source)?.[1] ?? '';
  return [...body.matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1] ?? '');
}

describe('live event log text', () => {
  afterEach(() => setLocale('en', { persist: false }));

  it('covers exactly the event types the protocol accepts', () => {
    expect([...GAME_EVENT_TYPES].sort()).toEqual(protocolSet('GAME_EVENT_TYPES').sort());
    expect([...COMBAT_EVENT_TYPES].sort()).toEqual(protocolSet('COMBAT_EVENT_TYPES').sort());
    expect(Object.keys(COMBAT_SAMPLES).sort()).toEqual([...COMBAT_EVENT_TYPES].sort());
    for (const type of GAME_EVENT_TYPES.filter((name) => name !== 'bossRoomWarning')) { // its risk payload has its own schema tests
      const frame = { type: 'live.event', instanceId: mate, epoch: 1, seq: 1, source: 'game', event: sample(type) };
      expect(() => parseLiveServerFrame(frame), type).not.toThrow();
    }
  });

  const rows: [string, LiveJson][] = [
    ...GAME_EVENT_TYPES.map((type): [string, LiveJson] => [type, sample(type)]),
    ...COMBAT_EVENT_TYPES.map((type): [string, LiveJson] => [`combat:${type}`, combatSample(type)]),
  ];
  for (const locale of ['en', 'es'] as const satisfies readonly Locale[]) {
    it.each(rows)(`${locale}: %s reads as translated text, never the raw type`, (name, event) => {
      setLocale(locale, { persist: false });
      const text = formatEvent(event, me, actors);
      const type = name.replace('combat:', '');
      expect(text.trim()).not.toBe('');
      expect(text).not.toBe(type);
      expect(text).not.toMatch(/^[A-Za-z]+$/);
      expect(text).not.toMatch(/\{\w+\}|\bundefined\b|\bNaN\b|\[object/);
    });
  }

  it('gives different Spanish and English text for every event', () => {
    for (const [name, event] of rows) {
      setLocale('en', { persist: false });
      const en = formatEvent(event, me, actors);
      setLocale('es', { persist: false });
      expect(formatEvent(event, me, actors), name).not.toBe(en);
    }
  });

  it('uses a generic translated sentence for unknown or malformed events', () => {
    const unknown: LiveJson[] = [{ type: 'brandNewThing', actorId: me }, { type: 'combat', event: { type: 'FutureEvent' } },
      { type: 'participant', actorId: me, status: 'weird' }, { type: 'combat' }, { }, 'oops', 5, null, ['x']];
    for (const locale of ['en', 'es'] as const) {
      setLocale(locale, { persist: false });
      for (const event of unknown) {
        const text = formatEvent(event, me, actors);
        expect(text, JSON.stringify(event)).not.toMatch(/brandNewThing|FutureEvent|weird|brand new|future event/i);
        expect(text.trim()).not.toBe('');
      }
    }
  });

  it('interpolates the useful parameters', () => {
    expect(formatEvent(combatSample('Cleansed'), me, actors)).toBe('2 effects removed from You.');
    expect(formatEvent(GAME_SAMPLES['combatRewards'] ? sample('combatRewards') : null, me, actors)).toBe('Rewards: 12 XP and 3 gold.');
    expect(formatEvent(sample('heroDied'), me, actors)).toBe('You died and lost 10 XP.');
    setLocale('es', { persist: false });
    expect(formatEvent(sample('heroDied'), me, actors)).toBe('Moriste y perdiste 10 XP.');
    expect(formatEvent(combatSample('EffectApplied'), me, actors)).toContain('Aturdimiento');
  });
});
