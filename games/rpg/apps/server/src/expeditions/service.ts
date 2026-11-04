import { randomBytes, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { and, desc, eq } from 'drizzle-orm';
import { netDeltas } from '@engine/economy';
import type { LedgerDelta } from '@engine/economy';
import {
  KERNEL_VERSION, assertEscrow, checkStart, placeSegments, settleAt, timelineHash, visibleView,
} from '@engine/expedition-kernel';
import type { ActivityRegistry, PlacedTimeline, Timeline } from '@engine/expedition-kernel';
import { actors, applyLedgerDeltas, getHoldings, requireOwnedActor, scheduleJobInTransaction, transitionActivity } from '@engine/server-kit';
import type { ActorTransaction, Clock, LoadedContent } from '@engine/server-kit';
import { validateWorld } from '@engine/world';
import type { AreaId, World } from '@engine/world';
import { createRpgActivityRegistry, rpgIdleContentFromBundle } from '@rpg/rpg-sim';
import type { RpgActorSnapshot, RpgIdleConfig, RpgIdleEvent, RpgIdleReport, RpgIdleState } from '@rpg/rpg-sim';
import { createRpgPredicateRegistry } from '@rpg/rpg-schema';
import type { XpCurve } from '@rpg/rpg-schema';
import { totalXpFromLevelProgress, xpProgress } from '@rpg/rpg-stats';
import { parseExpeditionDto, parseExpeditionOptionsDto } from '@rpg/protocol';

import { rpgXpCurve } from '../content.ts';
import { characters } from '../characters/schema.ts';
import { RPG_GAME_ID } from '../characters/service.ts';
import { BASIC_ATTACK } from '../characters/validation.ts';
import type { CharacterAttributes } from '../characters/validation.ts';
import { expeditions } from './schema.ts';
import type { ExpeditionSnapshot } from './schema.ts';
import { projectExpeditionResultReport } from './report.ts';
import { findSettlementPolicy, settlementSimulator, supportedSettlementPolicies } from './policy.ts';
import type { SettlementPolicy } from './policy.ts';
import { readRpgEvalContext } from './progress.ts';

const SETTLE_JOB = 'rpg.expedition.settle';
const ESCROW_ACTIVITY = (id: string) => ({ state: 'expedition' as const, id });
type ExpeditionTimeline = Timeline<RpgIdleEvent, RpgIdleState>;

export class ExpeditionError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode: number) { super(code); this.code = code; this.statusCode = statusCode; }
}

