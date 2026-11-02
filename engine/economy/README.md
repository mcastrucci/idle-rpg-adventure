# @engine/economy

Game-agnostic economy layer (ADR-0007, ADR-0017). Only this package's ledger may change balances/ownership. For now
it holds the **pure data types** that kernels and simulators exchange, plus tiny aggregation helpers; the ledger,
escrow and idempotency (database-backed) come later.

## Types

- `AssetRef` — `{ kind: 'stack', item }` (stackable item), `{ kind: 'currency', currency }`, `{ kind: 'unique', itemId }`
  (one existing item instance; `qty` ±1 per delta) and `{ kind: 'unique_mint', item }` (new unique instances of item
  definition `item`; grant only: `qty ≥ 1` = number of instances, no `from`). IDs are content/instance IDs, opaque to
  the engine. `ASSET_KINDS` lists the kinds; `uniqueMint(item)` / `isUniqueMint(asset)` are helpers.
- **Unique minting (ADR-0007: equipment = unique rows, stackables = quantity rows).** Simulators cannot know instance
  IDs, so they emit `unique_mint` deltas; when the ledger applies one, it creates `qty` instance rows of `item` in
  `to` (or the default container), each with an ID derived from the delta's idempotency key and the unit index, so a
  retried application never mints twice. From then on the instances are `unique` assets. A `unique_mint` can never
  be escrowed, consumed or moved (it has no instance yet); penalties reduce its `qty` like any grant.
- `Container` — where an asset sits. `ENGINE_CONTAINERS` = `equipped`, `inventory`, `storage`, `run_bag`, `escrow`,
  `corpse`; games may use their own strings.
- `LedgerDelta { actorId, asset, qty, from?, to? }` — a requested change as data. `qty` is a signed safe integer that
  leaves `from` and arrives in `to`: both = move, only `to` = grant, only `from` = consume, neither = change in the
  default container.

## Helpers

- `assetKey(asset)` — canonical key (`currency:gold`, `stack:herb`, `unique:i1`) for sorting/maps.
- `assertLedgerDelta(delta)` — throws on malformed deltas (empty actor, unknown asset kind, non-integer `qty`, a
  `unique` delta with `qty` ≠ ±1, a `unique_mint` with `qty < 1` or a `from`).
- `netDeltas(deltas)` — net per `(actorId, asset, container)`; `container: null` = default. Zeros dropped, sorted.
- `netHoldings(deltas)` — net per `(actorId, asset)` over all containers (moves cancel out). Used by estimates.
  `unique_mint` assets aggregate as counts of minted instances per item (`unique_mint:<item>`), separate from a
  `stack` of the same ID.

Sums are overflow-checked (safe integers only).
