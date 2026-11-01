/**
 * `survival.scavenge`: the sandbox's `ExpeditionSimulator` (docs/engine/expedition-kernel.md §4).
 *
 * One segment = one in-game hour (weight 1). Every hour each survivor group (sorted by actorId) eats and drinks one
 * ration and one water per member, searches the district (`finds` stream) up to its carry capacity, may suffer an
 * ongoing infection, may hit a threat (`threats` stream) that lowers its condition, and uses a medkit automatically
 * when its condition drops below the threshold. Outcomes: `failed` when a group's condition reaches 0, `retreated`
 * when a group cannot afford another hour of food/water before the budget is used up, otherwise `completed`.
 *
 * RNG: each hour uses `RngStreams.fromSeed(deriveSeed(seed, 'hour', index))`, so an hour's rolls depend only on
 * `(seed, hour index)`. Resuming from `stateAfter` with the same seed reproduces the original suffix exactly; with a
 * revision seed (party revisions) the remainder is re-rolled.
 *
 * All game math is integer (condition points, item counts, basis points).
 */
import { assetKey } from '@engine/economy';
import type { AssetRef, LedgerDelta } from '@engine/economy';
import { defaultSettle } from '@engine/expedition-kernel';
import type { ExpeditionSimulator, Outcome, Segment, Timeline } from '@engine/expedition-kernel';
import { BP_SCALE, RngStreams, deriveSeed, mulBp, mulDivFloor } from '@engine/sim-core';
import type { AreaId } from '@engine/world';

import { INFECTION_THREAT, SCAVENGE_TABLES } from './tables.ts';
import type { ScavengeTables } from './tables.ts';

export const SCAVENGE_SIMULATOR_ID = 'survival.scavenge';
/** Bump on any behaviour change (in-flight expeditions keep their stored timeline). */
export const SCAVENGE_SIMULATOR_VERSION = '1.0.0';

/** Game-defined container where scavenged finds are carried until the group is back at the shelter. */
export const PACK = 'pack';
/** Engine container holding the supplies escrowed at start. */
export const ESCROW = 'escrow';

export const SUPPLY_ITEMS = { food: 'item:ration', water: 'item:water', medkits: 'item:medkit' } as const;
export const stack = (item: string): AssetRef => ({ kind: 'stack', item });

export const DURATIONS_MIN = [60, 120, 180] as const;
export type DurationMin = (typeof DURATIONS_MIN)[number];
const MAX_SUPPLY = 1_000_000;
export const MAX_CONDITION = 100;
/** Share of the finds lost when the run fails (basis points, floored). */
export const FAILURE_LOSS_BP = 5000;

export interface Supplies {
  readonly food: number;
  readonly water: number;
  readonly medkits: number;
}

export interface ScavengeConfig {
  readonly district: AreaId;
  readonly durationMin: DurationMin;
  /** Supplies each participating group brings (escrowed at start). */
  readonly supplies: Supplies;
}

/** Actor snapshot: a survivor group. */
export interface SurvivorGroup {
  readonly actorId: string;
  readonly members: number;
  /** 0..100. */
  readonly condition: number;
  /** Max number of item units the group can carry back. */
  readonly carryCapacity: number;
}

export type ScavengeEvent =
  | { readonly type: 'consumed'; readonly actorId: string; readonly food: number; readonly water: number }
  | { readonly type: 'found'; readonly actorId: string; readonly item: string; readonly qty: number; readonly kept: number }
  | { readonly type: 'infection'; readonly actorId: string; readonly damage: number; readonly conditionAfter: number }
  | {
      readonly type: 'threat';
      readonly actorId: string;
      readonly threat: string;
      readonly damage: number;
      readonly conditionAfter: number;
    }
  | { readonly type: 'medkit'; readonly actorId: string; readonly healed: number; readonly conditionAfter: number }
  | { readonly type: 'down'; readonly actorId: string; readonly cause: string }
  | { readonly type: 'retreat'; readonly actorId: string; readonly reason: 'out_of_food' | 'out_of_water' };

export interface GroupState {
  readonly actorId: string;
  readonly condition: number;
  readonly food: number;
  readonly water: number;
  readonly medkits: number;
  readonly carried: number;
  readonly infected: boolean;
}

/** Simulator state after an hour (server-only). */
export interface ScavengeState {
  readonly groups: readonly GroupState[];
}