function parseWorld(content: LoadedContent): World {
  const result = validateWorld(content.world, createRpgPredicateRegistry());
  if (!result.ok) throw new Error('RPG content world failed runtime validation');
  return result.world;
}
function simulators(content: LoadedContent): ActivityRegistry {
  return createRpgActivityRegistry(content);
}
function xpCurve(content: LoadedContent): XpCurve {
  return rpgXpCurve(content.collections);
}
/** The persisted start snapshot: participants plus the XP curve (table and tail) settlement will use (#129). */
function startSnapshot(participant: RpgActorSnapshot, curve: XpCurve): ExpeditionSnapshot {
  return { participants: [participant] as unknown as readonly Record<string, unknown>[], xpCurve: curve.xpToNext, xpTailGrowthBp: curve.tailGrowthBp };
}
function timelineOf(row: typeof expeditions.$inferSelect): ExpeditionTimeline {
  const json = inflateSync(Buffer.from(row.timelineCompressed, 'base64')).toString('utf8');
  const timeline = JSON.parse(json) as ExpeditionTimeline;
  if (String(timelineHash(timeline as Timeline<unknown, unknown>)) !== row.timelineHash) throw new Error('persisted expedition timeline hash mismatch');
  return timeline;
}
function placedOf(row: typeof expeditions.$inferSelect, timeline: ExpeditionTimeline): PlacedTimeline<RpgIdleEvent, RpgIdleState> {
  return placeSegments(timeline, row.startsAtMs, row.plannedEndsAtMs - row.startsAtMs, row.budget);
}
export function snapshotRpgActor(character: typeof characters.$inferSelect,
  holdings: Awaited<ReturnType<typeof getHoldings>>, content: LoadedContent): RpgActorSnapshot {
  const items = rpgIdleContentFromBundle(content).combat.items;
  const equipment = holdings.filter(h => h.container === 'equipped' && h.asset.kind === 'unique').map(holding => {
    const definition = typeof holding.definition === 'string' ? items[holding.definition] : undefined;
    if (definition?.kind !== 'equipment') throw new ExpeditionError('invalid_equipped_item', 409);
    if (holding.rolls !== undefined && JSON.stringify(holding.rolls) !== '{}') {
      // RPG gear-roll semantics are not authored yet; do not silently simulate with incomplete derived stats.
      throw new ExpeditionError('unsupported_equipment_rolls', 409);
    }
    return { stats: definition.stats };
  });
  return {
    actorId: character.actorId,
    build: { level: character.level, attributes: character.attributes as CharacterAttributes, equipment },
    // Character rules treat basic attack as always equipped without consuming an active skill slot.
    skills: [...new Set([BASIC_ATTACK, ...character.skillLoadout])],
    rules: character.automationRules,
  };
}
function safeDto(row: typeof expeditions.$inferSelect, timeline: ExpeditionTimeline | null, nowMs: number, policyRegistry: readonly SettlementPolicy[]) {
  if (row.status !== 'running' && row.terminalReport) {
    const report = row.terminalReport;
    return parseExpeditionDto({ id: row.id, actorId: row.actorId, state: row.status, areaId: row.areaId, activityId: row.activityId,
      startsAtMs: row.startsAtMs, plannedEndsAtMs: row.plannedEndsAtMs,
      progress: { revealed: Array.isArray(report['segments']) ? report['segments'].length : 0 },
      segments: report['segments'] ?? [], revealedDeltas: report['revealedDeltas'] ?? {},
      ...(report['summary'] === null || report['summary'] === undefined ? {} : { summary: report['summary'] }),
      terminalReport: report, report: projectExpeditionResultReport(row, report),
      endsAtMs: typeof report['endsAtMs'] === 'number' ? report['endsAtMs'] : row.settledAt?.getTime() ?? row.endsAtMs,
      outcome: report['outcome'] ?? (row.settledReason === 'version_unavailable' ? 'version_unavailable' : row.status === 'cancelled' ? 'cancelled' : row.outcome) });
  }
  if (row.status !== 'running' && !row.terminalReport && !timeline) {
    return parseExpeditionDto({ id: row.id, actorId: row.actorId, state: row.status, areaId: row.areaId, activityId: row.activityId,
      startsAtMs: row.startsAtMs, plannedEndsAtMs: row.plannedEndsAtMs, progress: { revealed: 0 }, segments: [], revealedDeltas: {},
      terminalReport: null, report: projectExpeditionResultReport(row, null), endsAtMs: row.settledAt?.getTime() ?? row.endsAtMs,
      outcome: row.status === 'cancelled' ? 'cancelled' : row.outcome });
  }
  const policy = findSettlementPolicy(policyRegistry, row.kernelVersion, row.simulatorId, row.simulatorVersion);
  if (row.status === 'running' && !policy) {
    return parseExpeditionDto({ id: row.id, actorId: row.actorId, state: 'running', areaId: row.areaId, activityId: row.activityId,
      startsAtMs: row.startsAtMs, plannedEndsAtMs: row.plannedEndsAtMs, progress: { revealed: 0 }, segments: [], revealedDeltas: {},
      recoveryAvailable: true });
  }
  if (!timeline) throw new Error('running expedition timeline missing');
  const placed = placedOf(row, timeline);
  if (row.status !== 'running' && (!Number.isSafeInteger(row.settledCutoff) || row.settledCutoff === null ||
      row.settledCutoff < -1 || row.settledCutoff >= placed.segments.length)) {
    throw new Error('legacy terminal expedition reveal cutoff is invalid');
  }
  // A partial cancellation is an immutable prefix. Use the settlement timestamp so later reads never reveal the
  // discarded suffix or the natural end/outcome that was known only to the server.
  const frozenAt = row.status === 'running' ? nowMs : (row.settledAt?.getTime() ?? nowMs);
  const timedView = visibleView(placed, frozenAt);
  if (row.status === 'cancelled' && row.settledCutoff !== null && timedView.cutoff !== row.settledCutoff) {
    throw new Error('cancelled expedition reveal cutoff does not match its persisted settlement time');
  }
  // The persisted cutoff is the kernel's settlement decision. Shape cancelled DTOs from that exact prefix so an
  // advancing wall clock can never reveal a discarded suffix after the operation commits.
  const view = row.status !== 'running' && row.settledCutoff !== null ? (() => {
    const segments = placed.segments.slice(0, row.settledCutoff + 1).map(({ index, weight, revealAtMs, events, deltas }) => ({
      index, weight, revealAtMs, events, deltas,
    }));
    return { ...timedView, cutoff: row.settledCutoff, segments,
      revealedDeltas: netDeltas(segments.flatMap(segment => segment.deltas)),
      ...(row.status === 'completed' ? { ended: true, outcome: row.outcome ?? undefined, endedAtMs: placed.endsAtMs } : { ended: false }) };
  })() : timedView;
  const cutoff = row.status === 'cancelled' ? (row.settledCutoff ?? view.cutoff) : view.cutoff;
  const summary = row.status === 'running' && policy ? policy.simulator.summarize(timeline, cutoff) as RpgIdleReport : undefined;
  const preview = row.status === 'running' && policy
      ? settleAt(settlementSimulator(policy, row.escrow as unknown as readonly LedgerDelta[]), timeline, placed, nowMs, 'cancel', row.config as unknown as RpgIdleConfig,
      row.snapshot.participants as unknown as readonly RpgActorSnapshot[])
    : null;
  const cancelPreview = preview?.ok && policy ? {
    rewards: preview.settlement.deltas.filter(d => d.from === undefined && d.qty > 0).map(d => ({ asset: d.asset, qty: d.qty })),
    consumablesUsed: preview.settlement.deltas.flatMap(d => d.from === 'escrow' && d.to === undefined && d.qty > 0 && d.asset.kind === 'stack'
      ? [{ item: d.asset.item, qty: d.qty }] : []),
    consumablesReturned: preview.settlement.deltas.flatMap(d => d.from === 'escrow' && d.to === 'inventory' && d.qty > 0 && d.asset.kind === 'stack'
      ? [{ item: d.asset.item, qty: d.qty }] : []),
    keptProgress: policy.progress(timeline, preview.resolution.cutoff, preview.resolution.reason).actors.map(actor => ({
      actorId: actor.actorId, xpEarned: actor.xpEarned, died: actor.died,
      deathPenaltyApplied: preview.resolution.reason === 'completed' && actor.died,
    })),
    converted: preview.resolution.converted,
  } : undefined;
  return parseExpeditionDto({
    id: row.id, actorId: row.actorId, state: row.status, areaId: row.areaId, activityId: row.activityId,
    startsAtMs: view.startsAtMs, plannedEndsAtMs: view.plannedEndsAtMs,
    progress: { revealed: view.segments.length },
    segments: view.segments.map(({ index, revealAtMs, events }) => ({ index, revealAtMs, events })),
    revealedDeltas: view.revealedDeltas, ...(summary ? { summary } : {}), ...(cancelPreview ? { cancelPreview } : {}),
    ...(row.status === 'running' && !policy ? { recoveryAvailable: true } : {}),
    ...(row.status !== 'running' && !row.terminalReport ? { terminalReport: null,
      report: projectExpeditionResultReport(row, null) } : {}),
    ...(row.status === 'cancelled'
      ? { endsAtMs: row.settledAt?.getTime() ?? row.endsAtMs, outcome: 'cancelled' as const }
      : row.status === 'completed' ? { endsAtMs: view.endedAtMs, outcome: view.outcome } : {}),
  });
}

