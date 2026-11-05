import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveServerFrame } from '@rpg/protocol';
import type { ApiClient } from '../api/http.ts';
import type { CharacterDto } from '../api/types.ts';
import { getInventory } from '../inventory/api.ts';
import type { LiveConnection } from '../app/services.ts';

const SNAPSHOT_LIMIT = 300;
const EVENT_LIMIT = 1800;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MATRIARCH_LOCATION = 'loc:region_1.seed_vault_heart';
export interface PlaytestCapture {
  readonly status: 'idle' | 'preparing' | 'recording' | 'complete' | 'incomplete';
  readonly reason?: string;
  readonly count: number;
  readonly exportJson?: string;
}
type CaptureData = { format: 1; startedAt: string; actorId: string; bytes: number; lastSeq?: number; actorBuild: unknown; initial: unknown; snapshots: unknown[]; events: unknown[]; result?: unknown; instanceId?: string; groupId?: string; enemyIds: Set<string>;
  evidence: { truncated: boolean; disconnect: boolean; gaps: string[]; markerSeen: boolean; buildChanged: boolean; combatInputsAvailable: boolean;
    bossStartSnapshotSeen: boolean; bossLocation: string; bossLabelKey: string; terminalResultSeen?: boolean } };

/** Opt-in, in-memory staging recorder. It only listens to the existing validated socket and never sends commands. */
export function usePlaytestCapture(enabled: boolean, character: CharacterDto | null, api: ApiClient, live: LiveConnection) {
  const data = useRef<CaptureData | null>(null);
  const preparing = useRef<object | null>(null);
  const [state, setState] = useState<PlaytestCapture>({ status: 'idle', count: 0 });
  const actorId = character?.actorId;

  useEffect(() => {
    setState({ status: 'idle', count: 0 });
    return () => { preparing.current = null; data.current = null; };
  }, [enabled, actorId, api, live]);

  const start = useCallback(async () => {
    if (!enabled || !character || !live.subscribeFrames || data.current || preparing.current) return;
    const request = {};
    preparing.current = request;
    setState({ status: 'preparing', count: 0 });
    try {
      const [fresh, inventory] = await Promise.all([api.character(character.actorId), getInventory(api, character.actorId)]);
      if (preparing.current !== request) return;
      if (fresh.actorId !== character.actorId || inventory.actorId !== character.actorId) throw new Error('actor_mismatch');
      if (fresh.version !== inventory.actorVersion) throw new Error('build_changed_during_capture_setup');
      data.current = { format: 1, startedAt: new Date().toISOString(), actorId: character.actorId, bytes: 0, actorBuild: {
        level: fresh.level, xp: fresh.xp, attributes: fresh.attributes, unspentPoints: fresh.unspentPoints,
        skillLoadout: fresh.skillLoadout, automationRules: fresh.automationRules,
        equipment: inventory.statSummary?.items.map(({ definition, nameKey, slot }) => ({ definition, nameKey, slot })) ?? null,
        statSummary: inventory.statSummary ? { level: inventory.statSummary.level, rows: inventory.statSummary.rows.map(({ key, base, equipment, total }) => ({ key, base, equipment, total })) } : null,
        contentHash: inventory.catalog.contentHash,
      }, initial: { supplies: inventory.holdings.filter((item) => item.container === 'inventory' && item.asset.kind === 'stack').map((item) => ({ item: item.asset.kind === 'stack' ? item.asset.item : '', qty: item.qty })) },
        snapshots: [], events: [], enemyIds: new Set(), evidence: { truncated: false, disconnect: false, gaps: [], markerSeen: false, buildChanged: false,
          combatInputsAvailable: false, bossStartSnapshotSeen: false, bossLocation: MATRIARCH_LOCATION, bossLabelKey: 'enemy.hollow_matriarch.name' } };
      setState({ status: 'recording', count: 0 });
    } catch (error) {
      if (preparing.current === request) setState({ status: 'incomplete', count: 0, reason: error instanceof Error ? error.message : 'capture_setup_failed' });
    } finally {
      if (preparing.current === request) preparing.current = null;
    }
  }, [enabled, character, api, live]);

  const finish = useCallback((reason?: string) => {
    const current = data.current;
    if (!current) return;
    data.current = null;
    const status = reason ? 'incomplete' : 'complete';
    const exportJson = JSON.stringify({ format: current.format, startedAt: current.startedAt, actorBuild: current.actorBuild, initial: current.initial,
      snapshots: current.snapshots, events: current.events, ...(current.result ? { result: current.result } : {}),
      evidence: { ...current.evidence, bossGroupSeen: Boolean(current.groupId), terminalResultSeen: Boolean(current.result),
        ...(reason ? { endReason: reason } : {}) } }, null, 2);
    setState({ status, count: current.snapshots.length + current.events.length, ...(reason ? { reason } : {}), exportJson });
  }, []);

  useEffect(() => {
    if (!enabled || !actorId || state.status !== 'recording' || !live.subscribeFrames) return;
    if (data.current?.actorId !== actorId) { finish('actor_changed'); return; }
    const unsubscribe = live.subscribeFrames((frame: LiveServerFrame) => {
      const current = data.current;
      if (!current) return;
      if (frame.type === 'live.attached') { if (!current.instanceId) current.instanceId = frame.instanceId; return; }
      if ((frame.type === 'live.snapshot' || frame.type === 'live.event') && current.instanceId === frame.instanceId) {
        if (current.lastSeq !== undefined && frame.seq > current.lastSeq + 1) current.evidence.gaps.push(`sequence_${current.lastSeq + 1}_to_${frame.seq - 1}`);
        current.lastSeq = frame.seq;
      }
      if (frame.type === 'live.snapshot') {
        if (current.instanceId && current.instanceId !== frame.instanceId) return;
        const view = frame.view as Record<string, unknown>;
        const location = view['location'];
        if (location !== MATRIARCH_LOCATION) return;
        const heroes = Array.isArray(view['heroes']) ? view['heroes'] as Record<string, unknown>[] : [];
        const ownHero = heroes.find((hero) => hero['actorId'] === actorId);
        const groups = Array.isArray(view['groups']) ? view['groups'] as Record<string, unknown>[] : [];
        const markedGroup = groups.find((group) => group['boss'] === true || (Array.isArray(group['enemies']) && group['enemies'].includes('enemy.hollow_matriarch')));
        const marked = Boolean(markedGroup);
        if (!marked || view['phase'] !== 'combat' || !ownHero) return;
        if (!current.instanceId) current.instanceId = frame.instanceId;
        const bossGroupId = typeof markedGroup?.['id'] === 'string' ? markedGroup['id'] : undefined;
        if (current.groupId && current.groupId !== bossGroupId) return;
        if (bossGroupId) current.groupId = bossGroupId;
        current.evidence.markerSeen ||= marked;
        if (ownHero && (ownHero['level'] !== (current.actorBuild as Record<string, unknown>)['level'] ||
          (Array.isArray(ownHero['skills']) && JSON.stringify((ownHero['skills'] as Record<string, unknown>[]).map((skill) => skill['id']).sort()) !==
            JSON.stringify([...(current.actorBuild as { skillLoadout: string[] }).skillLoadout].sort())))) current.evidence.buildChanged = true;
        const combatView = view['combat'] as Record<string, unknown> | undefined;
        const combatActors = Array.isArray(combatView?.['actors']) ? combatView['actors'] as Record<string, unknown>[] : [];
        for (const actor of combatActors) if (actor['side'] === 'enemy' && typeof actor['id'] === 'string') current.enemyIds.add(actor['id']);
        const publicView = { phase: view['phase'], area: view['area'], location, tick: combatView?.['tick'],
          ownHero: ownHero ? { level: ownHero['level'], hp: ownHero['hp'], maxHp: ownHero['maxHp'], present: ownHero['present'], consumables: ownHero['consumables'],
            skills: Array.isArray(ownHero['skills']) ? (ownHero['skills'] as Record<string, unknown>[]).map(({ id, cooldownTicks, cooldownRemainingTicks, windupTicks }) => ({ id, cooldownTicks, cooldownRemainingTicks, windupTicks })) : [] } : null,
          combat: publicCombat(view['combat'], actorId), boss: { groupId: bossGroupId, defeated: Boolean(markedGroup?.['defeated']) } };
        if (!current.evidence.bossStartSnapshotSeen && ownHero) {
          current.evidence.bossStartSnapshotSeen = true;
          current.initial = { ...(current.initial as Record<string, unknown>), hpAtBossStart: ownHero['hp'], suppliesAtBossStart: ownHero['consumables'], tickAtFirstSnapshot: combatView?.['tick'] };
        }
        push(current.snapshots, { epoch: frame.epoch, seq: frame.seq, view: publicView }, current);
      } else if (frame.type === 'live.event') {
        if (current.instanceId && current.instanceId !== frame.instanceId) return;
        const event = frame.event as Record<string, unknown>;
        if (!['combatStarted', 'combat', 'combatEnded', 'combatRewards', 'bossRoomWarning'].includes(String(event['type']))) return;
        const nestedCombat = event['type'] === 'combat' && event['event'] && typeof event['event'] === 'object' ? event['event'] as Record<string, unknown> : undefined;
        const groupId = typeof event['groupId'] === 'string' ? event['groupId'] : typeof nestedCombat?.['groupId'] === 'string' ? nestedCombat['groupId'] : undefined;
        const bossStart = event['type'] === 'combatStarted' && event['boss'] === true && groupId?.startsWith(`${MATRIARCH_LOCATION}/`);
        if (bossStart && groupId && (!current.groupId || current.groupId === groupId)) {
          current.instanceId ??= frame.instanceId;
          current.groupId = groupId;
          current.evidence.markerSeen = true;
        }
        if (!current.groupId || (event['type'] !== 'combat' && groupId !== current.groupId)) return;
        const body = sanitizeEvent(event, actorId, current.enemyIds);
        push(current.events, { epoch: frame.epoch, seq: frame.seq, source: frame.source, event: body }, current);
        if (event['type'] === 'combatEnded') {
          current.result = body;
          const tick = (current.initial as Record<string, unknown>)['tickAtFirstSnapshot'];
          finish(current.evidence.buildChanged || !current.evidence.bossStartSnapshotSeen || tick !== 0 || current.evidence.truncated || current.evidence.disconnect || current.evidence.gaps.length
            ? 'incomplete_evidence' : undefined);
        }
      } else if (frame.type === 'live.closed') { if (!current.instanceId || current.instanceId === frame.instanceId) finish('live_closed_without_combat_result'); }
      else if (frame.type === 'live.evicted') { if (!current.instanceId || current.instanceId === frame.instanceId) { current.evidence.disconnect = true; finish(`live_evicted:${frame.reason}`); } }
    });
    return unsubscribe;
  }, [enabled, actorId, state.status, live, finish]);

  useEffect(() => {
    if (!enabled || state.status !== 'recording') return;
    const unsubscribe = live.subscribe((connection) => {
      if (connection.status === 'reconnecting' || connection.status === 'failed' || connection.status === 'stopped') {
        const current = data.current;
        if (current) { current.evidence.disconnect = true; current.evidence.gaps.push(connection.status); }
        finish(`live_${connection.status}`);
      }
    });
    return unsubscribe;
  }, [enabled, state.status, live, finish]);

  return { state, start, finish: () => finish('manually_stopped'), clear: () => setState({ status: 'idle', count: 0 }) };
}

