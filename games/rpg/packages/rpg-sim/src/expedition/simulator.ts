/**
 * The RPG `ExpeditionSimulator`s (`rpg.hunt`, `rpg.gather`) on the expedition kernel v0.2 (ADR-0019), and the
 * activity registry of the RPG.
 */
import type { LedgerDelta } from '@engine/economy';
import { ActivityRegistry } from '@engine/expedition-kernel';
import type { ExpeditionSimulator, StartCheck } from '@engine/expedition-kernel';
import { AutomationRulesSchema } from '@rpg/rpg-schema';
import type { RpgGameContext } from '@rpg/rpg-schema';
import { DEFAULT_STAT_FORMULAS, deriveStats } from '@rpg/rpg-stats';

import { ENGINE_VERSION } from '../version.ts';
import { IDLE_KINDS, idleKindOf, parseRpgIdleConfig } from './config.ts';
import type { IdleKind } from './config.ts';
import type { ContentBundleLike, RpgIdleContent } from './content.ts';
import { consumableOf, rpgIdleContentFromBundle } from './content.ts';
import { ESCROW, INVENTORY, stack } from './deltas.ts';
import { settleIdle, summarizeIdle } from './settle.ts';
import { DEFAULT_RPG_IDLE_TUNING, idleBudget, simulateIdle } from './simulate.ts';
import type { RpgIdleTuning } from './simulate.ts';
import type { RpgActorSnapshot, RpgIdleConfig, RpgIdleEvent, RpgIdleReport, RpgIdleState } from './types.ts';

/**
 * Behaviour version of the idle simulation model (segment model, regen, loot rolls, settlement, events). Bump on any
 * behaviour change and append a new entry to `golden.json` (see README).
 */
export const RPG_IDLE_VERSION = 'rpg-idle@1.0.0';

/**
 * Stored simulator version: the idle model version **and** the combat engine version it runs, so a combat engine bump
 * also changes the stored simulator version (and needs a new golden entry).
 */
export const RPG_IDLE_SIMULATOR_VERSION = `${RPG_IDLE_VERSION}+${ENGINE_VERSION}`;

export const RPG_HUNT_SIMULATOR_ID = 'rpg.hunt';
export const RPG_GATHER_SIMULATOR_ID = 'rpg.gather';

export type RpgExpeditionSimulator = ExpeditionSimulator<
  RpgIdleConfig,
  RpgActorSnapshot,
  RpgIdleEvent,
  RpgIdleState,
  RpgIdleReport,
  RpgGameContext
>;

export interface RpgIdleOptions {
  readonly tuning?: Partial<RpgIdleTuning>;
}

function fail(code: string, message?: string, reasons?: readonly string[]): StartCheck {
  return { ok: false, code, ...(message === undefined ? {} : { message }), ...(reasons === undefined ? {} : { reasons }) };
}

/** Problems of one actor snapshot against content (empty = valid). */
function actorProblem(content: RpgIdleContent, a: RpgActorSnapshot): string | null {
  if (typeof a.actorId !== 'string' || a.actorId === '') return 'actorId must be a non-empty string';
  if (a.actorId.startsWith('foe:')) return 'actorId must not use the reserved "foe:" prefix';
  let maxHp: number;
  try {
    maxHp = deriveStats(a.build, content.formulas ?? DEFAULT_STAT_FORMULAS).maxHp;
  } catch (e) {
    return `invalid build: ${(e as Error).message}`;
  }
  if (a.hp !== undefined && (!Number.isSafeInteger(a.hp) || a.hp < 1 || a.hp > maxHp)) return `hp must be in [1, ${maxHp}]`;
  if (a.skills.length === 0) return 'no skills equipped';
  for (const s of a.skills) if (content.combat.skills[s] === undefined) return `unknown skill ${s}`;
  const rules = AutomationRulesSchema.safeParse(a.rules);
  if (!rules.success) return `invalid rules: ${rules.error.issues[0]?.message ?? 'schema'}`;
  for (const r of rules.data) {
    if ('useSkill' in r.do && !a.skills.includes(r.do.useSkill)) return `rule uses ${r.do.useSkill}, which is not equipped`;
    if (r.when.skillReady !== undefined && !a.skills.includes(r.when.skillReady)) return `rule checks ${r.when.skillReady}, which is not equipped`;
    const item = 'useConsumable' in r.do ? r.do.useConsumable : r.when.hasConsumable;
    if (item !== undefined && consumableOf(content, item) === undefined) return `rule references ${item}, which is not a consumable`;
  }
  return null;
}