function terminalDto(row: typeof expeditions.$inferSelect, nowMs: number, policyRegistry: readonly SettlementPolicy[]) {
  if (row.terminalReport) return safeDto(row, null, nowMs, policyRegistry);
  // Historical rows can still expose their already-frozen, immutable timeline prefix while the exact producer
  // adapter is available. This only reads/places the stored timeline; it does not simulate or reconstruct settlement.
  // Rows without a cutoff (for example old version-unavailable recoveries), unsupported tuples, and damaged timelines
  // retain the empty minimal DTO. In either case, the result report remains explicitly unavailable.
  if (!findSettlementPolicy(policyRegistry, row.kernelVersion, row.simulatorId, row.simulatorVersion) || row.settledCutoff === null) {
    return safeDto(row, null, nowMs, policyRegistry);
  }
  try {
    return safeDto(row, timelineOf(row), nowMs, policyRegistry);
  } catch {
    return safeDto(row, null, nowMs, policyRegistry);
  }
}

/**
 * Server-derived simulator inputs shared by `start` and estimates: the character row (locked for the surrounding
 * transaction), its ledger holdings, the build/rules snapshot and the world evaluation context. Clients never send
 * stats; the caller has already checked ownership with `requireOwnedActor`.
 */
export async function readStartSnapshot(tx: ActorTransaction, actorId: string, content: LoadedContent) {
  const [character] = await tx.select().from(characters).where(eq(characters.actorId, actorId)).for('update');
  if (!character) throw new ExpeditionError('not_found', 404);
  const holdings = await getHoldings(tx, actorId);
  const snapshot = snapshotRpgActor(character, holdings, content);
  const context = await readRpgEvalContext(tx, actorId, character.level, holdings);
  return { character, holdings, snapshot, context };
}