function push(target: unknown[], value: unknown, capture: CaptureData) {
  const max = target === capture.snapshots ? SNAPSHOT_LIMIT : EVENT_LIMIT;
  const bytes = JSON.stringify(value).length;
  if (target.length >= max || capture.bytes + bytes > MAX_CAPTURE_BYTES) { capture.evidence.truncated = true; return; }
  capture.bytes += bytes;
  target.push(value);
}

function publicCombat(value: unknown, actorId: string): unknown {
  if (!value || typeof value !== 'object') return value ?? null;
  const combat = value as Record<string, unknown>;
  const actors = Array.isArray(combat['actors']) ? combat['actors'] as Record<string, unknown>[] : [];
  return { tick: combat['tick'], groupId: combat['groupId'], actors: actors.filter((actor) => actor['side'] === 'enemy' || actor['id'] === actorId).map((actor) => ({
    side: actor['side'], hp: actor['hp'], maxHp: actor['maxHp'], alive: actor['alive'], labelKey: actor['labelKey'], auto: actor['id'] === actorId ? actor['auto'] : undefined,
    cooldowns: Array.isArray(actor['cooldowns']) ? (actor['cooldowns'] as Record<string, unknown>[]).map(({ skill, remainingTicks }) => ({ skill, remainingTicks })) : undefined,
    effects: Array.isArray(actor['effects']) ? (actor['effects'] as Record<string, unknown>[]).map(({ type, amount, school, stat, remaining, unit }) => ({ type, amount, school, stat, remaining, unit })) : undefined,
    windup: actor['windup'] && typeof actor['windup'] === 'object' ? (() => { const w = actor['windup'] as Record<string, unknown>;
      return { skill: w['skill'], startedTick: w['startedTick'], resolveAtTick: w['resolveAtTick'] }; })() : undefined,
  })) };
}

