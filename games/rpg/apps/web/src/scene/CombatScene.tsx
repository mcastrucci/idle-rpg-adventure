import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { LiveJson } from '@rpg/protocol';

import { displayLabel } from '../content/labels.ts';
import { t, useLocale } from '../i18n/index.ts';
import { enemySprite, heroSprite } from './combatSprites.ts';
import { HERO_SLOT, enemySlots } from './combatLayout.ts';
import type { SpriteSlot } from './combatLayout.ts';
import { SPRITE_INDEX } from './regionArt.ts';
import type { SpriteIndex } from './regionArt.ts';
import './combat-scene.css';

type Actor = { readonly id: string; readonly labelKey?: string; readonly side: 'hero' | 'enemy'; readonly alive: boolean; readonly hp: number };
type CombatLike = { readonly groupId: string | null; readonly actors: readonly Actor[] };
type EventRow = { readonly epoch: number; readonly seq: number; readonly source: 'game' | 'host'; readonly event: LiveJson };
type Motion = 'idle' | 'attack' | 'hit' | 'defeat';
type MotionState = { readonly pose: Motion; readonly seq: number };
type Props = {
  readonly locationId?: string | undefined;
  readonly actorId: string;
  readonly combat?: CombatLike | null;
  readonly events?: readonly EventRow[];
  readonly live?: boolean;
  /** Test seam: the manifest sprites the scene may use. */
  readonly sprites?: SpriteIndex;
  /** How long a won fight stays on screen in its victory pose. */
  readonly lingerMs?: number;
};

/** The Seed Vault Heart keeps its defeated boss on screen after the win (#166); every other victory pose is brief. */
export const MATRIARCH_LOCATION = 'loc:region_1.seed_vault_heart';
export const VICTORY_LINGER_MS = 1400;
const IDLE: MotionState = { pose: 'idle', seq: 0 };
function object(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }

/** A combat this presenter may draw: my hero and at least one enemy. */
function drawable(combat: CombatLike | null | undefined, actorId: string): combat is CombatLike {
  return combat != null && combat.actors.some((actor) => actor.side === 'hero' && actor.id === actorId) && combat.actors.some((actor) => actor.side === 'enemy');
}
const drawableGroup = (combat: CombatLike | null | undefined, actorId: string): string | null => drawable(combat, actorId) ? combat.groupId : null;

/**
 * Decorative combat layer over the scene backdrop: the controlled hero on the left and every enemy of the current group
 * on the right, from the art manifest (a labelled silhouette for an enemy that has no sprite). Motion is driven only by
 * server combat events that arrive while it is mounted and attached (never replayed from a backlog), as CSS tweens that
 * `prefers-reduced-motion` turns into static poses. Sprites are plain `<img>` elements, so a texture is fetched and
 * decoded only while its combatant is on screen and released when the fight is over.
 */
