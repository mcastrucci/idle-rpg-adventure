# @engine/economy

Game-agnostic economy layer (ADR-0007, ADR-0017). Only this package's ledger may change balances/ownership. For now
it holds the **pure data types** that kernels and simulators exchange, plus tiny aggregation helpers; the ledger,
escrow and idempotency (database-backed) come later.

## Types

- `AssetRef` — `{ kind: 'stack', item }` (stackable item), `{ kind: 'currency', currency }`, `{ kind: 'unique', itemId }`
  (one item instance). IDs are content/instance IDs, opaque to the engine.
- `Container` — where an asset sits. `ENGINE_CONTAINERS` = `equipped`, `inventory`, `storage`, `run_bag`, `escrow`,
  `corpse`; games may use their own strings.
- `LedgerDelta { actorId, asset, qty, from?, to? }` — a requested change as data. `qty` is a signed safe integer that
  leaves `from` and arrives in `to`: both = move, only `to` = grant, only `from` = consume, neither = change in the
  default container.

## Helpers

- `assetKey(asset)` — canonical key (`currency:gold`, `stack:herb`, `unique:i1`) for sorting/maps.
- `assertLedgerDelta(delta)` — throws on malformed deltas (empty actor, unknown asset kind, non-integer `qty`).
- `netDeltas(deltas)` — net per `(actorId, asset, container)`; `container: null` = default. Zeros dropped, sorted.
- `netHoldings(deltas)` — net per `(actorId, asset)` over all containers (moves cancel out). Used by estimates.

Sums are overflow-checked (safe integers only).