function sanitizeEvent(event: Record<string, unknown>, actorId: string, enemyIds: ReadonlySet<string>): Record<string, unknown> {
  const type = event['type'];
  if (type === 'combatStarted') return { type, groupId: event['groupId'], boss: true };
  if (type === 'combatEnded') return { type, groupId: event['groupId'], outcome: event['outcome'] };
  if (type === 'combatRewards') {
    const own = Array.isArray(event['rewards']) ? (event['rewards'] as Record<string, unknown>[]).find((row) => row['actorId'] === actorId) : undefined;
    return { type, groupId: event['groupId'], ...(own ? { ownReward: { xp: own['xp'], gold: own['gold'], drops: own['drops'] } } : {}) };
  }
  if (type === 'combat' && event['event'] && typeof event['event'] === 'object') {
    const nested = event['event'] as Record<string, unknown>;
    if (typeof nested['actorId'] === 'string' && nested['actorId'] !== actorId && !enemyIds.has(nested['actorId'])) return { type: 'combat', omitted: 'other_actor_event' };
    const fields = ['type', 'tick', 'amount', 'hpAfter', 'school', 'skill', 'origin', 'kind', 'remaining', 'phase', 'source', 'resolveAtTick', 'item', 'auto'];
    const result = Object.fromEntries(fields.filter((key) => key in nested).map((key) => [key, nested[key]]));
    if (nested['action'] && typeof nested['action'] === 'object') {
      const action = nested['action'] as Record<string, unknown>;
      result['action'] = Object.fromEntries(['kind', 'skill', 'item'].filter((key) => key in action).map((key) => [key, action[key]]));
    }
    if (typeof nested['actorId'] === 'string') result['actor'] = nested['actorId'] === actorId ? 'player' : 'enemy';
    for (const key of ['sourceId', 'targetId']) {
      const value = nested[key];
      if (value === actorId) result[key === 'sourceId' ? 'source' : 'target'] = 'player';
      else if (typeof value === 'string' && enemyIds.has(value)) result[key === 'sourceId' ? 'source' : 'target'] = 'enemy';
    }
    return { type: 'combat', event: result };
  }
  return { type, groupId: event['groupId'] };
}
