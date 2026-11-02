/**
 * Pure economy data types shared by kernels and games (ADR-0007, ADR-0017). No persistence here: these describe
 * *what* should change; only the ledger (added later in this package) applies changes to balances/ownership.
 */

/**
 * Reference to something an actor can own.
 * - `stack`: a fungible, stackable item identified by its content ID.
 * - `currency`: a fungible balance identified by its content ID.
 * - `unique`: one specific, existing item instance identified by its instance ID (`qty` is always ±1 per delta).
 * - `unique_mint`: **new** unique instances of the item definition `item` (content ID), e.g. an equipment drop
 *   (ADR-0007: equipment = unique item rows). Only valid as a grant: `qty ≥ 1` instances, no `from` (see
 *   {@link LedgerDelta}). The ledger creates one instance row per unit with an ID derived from the delta's
 *   idempotency key, so a retried settlement never mints twice. Net helpers count minted instances per item.
 */
export type AssetRef =
  | { readonly kind: 'stack'; readonly item: string }
  | { readonly kind: 'currency'; readonly currency: string }
  | { readonly kind: 'unique'; readonly itemId: string }
  | { readonly kind: 'unique_mint'; readonly item: string };

/** Asset kinds, in {@link AssetRef} order. */
export const ASSET_KINDS = ['stack', 'currency', 'unique', 'unique_mint'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** Container names the engine itself knows about. Games may add their own container strings. */
export const ENGINE_CONTAINERS = ['equipped', 'inventory', 'storage', 'run_bag', 'escrow', 'corpse'] as const;

/** One of {@link ENGINE_CONTAINERS}. */
export type EngineContainer = (typeof ENGINE_CONTAINERS)[number];

/**
 * Where an asset sits for an actor. Engine-standard names autocomplete; any other non-empty string is a game-defined
 * container (`string & {}` keeps the literal suggestions without narrowing the type).
 */
export type Container = EngineContainer | (string & {});

/**
 * A requested ledger change, as plain data (simulators emit these; the ledger applies them idempotently).
 *
 * Semantics: `qty` (a signed safe integer) leaves `from` and arrives in `to`.
 * - `from` and `to`: move between two containers of the same actor (net holdings unchanged).
 * - only `to`: grant/mint `qty` into `to`.
 * - only `from`: consume/burn `qty` from `from`.
 * - neither: change of the actor's holdings in the ledger's default container for that asset.
 *
 * Per asset kind (enforced by `assertLedgerDelta`): `unique` deltas move/grant/consume exactly one instance
 * (`qty` = ±1); `unique_mint` deltas are grants only (`qty ≥ 1`, no `from`) — minted instances get their own IDs at
 * application time and are referenced as `unique` afterwards.
 */
export interface LedgerDelta {
  readonly actorId: string;
  readonly asset: AssetRef;
  /** Signed safe integer. */
  readonly qty: number;
  readonly from?: Container;
  readonly to?: Container;
}