/**
 * Kernel start gate shared by `start` and estimates: resolves the activity's simulator, runs `beforeCheck` (e.g. the
 * settlement-policy guard of a real start) and `checkStart`, and returns the parsed config, budget and escrow.
 */
export function gateStart(content: LoadedContent, request: { areaId: string; activityId: string; durationMin: number; paceBp: number },
  rawConfig: unknown, snapshot: RpgActorSnapshot, context: Awaited<ReturnType<typeof readRpgEvalContext>>,
  beforeCheck: (simulator: { id: string; version: string }) => void = () => {}) {
  const world = parseWorld(content);
  const registry = simulators(content);
  const simulator = registry.get(request.activityId);
  if (!simulator) throw new ExpeditionError('start.unknownActivity', 400);
  beforeCheck(simulator);
  const gate = checkStart({ world, request: { ...request, areaId: request.areaId as AreaId }, activities: registry, simulator,
    rawConfig, actors: [snapshot], evalContexts: [context], predicates: createRpgPredicateRegistry() });
  if (!gate.ok) throw new ExpeditionError(gate.code, 400);
  return { simulator, gate };
}

async function loadCharacter(tx: ActorTransaction, actorId: string, accountId: string, lock = true) {
  if (lock) await requireOwnedActor(tx, actorId, accountId, RPG_GAME_ID);
  else {
    const [actor] = await tx.select({ actorId: actors.actorId }).from(actors)
      .where(and(eq(actors.actorId, actorId), eq(actors.accountId, accountId), eq(actors.gameId, RPG_GAME_ID)));
    if (!actor) throw new ExpeditionError('not_found', 404);
  }
  const query = tx.select().from(characters).where(and(eq(characters.actorId, actorId), eq(characters.accountId, accountId)));
  const [character] = lock ? await query.for('update') : await query;
  if (!character) throw new ExpeditionError('not_found', 404);
  return character;
}