export interface ScavengeReport {
  readonly hours: number;
  /** Outcome, only when the report covers the whole timeline. */
  readonly outcome: Outcome | null;
  /** Units stowed in the pack per item (before any failure loss). */
  readonly finds: Readonly<Record<string, number>>;
  /** Units found but left behind for lack of carry capacity. */
  readonly leftBehind: number;
  readonly threats: Readonly<Record<string, number>>;
  readonly medkitsUsed: number;
  readonly suppliesUsed: { readonly food: number; readonly water: number };
  /** Threat (or `infection`) that brought a group down, only when the report covers a failed timeline. */
  readonly causeOfFailure: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function intIn(v: unknown, min: number, max: number, name: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new TypeError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

function onlyKeys(o: Record<string, unknown>, keys: readonly string[], name: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new TypeError(`${name}: unknown key "${k}"`);
}

/** Hand-written validation of untrusted config input (no schema library needed). */
export function parseScavengeConfig(input: unknown, tables: ScavengeTables = SCAVENGE_TABLES): ScavengeConfig {
  if (!isRecord(input)) throw new TypeError('config must be an object');
  onlyKeys(input, ['district', 'durationMin', 'supplies'], 'config');
  const district = input['district'];
  if (typeof district !== 'string' || !Object.hasOwn(tables.districts, district)) {
    throw new TypeError(`config.district must be one of ${Object.keys(tables.districts).join(', ')}`);
  }
  const durationMin = input['durationMin'];
  if (!DURATIONS_MIN.includes(durationMin as DurationMin)) {
    throw new TypeError(`config.durationMin must be one of ${DURATIONS_MIN.join(', ')}`);
  }
  const supplies = input['supplies'];
  if (!isRecord(supplies)) throw new TypeError('config.supplies must be an object');
  onlyKeys(supplies, ['food', 'water', 'medkits'], 'config.supplies');
  return {
    district: district as AreaId,
    durationMin: durationMin as DurationMin,
    supplies: {
      food: intIn(supplies['food'], 0, MAX_SUPPLY, 'config.supplies.food'),
      water: intIn(supplies['water'], 0, MAX_SUPPLY, 'config.supplies.water'),
      medkits: intIn(supplies['medkits'], 0, MAX_SUPPLY, 'config.supplies.medkits'),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface MutableGroup {
  actorId: string;
  members: number;
  carryCapacity: number;
  condition: number;
  food: number;
  water: number;
  medkits: number;
  carried: number;
  infected: boolean;
  lastHarm: string;
}

function initialGroups(config: ScavengeConfig, actors: readonly SurvivorGroup[], state: ScavengeState | undefined): MutableGroup[] {
  return [...actors]
    .sort((a, b) => cmp(a.actorId, b.actorId))
    .map((a): MutableGroup => {
      const saved = state?.groups.find((g) => g.actorId === a.actorId);
      return {
        actorId: a.actorId,
        members: a.members,
        carryCapacity: a.carryCapacity,
        condition: saved?.condition ?? a.condition,
        food: saved?.food ?? config.supplies.food,
        water: saved?.water ?? config.supplies.water,
        medkits: saved?.medkits ?? config.supplies.medkits,
        carried: saved?.carried ?? 0,
        infected: saved?.infected ?? false,
        lastHarm: 'none',
      };
    });
}

function shortage(g: MutableGroup): 'out_of_food' | 'out_of_water' | null {
  if (g.food < g.members) return 'out_of_food';
  if (g.water < g.members) return 'out_of_water';
  return null;
}

function snapshotState(groups: readonly MutableGroup[]): ScavengeState {
  return {
    groups: groups.map((g) => ({
      actorId: g.actorId,
      condition: g.condition,
      food: g.food,
      water: g.water,
      medkits: g.medkits,
      carried: g.carried,
      infected: g.infected,
    })),
  };
}

function damage(g: MutableGroup, amount: number, source: string): void {
  g.condition = g.condition > amount ? g.condition - amount : 0;
  if (amount > 0) g.lastHarm = source;
}

export function createScavengeSimulator(
  tables: ScavengeTables = SCAVENGE_TABLES,
): ExpeditionSimulator<ScavengeConfig, SurvivorGroup, ScavengeEvent, ScavengeState, ScavengeReport> {
  return {
    id: SCAVENGE_SIMULATOR_ID,
    version: SCAVENGE_SIMULATOR_VERSION,

    parseConfig: (input) => parseScavengeConfig(input, tables),

    canStart({ config, actors, durationMin }) {
      if (durationMin !== config.durationMin) return { ok: false, code: 'duration_mismatch' };
      if (actors.length === 0) return { ok: false, code: 'no_actors' };
      const ids = new Set<string>();
      for (const a of actors) {
        if (a.actorId === '' || ids.has(a.actorId)) return { ok: false, code: 'invalid_actor' };
        ids.add(a.actorId);
        if (!Number.isSafeInteger(a.members) || a.members < 1) return { ok: false, code: 'invalid_actor' };
        if (!Number.isSafeInteger(a.carryCapacity) || a.carryCapacity < 0) return { ok: false, code: 'invalid_actor' };
        if (!Number.isSafeInteger(a.condition) || a.condition < 1 || a.condition > MAX_CONDITION) {
          return { ok: false, code: 'group_incapacitated' };
        }
        if (config.supplies.food < a.members || config.supplies.water < a.members) {
          return { ok: false, code: 'insufficient_supplies', message: 'bring at least one hour of food and water per member' };
        }
      }
      return { ok: true };
    },

    budget(_config, durationMin, paceBp) {
      // One segment per in-game hour; pace scales how many hours fit in the wall-clock duration.
      const hours = mulDivFloor(durationMin, paceBp, 60 * BP_SCALE);
      return hours < 1 ? 1 : hours;
    },

    simulate({ config, actors, seed, budget, from }) {
      const district = tables.districts[config.district];
      if (district === undefined) throw new RangeError(`unknown district ${config.district}`);
      const groups = initialGroups(config, actors, from?.state);
      const segments: Segment<ScavengeEvent, ScavengeState>[] = [];
      if (groups.some((g) => shortage(g) !== null)) return { segments, outcome: 'retreated' };

      const findTable = district.finds.map((e) => ({ weight: e.weight, value: e }));
      const threatTable = district.threats.map((e) => ({ weight: e.weight, value: e }));
      let outcome: Outcome = 'completed';
      let index = from?.segment ?? 0;
      for (let used = 0; used < budget; used++, index++) {
        const streams = RngStreams.fromSeed(deriveSeed(seed, 'hour', index));
        const finds = streams.stream('finds');
        const threats = streams.stream('threats');
        const events: ScavengeEvent[] = [];
        const deltas: LedgerDelta[] = [];

        for (const g of groups) {
          // Upkeep.
          g.food -= g.members;
          g.water -= g.members;
          events.push({ type: 'consumed', actorId: g.actorId, food: g.members, water: g.members });
          deltas.push({ actorId: g.actorId, asset: stack(SUPPLY_ITEMS.food), qty: g.members, from: ESCROW });
          deltas.push({ actorId: g.actorId, asset: stack(SUPPLY_ITEMS.water), qty: g.members, from: ESCROW });

          // Ongoing infection.
          if (g.infected && tables.infection.damagePerHour > 0) {
            damage(g, tables.infection.damagePerHour, 'infection');
            events.push({ type: 'infection', actorId: g.actorId, damage: tables.infection.damagePerHour, conditionAfter: g.condition });
          }

          // Searching.
          const searches = g.members * district.searchesPerMember;
          for (let s = 0; s < searches; s++) {
            const entry = finds.pickWeighted(findTable);
            if (entry.item === null) continue;
            const qty = finds.int(entry.min, entry.max);
            const room = g.carryCapacity - g.carried;
            const kept = qty < room ? qty : room;
            g.carried += kept;
            events.push({ type: 'found', actorId: g.actorId, item: entry.item, qty, kept });
            if (kept > 0) deltas.push({ actorId: g.actorId, asset: stack(entry.item), qty: kept, to: PACK });
          }

          // Threats.
          if (threats.chanceBp(district.threatChanceBp)) {
            const t = threats.pickWeighted(threatTable);
            const dmg = threats.int(t.minDamage, t.maxDamage);
            damage(g, dmg, t.threat);
            if (t.threat === INFECTION_THREAT) g.infected = true;
            events.push({ type: 'threat', actorId: g.actorId, threat: t.threat, damage: dmg, conditionAfter: g.condition });
          }

          // Automatic medkit.
          if (g.condition > 0 && g.condition < tables.medkit.useBelowCondition && g.medkits > 0) {
            g.medkits -= 1;
            const missing = MAX_CONDITION - g.condition;
            const healed = tables.medkit.heal < missing ? tables.medkit.heal : missing;
            g.condition += healed;
            g.infected = false;
            events.push({ type: 'medkit', actorId: g.actorId, healed, conditionAfter: g.condition });
            deltas.push({ actorId: g.actorId, asset: stack(SUPPLY_ITEMS.medkits), qty: 1, from: ESCROW });
          }

          if (g.condition === 0) events.push({ type: 'down', actorId: g.actorId, cause: g.lastHarm });
        }

        if (groups.some((g) => g.condition === 0)) {
          outcome = 'failed';
        } else if (used + 1 < budget) {
          for (const g of groups) {
            const reason = shortage(g);
            if (reason !== null) {
              events.push({ type: 'retreat', actorId: g.actorId, reason });
              outcome = 'retreated';
            }
          }
        }
        segments.push({ index, weight: 1, events, deltas, stateAfter: snapshotState(groups) });
        if (outcome !== 'completed') break;
      }
      return { segments, outcome };
    },

    settle(timeline, cutoff, reason) {
      const deltas = defaultSettle(timeline, cutoff);
      const failedAtEnd = reason === 'completed' && timeline.outcome === 'failed' && cutoff === timeline.segments.length - 1;
      return failedAtEnd ? applyFailureLoss(deltas) : deltas;
    },

    summarize(timeline, cutoff) {
      return summarizeScavenge(timeline, cutoff);
    },
  };
}

/**
 * Failure settlement: supply consumption is kept as-is; the finds in the pack are aggregated per (actor, item) and
 * only `total − ⌊total × FAILURE_LOSS_BP / 10000⌋` is granted.
 */
function applyFailureLoss(deltas: readonly LedgerDelta[]): LedgerDelta[] {
  const out: LedgerDelta[] = [];
  const finds = new Map<string, { actorId: string; asset: AssetRef; qty: number }>();
  for (const d of deltas) {
    if (d.to !== PACK || d.from !== undefined) {
      out.push(d);
      continue;
    }
    const key = JSON.stringify([d.actorId, assetKey(d.asset)]);
    const entry = finds.get(key);
    if (entry === undefined) finds.set(key, { actorId: d.actorId, asset: d.asset, qty: d.qty });
    else entry.qty += d.qty;
  }
  for (const f of finds.values()) {
    const kept = f.qty - mulBp(f.qty, FAILURE_LOSS_BP);
    if (kept > 0) out.push({ actorId: f.actorId, asset: f.asset, qty: kept, to: PACK });
  }
  return out;
}

function sortedRecord(m: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => cmp(a, b)));
}

export function summarizeScavenge(timeline: Timeline<ScavengeEvent, ScavengeState>, cutoff: number): ScavengeReport {
  const finds = new Map<string, number>();
  const threats = new Map<string, number>();
  let leftBehind = 0;
  let medkitsUsed = 0;
  let food = 0;
  let water = 0;
  let cause: string | null = null;
  const covered = timeline.segments.slice(0, cutoff + 1);
  for (const s of covered) {
    for (const e of s.events) {
      switch (e.type) {
        case 'consumed':
          food += e.food;
          water += e.water;
          break;
        case 'found':
          if (e.kept > 0) finds.set(e.item, (finds.get(e.item) ?? 0) + e.kept);
          leftBehind += e.qty - e.kept;
          break;
        case 'threat':
          threats.set(e.threat, (threats.get(e.threat) ?? 0) + 1);
          break;
        case 'medkit':
          medkitsUsed += 1;
          break;
        case 'down':
          cause ??= e.cause;
          break;
        case 'infection':
        case 'retreat':
          break;
      }
    }
  }
  const whole = cutoff === timeline.segments.length - 1;
  return {
    hours: covered.length,
    outcome: whole ? timeline.outcome : null,
    finds: sortedRecord(finds),
    leftBehind,
    threats: sortedRecord(threats),
    medkitsUsed,
    suppliesUsed: { food, water },
    causeOfFailure: whole && timeline.outcome === 'failed' ? cause : null,
  };
}

/** The simulator with the shipped content tables. */
export const scavengeSimulator = createScavengeSimulator();