/** Creates the simulator of one idle kind over `content` (pure; content is read-only). */
export function createRpgIdleSimulator(kind: IdleKind, content: RpgIdleContent, options: RpgIdleOptions = {}): RpgExpeditionSimulator {
  const tuning: RpgIdleTuning = { ...DEFAULT_RPG_IDLE_TUNING, ...options.tuning };
  const activityOf = (config: RpgIdleConfig) => {
    const a = content.idleActivities[config.activity];
    if (a === undefined || idleKindOf(config.activity) !== kind) throw new RangeError(`${config.activity} is not a ${kind} activity`);
    return a;
  };
  return {
    id: `rpg.${kind}`,
    version: RPG_IDLE_SIMULATOR_VERSION,

    parseConfig: (input) => parseRpgIdleConfig(input, content, kind),

    canStart({ config, actors, durationMin, area }) {
      if (!tuning.durationsMin.includes(durationMin)) {
        return fail('rpg.invalidDuration', `duration must be one of ${tuning.durationsMin.join(', ')} minutes`);
      }
      const activity = content.idleActivities[config.activity];
      if (activity === undefined) return fail('rpg.unknownActivity', `unknown activity ${config.activity}`);
      if (idleKindOf(config.activity) !== kind) return fail('rpg.activityKindMismatch', `${config.activity} is not a ${kind} activity`);
      // Through checkStart, the requested area must list the configured activity. (The kernel does not pass the
      // request's activityId; the server must build `config.activity` from it — see README findings.)
      if (area !== undefined && !(area.activities ?? []).includes(config.activity)) {
        return fail('rpg.activityNotInArea', `${config.activity} is not an activity of ${area.id}`);
      }
      if (activity.encounterTable !== undefined && content.encounterTables[activity.encounterTable] === undefined) {
        return fail('rpg.unknownActivity', `unknown encounter table ${activity.encounterTable}`);
      }
      const items = new Set<string>();
      for (const c of config.consumables) {
        if (consumableOf(content, c.item) === undefined) return fail('rpg.invalidConsumable', `${c.item} is not a consumable`);
        if (!Number.isSafeInteger(c.qty) || c.qty < 1 || items.has(c.item)) return fail('rpg.invalidConsumable', `invalid stack ${c.item}`);
        items.add(c.item);
      }
      if (actors.length === 0) return fail('rpg.noActors');
      const ids = new Set<string>();
      for (const a of actors) {
        if (ids.has(a.actorId)) return fail('rpg.invalidActor', `duplicate actor ${a.actorId}`);
        ids.add(a.actorId);
        const problem = actorProblem(content, a);
        if (problem !== null) return fail('rpg.invalidActor', `${a.actorId}: ${problem}`);
      }
      return { ok: true };
    },

    escrow(config, actors) {
      const out: LedgerDelta[] = [];
      for (const a of [...actors].sort((x, y) => (x.actorId < y.actorId ? -1 : x.actorId > y.actorId ? 1 : 0))) {
        for (const c of config.consumables) out.push({ actorId: a.actorId, asset: stack(c.item), qty: c.qty, from: INVENTORY, to: ESCROW });
      }
      return out;
    },

    budget: (config, durationMin, paceBp) => idleBudget(activityOf(config), tuning, durationMin, paceBp),

    simulate(input) {
      activityOf(input.config);
      return simulateIdle(content, tuning, input);
    },

    settle: (timeline, cutoff, reason) => settleIdle(tuning, timeline, cutoff, reason),

    summarize: (timeline, cutoff) => summarizeIdle(timeline, cutoff),
  };
}

export interface RpgIdleSimulators {
  readonly hunt: RpgExpeditionSimulator;
  readonly gather: RpgExpeditionSimulator;
}

export function createRpgIdleSimulators(content: RpgIdleContent, options: RpgIdleOptions = {}): RpgIdleSimulators {
  return { hunt: createRpgIdleSimulator('hunt', content, options), gather: createRpgIdleSimulator('gather', content, options) };
}

function isIdleContent(x: RpgIdleContent | ContentBundleLike): x is RpgIdleContent {
  return 'idleActivities' in x;
}

/**
 * The RPG activity registry: every content idle activity whose kind (last ID segment, {@link idleKindOf}) is a known
 * idle kind is mapped to `rpg.<kind>`. Accepts a compiled bundle or prepared content. Activities listed by areas but
 * not mapped are found with the kernel's `unregisteredActivities(world, registry)`.
 */
export function createRpgActivityRegistry(source: RpgIdleContent | ContentBundleLike, options: RpgIdleOptions = {}): ActivityRegistry {
  const content = isIdleContent(source) ? source : rpgIdleContentFromBundle(source);
  const sims = createRpgIdleSimulators(content, options);
  const registry = new ActivityRegistry();
  for (const id of Object.keys(content.idleActivities).sort()) {
    const kind = idleKindOf(id);
    if (kind !== null && IDLE_KINDS.includes(kind)) registry.register(id, sims[kind]);
  }
  return registry;
}