/** Transactional RPG composition of checkStart, ledger escrow, deterministic simulation and a durable settle wake-up. */
export function createExpeditionService(tx: ActorTransaction, clock: Clock, content: LoadedContent,
  seedSource: () => number = () => randomBytes(4).readUInt32BE(0),
  settlementPolicies: readonly SettlementPolicy[] = supportedSettlementPolicies) {
  return {
    async options(accountId: string, actorId: string) {
      const world = parseWorld(content);
      const registry = simulators(content);
      const predicates = createRpgPredicateRegistry();
      const idleContent = rpgIdleContentFromBundle(content);
      const character = await loadCharacter(tx, actorId, accountId, false);
      const holdings = await getHoldings(tx, actorId);
      const snapshot = snapshotRpgActor(character, holdings, content);
      const context = await readRpgEvalContext(tx, actorId, character.level, holdings);
      const areas = world.areas.flatMap(area => {
        const activities = (area.activities ?? []).flatMap(activityId => {
          const sim = registry.get(activityId);
          if (!sim) return [];
          const request = { areaId: area.id as AreaId, activityId, durationMin: 15, paceBp: 10_000 };
          const gate = checkStart({ world, request, activities: registry, simulator: sim, rawConfig: { consumables: [], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } }, actors: [snapshot], evalContexts: [context], predicates });
          return gate.ok || gate.code === 'start.areaNotCompleted'
            ? [{ activityId, simulatorId: sim.id, available: gate.ok, ...(gate.ok ? {} : { reason: gate.code }) }]
            : [];
        });
        return activities.length ? [{ areaId: area.id, kind: area.kind, activities }] : [];
      });
      const consumables = Object.values(idleContent.combat.items).filter(item => item.kind === 'consumable').flatMap(item => {
        const qty = holdings.filter(h => h.asset.kind === 'stack' && h.asset.item === item.id && h.container === 'inventory').reduce((n, h) => n + h.qty, 0);
        return qty > 0 ? [{ item: item.id, availableQty: qty }] : [];
      }).sort((a, b) => a.item.localeCompare(b.item));
      return parseExpeditionOptionsDto({ actorId, areas, durationsMin: [15, 30, 60, 180],
        paceBp: { min: 10_000, max: 10_000, default: 10_000 }, consumables });
    },
    async start(accountId: string, payload: { actorId: string; request: { areaId: string; activityId: string; durationMin: number; paceBp: number }; config: unknown }) {
      if (payload.request.paceBp !== 10_000) throw new ExpeditionError('invalid_pace', 400);
      const actor = await requireOwnedActor(tx, payload.actorId, accountId, RPG_GAME_ID);
      if (actor.activityState !== 'none') throw new ExpeditionError('busy', 409);
      const { snapshot, context } = await readStartSnapshot(tx, payload.actorId, content);
      const { simulator, gate } = gateStart(content, payload.request, payload.config, snapshot, context, sim => {
        if (!findSettlementPolicy(settlementPolicies, KERNEL_VERSION, sim.id, sim.version)) {
          throw new ExpeditionError('expedition_settlement_policy_unavailable', 503);
        }
      });

      const nowMs = clock.nowMs();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('invalid expedition clock');
      const id = randomUUID();
      const seed = seedSource();
      if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new RangeError('seed source must return an unsigned 32-bit integer');
      await applyLedgerDeltas(tx, { type: 'expedition_start', id: `${id}:start` }, gate.escrow,
        { activity: ESCROW_ACTIVITY(id) });
      if (!await transitionActivity(tx, payload.actorId, { state: 'none', activityId: null }, { state: 'expedition', activityId: id })) {
        throw new ExpeditionError('activity_conflict', 409);
      }
      const timeline = simulator.simulate({ config: gate.config, actors: [snapshot], seed, budget: gate.budget,
        areaId: payload.request.areaId as AreaId, activityId: payload.request.activityId }) as ExpeditionTimeline;
      const placed = placeSegments(timeline, nowMs, payload.request.durationMin * 60_000, gate.budget);
      const hash = String(timelineHash(timeline as Timeline<unknown, unknown>));
      const compressed = deflateSync(Buffer.from(JSON.stringify(timeline))).toString('base64');
      const [row] = await tx.insert(expeditions).values({ id, actorId: payload.actorId, accountId,
        areaId: payload.request.areaId as AreaId, activityId: payload.request.activityId, status: 'running', startsAtMs: nowMs,
        plannedEndsAtMs: placed.plannedEndsAtMs, endsAtMs: placed.endsAtMs, durationMin: payload.request.durationMin,
        paceBp: payload.request.paceBp, seed: String(seed), revision: 0, kernelVersion: KERNEL_VERSION,
        simulatorId: simulator.id, simulatorVersion: simulator.version, contentHash: content.contentHash,
        budget: gate.budget, config: gate.config as unknown as Record<string, unknown>, snapshot: startSnapshot(snapshot, xpCurve(content)),
        escrow: gate.escrow as unknown as readonly Record<string, unknown>[], timelineCompressed: compressed,
        timelineHash: hash, createdAt: new Date(nowMs) }).returning();
      if (!row) throw new Error('expedition insert returned no row');
      await scheduleJobInTransaction(tx, clock, { name: SETTLE_JOB, singletonKey: `${id}:0`, payload: { expeditionId: id, revision: 0 }, dueAtMs: placed.endsAtMs });
      return safeDto(row, timeline, nowMs, settlementPolicies);
    },
    async get(accountId: string, id: string) {
      const [existing] = await tx.select().from(expeditions).where(and(eq(expeditions.id, id), eq(expeditions.accountId, accountId)));
      if (!existing) throw new ExpeditionError('not_found', 404);
      await requireOwnedActor(tx, existing.actorId, accountId, RPG_GAME_ID);
      const [locked] = await tx.select().from(expeditions).where(eq(expeditions.id, id)).for('update');
      if (!locked) throw new ExpeditionError('not_found', 404);
      const nowMs = clock.nowMs();
      if (locked.status === 'running' && nowMs >= locked.endsAtMs && findSettlementPolicy(settlementPolicies, locked.kernelVersion, locked.simulatorId, locked.simulatorVersion)) {
        await settle(id, 'complete', undefined, nowMs);
      }
      const [row] = await tx.select().from(expeditions).where(eq(expeditions.id, id));
      if (!row) throw new ExpeditionError('not_found', 404);
      const hasPolicy = findSettlementPolicy(settlementPolicies, row.kernelVersion, row.simulatorId, row.simulatorVersion);
      if (row.status !== 'running') return terminalDto(row, nowMs, settlementPolicies);
      return safeDto(row, hasPolicy ? timelineOf(row) : null, nowMs, settlementPolicies);
    },
    async list(accountId: string, actorId: string) {
      await requireOwnedActor(tx, actorId, accountId, RPG_GAME_ID);
      const rows = await tx.select().from(expeditions).where(and(eq(expeditions.actorId, actorId), eq(expeditions.accountId, accountId)))
        .orderBy(desc(expeditions.createdAt), desc(expeditions.id)).limit(20);
      const out = [];
      for (const initial of rows) {
        const nowMs = clock.nowMs();
        if (initial.status === 'running' && nowMs >= initial.endsAtMs && findSettlementPolicy(settlementPolicies, initial.kernelVersion, initial.simulatorId, initial.simulatorVersion)) {
          await settle(initial.id, 'complete', undefined, nowMs);
        }
        const [row] = await tx.select().from(expeditions).where(eq(expeditions.id, initial.id));
        if (row) {
          const hasPolicy = findSettlementPolicy(settlementPolicies, row.kernelVersion, row.simulatorId, row.simulatorVersion);
          out.push(row.status === 'running' ? safeDto(row, hasPolicy ? timelineOf(row) : null, nowMs, settlementPolicies)
            : terminalDto(row, nowMs, settlementPolicies));
        }
      }
      return out;
    },
    async cancel(accountId: string, id: string) {
      const [initial] = await tx.select().from(expeditions).where(and(eq(expeditions.id, id), eq(expeditions.accountId, accountId)));
      if (!initial) throw new ExpeditionError('not_found', 404);
      await requireOwnedActor(tx, initial.actorId, accountId, RPG_GAME_ID);
      const result = await settle(id, 'cancel');
      return result;
    },
    async recoverUnavailable(accountId: string, id: string) {
      const [initial] = await tx.select().from(expeditions).where(and(eq(expeditions.id, id), eq(expeditions.accountId, accountId)));
      if (!initial) throw new ExpeditionError('not_found', 404);
      await requireOwnedActor(tx, initial.actorId, accountId, RPG_GAME_ID);
      const [row] = await tx.select().from(expeditions).where(eq(expeditions.id, id)).for('update');
      if (!row) throw new ExpeditionError('not_found', 404);
      if (row.status !== 'running') {
        const terminal = await tx.select().from(expeditions).where(eq(expeditions.id, id));
        return terminal[0] ? terminalDto(terminal[0], clock.nowMs(), settlementPolicies) : null;
      }
      if (findSettlementPolicy(settlementPolicies, row.kernelVersion, row.simulatorId, row.simulatorVersion)) throw new ExpeditionError('expedition_version_available', 409);
      const nowMs = clock.nowMs();
      const persistedEscrow = row.escrow as unknown as readonly LedgerDelta[];
      try { assertEscrow(persistedEscrow); }
      catch { throw new ExpeditionError('expedition_escrow_invalid', 409); }
      const returns = persistedEscrow.map(delta => {
        if (delta.actorId !== row.actorId || !delta.from) throw new ExpeditionError('expedition_escrow_invalid', 409);
        return { ...delta, from: 'escrow' as const, to: delta.from };
      });
      await applyLedgerDeltas(tx, { type: 'expedition_settlement', id: `${id}:${row.revision}:version-recovery` }, returns,
        { activity: ESCROW_ACTIVITY(id) });
      if (!await transitionActivity(tx, row.actorId, { state: 'expedition', activityId: id }, { state: 'none', activityId: null })) {
        throw new ExpeditionError('activity_conflict', 409);
      }
      const [updated] = await tx.update(expeditions).set({ status: 'cancelled', settledAt: new Date(nowMs),
        settledReason: 'version_unavailable', settledCutoff: null, outcome: null,
        terminalReport: { version: 1, kind: 'escrow_returned', summary: null, segments: [], revealedDeltas: {}, settledDeltas: returns,
          xp: [], reason: 'version_unavailable', cutoff: null, outcome: 'version_unavailable', recoveredAtMs: nowMs },
      }).where(and(eq(expeditions.id, id), eq(expeditions.status, 'running'), eq(expeditions.revision, row.revision))).returning({ id: expeditions.id });
      if (!updated) throw new ExpeditionError('activity_conflict', 409);
      const [completed] = await tx.select().from(expeditions).where(eq(expeditions.id, id));
      return completed ? safeDto(completed, null, nowMs, settlementPolicies) : null;
    },
    async settleJob(id: string, revision: number) {
      const [row] = await tx.select().from(expeditions).where(eq(expeditions.id, id));
      if (!row || row.status !== 'running' || row.revision !== revision) return;
      await settle(id, 'complete', revision);
    },
  };

  async function settle(id: string, requested: 'complete' | 'cancel', expectedRevision?: number, observedNowMs?: number) {
    const [preview] = await tx.select().from(expeditions).where(eq(expeditions.id, id));
    if (!preview) throw new ExpeditionError('not_found', 404);
    await requireOwnedActor(tx, preview.actorId, preview.accountId, RPG_GAME_ID);
    const [row] = await tx.select().from(expeditions).where(eq(expeditions.id, id)).for('update');
    if (!row) throw new ExpeditionError('not_found', 404);
    if (expectedRevision !== undefined && (row.status !== 'running' || row.revision !== expectedRevision)) return null;
    if (row.status !== 'running') return terminalDto(row, clock.nowMs(), settlementPolicies);
    const policy = findSettlementPolicy(settlementPolicies, row.kernelVersion, row.simulatorId, row.simulatorVersion);
    if (!policy) throw new ExpeditionError('expedition_version_unavailable', 503);
    const timeline = timelineOf(row);
    const placed = placedOf(row, timeline);
    const actorsSnapshot = row.snapshot.participants as unknown as readonly RpgActorSnapshot[];
    const resolutionAtMs = observedNowMs ?? clock.nowMs();
    const settlement = settleAt(settlementSimulator(policy, row.escrow as unknown as readonly LedgerDelta[]), timeline, placed, resolutionAtMs, requested, row.config as unknown as RpgIdleConfig, actorsSnapshot);
    if (!settlement.ok) throw new ExpeditionError(settlement.code, 409);
    if (row.status === 'running') {
      await applyLedgerDeltas(tx, { type: 'expedition_settlement', id: `${id}:${row.revision}` }, settlement.settlement.deltas,
        { activity: ESCROW_ACTIVITY(id) });
      const progress = policy.progress(timeline, settlement.resolution.cutoff, settlement.resolution.reason);
      const curve = policy.xp.curve(row.snapshot);
      const [character] = await tx.select().from(characters).where(eq(characters.actorId, row.actorId)).for('update');
      if (!character) throw new ExpeditionError('not_found', 404);
      const actorProgress = progress.actors.find(value => value.actorId === row.actorId);
      const xpBefore = totalXpFromLevelProgress(character.level, character.xp, curve);
      let xpAfter = xpBefore;
      let xpEarned = 0;
      let xpPenaltyApplied = false;
      let xpPenaltyBp = 0;
      if (actorProgress) {
        xpEarned = actorProgress.xpEarned;
        xpAfter = xpBefore + xpEarned;
        if (progress.applyDeathPenalty && actorProgress.died) {
          const loss = policy.xp.deathLoss(xpAfter, curve, progress);
          xpAfter = loss.totalXp;
          xpPenaltyBp = loss.lossBp;
          xpPenaltyApplied = true;
        }
        const next = xpProgress(xpAfter, curve);
        await tx.update(characters).set({ level: next.level, xp: next.xpIntoLevel }).where(eq(characters.actorId, row.actorId));
      }
      const finalSegments = placed.segments.slice(0, settlement.resolution.cutoff + 1).map(({ index, revealAtMs, events }) => ({ index, revealAtMs, events }));
      const finalDeltas = netDeltas(placed.segments.slice(0, settlement.resolution.cutoff + 1).flatMap(segment => segment.deltas));
      const terminalReport = { version: 1, kind: 'settled', summary: policy.simulator.summarize(timeline, settlement.resolution.cutoff),
        segments: finalSegments, revealedDeltas: finalDeltas,
        settledDeltas: settlement.settlement.deltas, xp: [{ actorId: row.actorId, xpBefore, xpEarned,
          xpPenaltyApplied, xpPenaltyBp,
          xpPenaltyLost: xpBefore + xpEarned - xpAfter, xpAfter }],
        reason: settlement.resolution.reason, cutoff: settlement.resolution.cutoff,
        outcome: settlement.resolution.reason === 'completed' ? timeline.outcome : 'cancelled',
        endsAtMs: settlement.resolution.reason === 'completed' ? placed.endsAtMs : resolutionAtMs };
      if (!await transitionActivity(tx, row.actorId, { state: 'expedition', activityId: id }, { state: 'none', activityId: null })) {
        throw new ExpeditionError('activity_conflict', 409);
      }
      const [updated] = await tx.update(expeditions).set({ status: settlement.resolution.reason === 'completed' ? 'completed' : 'cancelled',
        ...(settlement.resolution.reason === 'completed' ? {} : { endsAtMs: resolutionAtMs }),
        settledAt: new Date(resolutionAtMs), settledReason: settlement.resolution.reason === 'completed' ? 'completed' : 'cancelled',
        settledCutoff: settlement.resolution.cutoff, outcome: settlement.resolution.reason === 'completed' ? timeline.outcome : null,
        terminalReport })
        .where(and(eq(expeditions.id, id), eq(expeditions.status, 'running'), eq(expeditions.revision, row.revision),
          ...(expectedRevision === undefined ? [] : [eq(expeditions.revision, expectedRevision)]))).returning({ id: expeditions.id });
      if (!updated) throw new ExpeditionError('activity_conflict', 409);
    }
    const [completed] = await tx.select().from(expeditions).where(eq(expeditions.id, id));
    if (!completed) throw new Error('settled expedition disappeared');
    return safeDto(completed, completed.terminalReport ? null : timeline, clock.nowMs(), settlementPolicies);
  }
}
