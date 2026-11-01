/**
 * Public data types of the combat engine (docs/spec/combat-engine.md §1, §5, §9). Everything in {@link CombatState} and
 * {@link CombatEvent} is plain JSON data (no classes, no `undefined` values, no Maps), so states can be checkpointed with
 * `JSON.stringify` and resumed with `JSON.parse`.
 */
import type { RngStreamsState } from '@engine/sim-core';
import type {
  AiRule,
  AutomationRule,
  BossPhase,
  ConsumableItem,
  DamageSchool,
  DurationUnit,
  EffectType,
  Enemy,
  EnemyStats,
  Item,
  Skill,
  Stat,
  TargetSelector,
} from '@rpg/rpg-schema';
import type { DeriveStatsInput, StatFormulaTable } from '@rpg/rpg-stats';

/** Stable actor identifier inside one combat (e.g. `hero:1`, `enemy:boar#2`). Unique per combat. */
export type ActorId = string;
export type Side = 'hero' | 'enemy';

// ---------------------------------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------------------------------

/** Content lookup passed to {@link createCombat}. Only referenced entries are copied into the state. */
export interface CombatContent {
  readonly skills: Readonly<Record<string, Skill>>;
  readonly items: Readonly<Record<string, Item>>;
  readonly enemies: Readonly<Record<string, Enemy>>;
}

export interface ConsumableStack {
  readonly item: string;
  readonly qty: number;
}

export interface HeroSetup {
  readonly id: ActorId;
  /** Level, attributes and equipment; derived stats come from `@rpg/rpg-stats` `deriveStats`. */
  readonly build: DeriveStatsInput;
  /** Equipped skills (loadout). */
  readonly skills: readonly string[];
  /** Ordered automation rules (≤ `MAX_AUTOMATION_RULES`). */
  readonly rules: readonly AutomationRule[];
  /** Consumables available in this combat (escrowed for idle). */
  readonly consumables?: readonly ConsumableStack[];
  /** Automation on (default `true`). Live players may switch it off with a `setAuto` input. */
  readonly auto?: boolean;
  /** Starting HP (default: max HP). Lets expeditions carry HP between encounters. */
  readonly hp?: number;
}

export interface EnemySetup {
  readonly id: ActorId;
  readonly enemy: string;
  /** Starting HP (default: max HP). */
  readonly hp?: number;
}

/** Provisional combat constants (open decision #2). Part of the state so a checkpoint replays with its own numbers. */
export interface CombatTuning {
  /** Mitigation per armor/resist point, bp: `mitigated = raw × 10000 / (10000 + armor × armorKBp)`. */
  readonly armorKBp: number;
  /** Damage multiplier on a critical hit, bp. */
  readonly critMultBp: number;
}

export interface CombatSetup {
  readonly heroes: readonly HeroSetup[];
  readonly enemies: readonly EnemySetup[];
  readonly content: CombatContent;
  /** Stat formula table for heroes and haste → interval (default `DEFAULT_STAT_FORMULAS`). */
  readonly formulas?: StatFormulaTable;
  readonly tuning?: Partial<CombatTuning>;
}

// ---------------------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------------------

export type CombatOutcome = 'victory' | 'defeat';

/** Effective combat stats of an actor (base + active `stat_mod`s). */
export interface CombatStats {
  readonly maxHp: number;
  readonly powerBySchool: Readonly<Record<DamageSchool, number>>;
  readonly armor: number;
  readonly resist: number;
  readonly critBp: number;
  readonly haste: number;
  readonly healPower: number;
  readonly actionIntervalTicks: number;
}

/** A manual action waiting for the actor's next ready action. `target` is an actor ID or a target selector. */
export type QueuedAction =
  | { readonly kind: 'useSkill'; readonly skill: string; readonly target: string | null }
  | { readonly kind: 'useConsumable'; readonly item: string };

