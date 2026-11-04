/**
 * Data types of the RPG idle expedition simulators (`rpg.hunt`, `rpg.gather`; docs/spec/idle-simulation.md). Everything
 * here is plain JSON data: configs, snapshots, events and simulator state are persisted with the timeline.
 */
import type { Outcome } from '@engine/expedition-kernel';
import type { AutomationRule } from '@rpg/rpg-schema';
import type { DeriveStatsInput } from '@rpg/rpg-stats';

/** Per expedition consumable stack (each participant brings this much; see `escrow`). */
export interface IdleConsumable {
  readonly item: string;
  readonly qty: number;
}

/**
 * Retreat policy (provisional, idle-simulation §2): after an encounter (and regen), the expedition retreats when some
 * hero's HP share is strictly below `belowHpBp` and — if `onlyWhenNoHealing` — that hero carries no healing consumable
 * (an item whose `use` heals or applies a HoT). `belowHpBp: 0` never retreats.
 */
export interface RetreatPolicy {
  readonly belowHpBp: number;
  readonly onlyWhenNoHealing: boolean;
}

/**
 * Expedition config (per expedition, shared by every participant). Duration, pace, area and activity are
 * **kernel-owned** (start request; kernel 0.3 passes `activityId` to `canStart`, `budget`, `simulate` and estimates),
 * not part of it — `rpg-idle@2.0.0` dropped the former `activity` field. Automation rules are not duplicated here: each
 * actor's frozen rules are in its snapshot.
 */
export interface RpgIdleConfig {
  /** Consumables each participant brings (escrowed `inventory → escrow` per actor). Unique items, `qty ≥ 1`. */
  readonly consumables: readonly IdleConsumable[];
  readonly retreat: RetreatPolicy;
}

/**
 * Actor snapshot (frozen at start): one hero. Party-ready (`actors[]`), phase 1 runs solo.
 * `actorId` is the character ID used for ledger deltas and as the hero's combat actor ID.
 */
export interface RpgActorSnapshot {
  readonly actorId: string;
  /** Level, attributes and equipment (`@rpg/rpg-stats` `deriveStats` input). */
  readonly build: DeriveStatsInput;
  /** Equipped skills (loadout). */
  readonly skills: readonly string[];
  /** Automation rules snapshot (≤ `MAX_AUTOMATION_RULES`). */
  readonly rules: readonly AutomationRule[];
  /** HP at start (default: max HP). */
  readonly hp?: number;
}

export interface EncounterMember {
  readonly enemy: string;
  readonly count: number;
}

/**
 * A plain-language death cause: `key` is a text key (`idle.death.*`), the other fields are its parameters.
 * - `idle.death.damage_taken` (`enemy`, `skill`, `amount`, `count` = hits): top damage sources of the fatal fight;
 * - `idle.death.biggest_hit` (`enemy`, `skill`, `amount`, `crit`);
 * - `idle.death.stunned` (`count` = stuns received);
 * - `idle.death.out_of_consumables` (healing consumables were brought and all used);
 * - `idle.death.no_consumables` (no healing consumable was brought);
 * - `idle.death.outnumbered` (`count` = enemies in the group);
 * - `idle.death.started_wounded` (`amount` = HP share in bp at the start of the fight).
 */
export interface DeathCause {
  readonly key: string;
  readonly enemy?: string;
  readonly skill?: string;
  readonly amount?: number;
  readonly count?: number;
  readonly crit?: boolean;
}

export type CombatResult = 'victory' | 'defeat' | 'timeout';