export function CombatScene({ locationId, actorId, combat = null, events = [], live = true, sprites = SPRITE_INDEX, lingerMs = VICTORY_LINGER_MS }: Props) {
  useLocale();
  const cursor = useRef<{ epoch: number; seq: number } | null>(null);
  const group = useRef<string | null | undefined>(undefined);
  const verifiedGroup = useRef<string | null>(null);
  const wasLive = useRef(live);
  const lastActors = useRef<readonly Actor[]>([]);
  const [motions, setMotions] = useState<Readonly<Record<string, MotionState>>>({});
  const [victorySettled, setVictorySettled] = useState(false);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  if (drawable(combat, actorId)) lastActors.current = combat.actors;

  useEffect(() => {
    if (!live) { wasLive.current = false; return; }
    const latest = events.at(-1);
    if (!wasLive.current) {
      wasLive.current = true;
      if (latest) cursor.current = { epoch: latest.epoch, seq: latest.seq };
      return;
    }
    if (group.current === undefined) {
      group.current = combat?.groupId ?? null;
      verifiedGroup.current = drawableGroup(combat, actorId);
      cursor.current = latest ? { epoch: latest.epoch, seq: latest.seq } : null;
      return;
    }
    if (combat?.groupId && group.current !== combat.groupId) {
      group.current = combat.groupId;
      verifiedGroup.current = drawableGroup(combat, actorId);
      cursor.current = latest ? { epoch: latest.epoch, seq: latest.seq } : null;
      setVictorySettled(false);
      setMotions({});
      return;
    }
    const drawn = new Set([actorId, ...lastActors.current.filter((actor) => actor.side === 'enemy').map((actor) => actor.id)]);
    for (const row of events) {
      if (row.source !== 'game') continue;
      if (cursor.current && row.epoch < cursor.current.epoch) continue;
      if (cursor.current && row.epoch === cursor.current.epoch && row.seq <= cursor.current.seq) continue;
      // A new stream epoch represents a reconnect snapshot/backlog. Establish a baseline without replaying it.
      if (cursor.current && row.epoch !== cursor.current.epoch) {
        const latestInEpoch = events.filter((candidate) => candidate.epoch === row.epoch).reduce((max, candidate) => Math.max(max, candidate.seq), row.seq);
        cursor.current = { epoch: row.epoch, seq: latestInEpoch };
        break;
      }
      cursor.current = { epoch: row.epoch, seq: row.seq };
      const envelope = object(row.event);
      const inner = envelope?.['type'] === 'combat' ? object(envelope['event']) : envelope;
      if (!inner) continue;
      if (inner['type'] === 'combatEnded' && inner['outcome'] === 'victory' && inner['groupId'] === verifiedGroup.current) {
        setVictorySettled(true);
        continue;
      }
      const sourceId = typeof inner['sourceId'] === 'string' ? inner['sourceId'] : '';
      const targetId = typeof inner['targetId'] === 'string' ? inner['targetId'] : '';
      const updates = new Map<string, Motion>();
      if (inner['type'] === 'DamageDealt') {
        if (drawn.has(sourceId)) updates.set(sourceId, 'attack');
        if (drawn.has(targetId)) updates.set(targetId, 'hit');
      } else if (inner['type'] === 'ActorDied' && typeof inner['actorId'] === 'string' && drawn.has(inner['actorId'])) {
        updates.set(inner['actorId'], 'defeat');
      }
      if (updates.size > 0) setMotions((previous) => {
        const next = { ...previous };
        for (const [id, pose] of updates) next[id] = { pose, seq: row.seq };
        return next;
      });
    }
  }, [events, combat, actorId, live]);

  const persistVictory = locationId === MATRIARCH_LOCATION;
  useEffect(() => {
    if (!victorySettled || persistVictory) return undefined;
    const timer = setTimeout(() => setVictorySettled(false), lingerMs);
    return () => clearTimeout(timer);
  }, [victorySettled, persistVictory, lingerMs]);

  const actors = drawable(combat, actorId) ? combat.actors : victorySettled ? lastActors.current : [];
  const hero = actors.find((actor) => actor.side === 'hero' && actor.id === actorId);
  const enemies = actors.filter((actor) => actor.side === 'enemy');
  if (!hero || enemies.length === 0) return null;
  const slots = enemySlots(enemies.length);
  const draw = (actor: Actor, slot: SpriteSlot, kind: 'hero' | 'enemy') => {
    const motion = motions[actor.id] ?? IDLE;
    const pose: Motion = (kind === 'enemy' && victorySettled) || !actor.alive ? 'defeat' : motion.pose;
    const art = kind === 'hero' ? heroSprite(sprites) : enemySprite(actor.labelKey, sprites);
    const showSprite = art !== null && !failed.has(art.url);
    const label = kind === 'hero' ? t('ui.common.you') : displayLabel(actor.labelKey ?? actor.id);
    return <div key={actor.id} className={`combat-scene__slot combat-scene__slot--${kind}`} data-actor={actor.id} data-kind={showSprite ? 'sprite' : 'silhouette'} data-pose={pose}
      style={{ '--x': slot.x, '--bottom': slot.bottom, '--size': slot.size, zIndex: slot.layer } as CSSProperties}>
      {showSprite
        ? <img key={`${actor.id}-${motion.seq}`} className={`combat-scene__sprite combat-scene__sprite--${pose}`} src={art.url} alt="" decoding="async"
          onError={() => setFailed((previous) => new Set(previous).add(art.url))} />
        : <div key={`${actor.id}-${motion.seq}`} className={`combat-scene__sprite combat-scene__silhouette combat-scene__sprite--${pose}`}><span>{label}</span></div>}
    </div>;
  };
  return <div className="combat-scene" aria-hidden="true" data-testid="combat-scene">
    {draw(hero, HERO_SLOT, 'hero')}
    {enemies.slice(0, slots.length).map((enemy, index) => draw(enemy, slots[index] as SpriteSlot, 'enemy'))}
  </div>;
}