/** A telegraphed action between `TelegraphStarted` and its resolution. */
export interface Windup {
  readonly skill: string;
  readonly targetIds: readonly ActorId[];
  /** Selector used to retarget if a single target died during the windup. */
  readonly selector: TargetSelector | null;
  readonly startedTick: number;
  readonly resolveAtTick: number;
  readonly source: ActionSource;
}

export type ActionSource = 'manual' | 'auto' | 'ai';

export interface BossState {
  readonly phases: readonly BossPhase[];
  phaseIndex: number;
  rotationIndex: number;
}

export interface ActorState {
  readonly id: ActorId;
  readonly side: Side;
  /** Enemy content ID for enemies, `null` for heroes. */
  readonly enemy: string | null;
  hp: number;
  alive: boolean;
  /** Effective stats (recomputed whenever a `stat_mod` on this actor changes). */
  stats: CombatStats;
  /** Hero build (stats are re-derived with active modifiers); `null` for enemies. */
  readonly build: DeriveStatsInput | null;
  /** Enemy base stats; `null` for heroes. */
  readonly baseStats: EnemyStats | null;
  readonly skills: readonly string[];
  /** Skill ID → first tick at which it is ready again. Missing = ready. */
  cooldowns: Record<string, number>;
  /** Hero automation rules (empty for enemies). */
  readonly rules: readonly AutomationRule[];
  /** Enemy AI priority list (empty for heroes). */
  readonly ai: readonly AiRule[];
  /** Boss phase table; `null` for heroes and normal enemies. */
  readonly boss: BossState | null;
  auto: boolean;
  consumables: { item: string; qty: number }[];
  queued: QueuedAction | null;
  windup: Windup | null;
  /** First tick at which the actor is ready to act. */
  nextActionTick: number;
  /** Resolved actions (skills and consumables, not skipped/interrupted ones). */
  actionsTaken: number;
}

interface EffectBase {
  readonly uid: number;
  readonly holderId: ActorId;
  readonly sourceId: ActorId;
  /** Skill or item that created the effect. */
  readonly origin: string;
  readonly appliedTick: number;
  readonly unit: DurationUnit;
  remaining: number;
}

export type ActiveEffect = EffectBase &
  (
    | { readonly type: 'shield'; amount: number }
    | { readonly type: 'dot'; readonly perTick: number; readonly school: DamageSchool; readonly periodTicks: number; nextAt: number }
    | { readonly type: 'hot'; readonly perTick: number; readonly periodTicks: number; nextAt: number }
    | { readonly type: 'stat_mod'; readonly stat: Stat; readonly deltaBp: number; readonly flat: number }
    | { readonly type: 'taunt' }
    | { readonly type: 'stun' }
  );

export type DurableEffectType = ActiveEffect['type'];

/** Snapshot of the content the combat references (keeps checkpoints self-contained). */
export interface ContentSnapshot {
  readonly skills: Readonly<Record<string, Skill>>;
  readonly items: Readonly<Record<string, ConsumableItem>>;
}