/** Events of one segment (= one encounter slot), in order. */
export type RpgIdleEvent =
  | {
      /** The rolled group and how the fight went. `combatHash` = `hashEvents` of the full combat log (audit/replay). */
      readonly type: 'encounter';
      readonly enemies: readonly EncounterMember[];
      readonly result: CombatResult;
      readonly ticks: number;
      readonly combatHash: string;
    }
  | {
      /** An enemy killed; `xp` is credited to every hero in `credited` (provisional party rule). */
      readonly type: 'kill';
      readonly enemy: string;
      readonly xp: number;
      readonly credited: readonly string[];
    }
  | { readonly type: 'consumable'; readonly actorId: string; readonly item: string; readonly qty: number }
  | {
      /** HP bookkeeping of one hero: before the fight, after it, regen applied, after regen. */
      readonly type: 'hp';
      readonly actorId: string;
      readonly maxHp: number;
      readonly before: number;
      readonly afterCombat: number;
      readonly regen: number;
      readonly hp: number;
    }
  | {
      /** Item drop into the bag. `source` = enemy ID (kill loot) or resource node ID (gathering). */
      readonly type: 'loot';
      readonly actorId: string;
      readonly source: string;
      readonly item: string;
      readonly qty: number;
    }
  | { readonly type: 'gold'; readonly actorId: string; readonly source: string; readonly qty: number }
  | { readonly type: 'death'; readonly actorId: string; readonly causes: readonly DeathCause[] }
  | { readonly type: 'retreat'; readonly actorId: string; readonly reason: 'low_hp' | 'combat_timeout' };

/** Per-hero simulator state after a segment (server-only; game state only — the RNG is per segment). */
export interface RpgHeroState {
  readonly actorId: string;
  readonly hp: number;
  /** Consumables left, in config order (zero stacks kept). */
  readonly consumables: readonly IdleConsumable[];
}

/**
 * `stateAfter` of every segment: what resuming needs (HP and consumables per hero). The bag is not part of it: it is
 * the sum of the prefix's deltas and does not influence later segments.
 */
export interface RpgIdleState {
  readonly heroes: readonly RpgHeroState[];
}

export interface HpSummary {
  readonly actorId: string;
  readonly maxHp: number;
  /** HP at the start of the first covered encounter (`null` if nothing is covered). */
  readonly start: number | null;
  /** Lowest HP right after a fight (before regen). */
  readonly lowest: number | null;
  /** HP after the last covered segment. */
  readonly end: number | null;
}

export interface DeathLog {
  readonly actorId: string;
  /** Segment index of the fatal encounter. */
  readonly encounter: number;
  readonly enemies: readonly EncounterMember[];
  readonly causes: readonly DeathCause[];
}

/** `summarize` result for segments `0..cutoff`. Records have sorted keys. */
export interface RpgIdleReport {
  readonly segments: number;
  /** Fights fought (segments with an encounter). */
  readonly encounters: number;
  readonly victories: number;
  /** Outcome, only when the report covers the whole timeline. */
  readonly outcome: Outcome | null;
  readonly kills: Readonly<Record<string, number>>;
  /** XP earned per hero (before any death penalty). */
  readonly xp: Readonly<Record<string, number>>;
  /** Gross bag (before the death loss): gold and items. */
  readonly gold: number;
  readonly loot: Readonly<Record<string, number>>;
  readonly consumablesUsed: Readonly<Record<string, number>>;
  readonly hp: readonly HpSummary[];
  readonly retreat: 'low_hp' | 'combat_timeout' | null;
  /** Only when the covered part contains the fatal encounter. */
  readonly deathLog: DeathLog | null;
}

/** XP/progression channel for the server's settlement hook (not ledger deltas, ADR-0007). */
export interface RpgActorProgress {
  readonly actorId: string;
  /** XP earned in segments `0..cutoff` (kills before a death included). */
  readonly xpEarned: number;
  readonly kills: Readonly<Record<string, number>>;
  readonly died: boolean;
}

export interface RpgProgress {
  readonly actors: readonly RpgActorProgress[];
  /** True when the covered part contains the fatal encounter. */
  readonly died: boolean;
  /**
   * Whether the server applies the death XP penalty (`applyDeathXpLoss(totalXp + xpEarned, curve)` per hero that
   * died). Same rule as the bag penalty in `settle`: the fatal encounter is covered and `reason === 'completed'`.
   */
  readonly applyDeathPenalty: boolean;
}

/**
 * Progress channel of the retained `rpg-idle@2.0.0` contract: it also carried the flat penalty rate the server fed to
 * the legacy `applyXpLoss` (10% of the next level's requirement). Frozen; see `settlement-v2.ts`.
 */
export interface RpgProgressV2 extends RpgProgress {
  readonly deathXpLossBp: number;
}
