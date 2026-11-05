import { useEffect, useRef, useState } from 'react';
import type { LiveJson } from '@rpg/protocol';
import './matriarch-combat-scene.css';

type Actor = { readonly id: string; readonly labelKey?: string; readonly side: 'hero' | 'enemy'; readonly alive: boolean; readonly hp: number };
type EventRow = { readonly epoch: number; readonly seq: number; readonly source: 'game' | 'host'; readonly event: LiveJson };
type Props = { readonly locationId: string | undefined; readonly actorId: string; readonly combat?: { readonly groupId: string | null; readonly actors: readonly Actor[] } | null; readonly events?: readonly EventRow[]; readonly live?: boolean };
type Motion = 'idle' | 'attack' | 'hit' | 'defeat';
type Target = 'max' | 'matriarch';
type MotionState = { readonly pose: Motion; readonly seq: number };
const ROOT = `${import.meta.env.BASE_URL}assets/region-1/`;
export const MATRIARCH_LOCATION = 'loc:region_1.seed_vault_heart';
function object(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }

/** Decorative sprite overlay for the Seed Vault Heart. The SceneViewport supplies the backdrop. */
export function MatriarchCombatScene({ locationId, actorId, combat = null, events = [], live = true }: Props) {
  const cursor = useRef<{ epoch: number; seq: number } | null>(null);
  const group = useRef<string | null | undefined>(undefined);
  const verifiedGroup = useRef<string | null>(null);
  const wasLive = useRef(live);
  const [motions, setMotions] = useState<Record<Target, MotionState>>({ max: { pose: 'idle', seq: 0 }, matriarch: { pose: 'idle', seq: 0 } });
  const [victorySettled, setVictorySettled] = useState(false);
  const [assetFailed, setAssetFailed] = useState(false);
  const boss = combat?.actors.find((actor) => actor.side === 'enemy' && actor.labelKey === 'enemy.hollow_matriarch.name');
  const max = combat?.actors.find((actor) => actor.side === 'hero' && actor.id === actorId);

  useEffect(() => {
    if (!live) { wasLive.current = false; return; }
    if (!wasLive.current) {
      wasLive.current = true;
      const latest = events.at(-1);
      cursor.current = latest ? { epoch: latest.epoch, seq: latest.seq } : cursor.current;
      return;
    }
    if (group.current === undefined) {
      group.current = combat?.groupId ?? null;
      verifiedGroup.current = combat?.actors.some((actor) => actor.side === 'enemy' && actor.labelKey === 'enemy.hollow_matriarch.name')
        && combat.actors.some((actor) => actor.side === 'hero' && actor.id === actorId) ? combat.groupId : null;
      const latest = events.at(-1);
      cursor.current = latest ? { epoch: latest.epoch, seq: latest.seq } : null;
      return;
    }
    if (combat?.groupId && group.current !== combat.groupId) {
      group.current = combat?.groupId;
      verifiedGroup.current = combat.actors.some((actor) => actor.side === 'enemy' && actor.labelKey === 'enemy.hollow_matriarch.name')
        && combat.actors.some((actor) => actor.side === 'hero' && actor.id === actorId) ? combat.groupId : null;
      const latest = events.at(-1);
      cursor.current = latest ? { epoch: latest.epoch, seq: latest.seq } : null;
      setVictorySettled(false);
      setMotions({ max: { pose: 'idle', seq: 0 }, matriarch: { pose: 'idle', seq: 0 } });
      return;
    }
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
      const inner = envelope?.type === 'combat' ? object(envelope.event) : envelope;
      if (!inner) continue;
      if (inner.type === 'combatEnded' && inner.outcome === 'victory' && inner.groupId === verifiedGroup.current) {
        setVictorySettled(true);
        setMotions((previous) => ({ ...previous, matriarch: { pose: 'defeat', seq: row.seq } }));
        continue;
      }
      const sourceId = typeof inner.sourceId === 'string' ? inner.sourceId : '';
      const targetId = typeof inner.targetId === 'string' ? inner.targetId : '';
      const updates: Partial<Record<Target, Motion>> = {};
      if (inner.type === 'DamageDealt') {
        if (sourceId === actorId) updates.max = 'attack';
        else if (sourceId === boss?.id) updates.matriarch = 'attack';
        if (targetId === actorId) updates.max = 'hit';
        else if (targetId === boss?.id) updates.matriarch = 'hit';
      } else if (inner.type === 'ActorDied') {
        if (inner.actorId === actorId) updates.max = 'defeat';
        else if (inner.actorId === boss?.id) updates.matriarch = 'defeat';
      }
      if (Object.keys(updates).length) setMotions((previous) => {
        const next = { ...previous };
        for (const [target, pose] of Object.entries(updates) as [Target, Motion][]) next[target] = { pose, seq: row.seq };
        return next;
      });
    }
  }, [events, combat?.groupId, combat?.actors, actorId, boss?.id, live]);

  useEffect(() => {
    if (boss && !boss.alive) setMotions((previous) => ({ ...previous, matriarch: { pose: 'defeat', seq: previous.matriarch.seq + 1 } }));
  }, [boss?.alive]);
  if (locationId !== MATRIARCH_LOCATION || assetFailed || ((!combat || !boss || !max) && !victorySettled)) return null;
  return <div className="matriarch-scene" aria-hidden="true" data-testid="matriarch-scene">
    <img key={`max-${motions.max.seq}`} className={`matriarch-scene__sprite matriarch-scene__sprite--max matriarch-scene__sprite--${motions.max.pose}`} src={`${ROOT}sprites/hero_max.png`} onError={() => setAssetFailed(true)} alt="" />
    <img key={`boss-${motions.matriarch.seq}`} className={`matriarch-scene__sprite matriarch-scene__sprite--boss matriarch-scene__sprite--${motions.matriarch.pose}`} src={`${ROOT}sprites/hollow_matriarch.png`} onError={() => setAssetFailed(true)} alt="" />
  </div>;
}