export interface CombatState {
  readonly engineVersion: string;
  /** Last processed tick (0 = not started). */
  tick: number;
  rng: RngStreamsState;
  readonly formulas: StatFormulaTable;
  readonly tuning: CombatTuning;
  /** Sorted by actor ID (ascending). */
  readonly actors: ActorState[];
  /** Active effects in application order (ascending `uid`). */
  effects: ActiveEffect[];
  nextUid: number;
  /** Number of events emitted so far (= `seq` of the next event). */
  eventSeq: number;
  outcome: CombatOutcome | null;
  readonly content: ContentSnapshot;
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Manual input. Untrusted: the engine validates it and emits `InputRejected` instead of throwing.
 * `target` (optional) is an actor ID or a target selector (`lowestHpEnemy`, …).
 */
export type CombatInput =
  | { readonly actorId: ActorId; readonly kind: 'useSkill'; readonly skill: string; readonly target?: string }
  | { readonly actorId: ActorId; readonly kind: 'useConsumable'; readonly item: string }
  | { readonly actorId: ActorId; readonly kind: 'setAuto'; readonly auto: boolean };

export type InputRejectReason =
  | 'malformed'
  | 'unknownActor'
  | 'notControllable'
  | 'actorDead'
  | 'unknownKind'
  | 'skillNotEquipped'
  | 'noConsumable'
  | 'invalidTarget'
  | 'onCooldown'
  | 'combatOver';

// ---------------------------------------------------------------------------------------------------------------------
// Events (§9)
// ---------------------------------------------------------------------------------------------------------------------

export type ActionRef = { readonly kind: 'skill'; readonly skill: string } | { readonly kind: 'consumable'; readonly item: string };

export type EffectExpireReason = 'duration' | 'depleted' | 'cleansed' | 'replaced' | 'sourceDied';

interface EventBase {
  /** Position in the combat's event stream (0-based, strictly increasing). */
  readonly seq: number;
  readonly tick: number;
}

export type CombatEvent = EventBase &
  (
    | {
        readonly type: 'CombatStarted';
        readonly engineVersion: string;
        readonly heroes: readonly ActorId[];
        readonly enemies: readonly ActorId[];
      }
    | {
        readonly type: 'ActionStarted';
        readonly actorId: ActorId;
        readonly action: ActionRef;
        readonly targetIds: readonly ActorId[];
        readonly source: ActionSource;
      }
    | {
        readonly type: 'TelegraphStarted';
        readonly actorId: ActorId;
        readonly skill: string;
        readonly targetIds: readonly ActorId[];
        readonly resolveAtTick: number;
      }
    | { readonly type: 'ActionInterrupted'; readonly actorId: ActorId; readonly skill: string; readonly reason: 'stunned' | 'died' }
    | { readonly type: 'ActionSkipped'; readonly actorId: ActorId; readonly reason: 'stunned' }
    | {
        readonly type: 'DamageDealt';
        readonly sourceId: ActorId;
        readonly targetId: ActorId;
        readonly origin: string;
        readonly school: DamageSchool;
        /** HP lost (after shields). */
        readonly amount: number;
        /** Damage absorbed by shields. */
        readonly absorbed: number;
        readonly crit: boolean;
        readonly periodic: boolean;
        readonly hpAfter: number;
      }
    | {
        readonly type: 'Healed';
        readonly sourceId: ActorId;
        readonly targetId: ActorId;
        readonly origin: string;
        /** HP actually restored (overheal excluded). */
        readonly amount: number;
        readonly periodic: boolean;
        readonly hpAfter: number;
      }
    | {
        readonly type: 'EffectApplied';
        readonly effectUid: number;
        readonly effect: DurableEffectType;
        readonly sourceId: ActorId;
        readonly targetId: ActorId;
        readonly origin: string;
        readonly duration: { readonly value: number; readonly unit: DurationUnit };
      }
    | {
        readonly type: 'EffectExpired';
        readonly effectUid: number;
        readonly effect: DurableEffectType;
        readonly targetId: ActorId;
        readonly reason: EffectExpireReason;
      }
    | { readonly type: 'Cleansed'; readonly sourceId: ActorId; readonly targetId: ActorId; readonly removed: number }
    | { readonly type: 'ConsumableUsed'; readonly actorId: ActorId; readonly item: string; readonly remaining: number }
    | { readonly type: 'ActorDied'; readonly actorId: ActorId; readonly killerId: ActorId }
    | { readonly type: 'PhaseChanged'; readonly actorId: ActorId; readonly phase: number; readonly fromHpBp: number }
    | { readonly type: 'AutoToggled'; readonly actorId: ActorId; readonly auto: boolean }
    | { readonly type: 'InputRejected'; readonly actorId: string; readonly kind: string; readonly reason: InputRejectReason }
    | { readonly type: 'CombatEnded'; readonly outcome: CombatOutcome }
  );

export type CombatEventType = CombatEvent['type'];

/** Distributive omit, so `Omit` keeps the union discriminated. */
export type EventPayload = CombatEvent extends infer E ? (E extends CombatEvent ? Omit<E, 'seq' | 'tick'> : never) : never;

/** Re-exported for convenience. */
export type { EffectType };
