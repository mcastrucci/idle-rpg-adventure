# ADR-0007: Idempotent economy ledger and character activity lock

- **Status:** Accepted
- **Date:** 2026-11-01

## Context
Top risk: item duplication, consumable double spend and races when alternating live/idle, using two devices, or
retrying commands after reconnects.

## Decision
- **Activity lock:** `characters.activity_state ∈ {none, live, expedition}` + `activity_id`, changed only through
  compare-and-set (`UPDATE … WHERE activity_state = $expected`).
- **Ledger:** every balance/ownership change writes an append-only `ledger_entries` row with a unique idempotency key
  `(source_type, source_id, seq)`. Materialized balances are updated in the same transaction. `CHECK (qty >= 0)`.
- Equipment = unique item rows (UUID); stackables = `(character, def, container)` quantity rows.
- Every character mutation takes `SELECT … FOR UPDATE` on the character row; multi-character operations lock in
  ascending ID order.
- Clients attach a `command_id` to every mutating command; the server deduplicates via `command_log`.
- Consumables are **escrowed** into the activity (expedition escrow / live run bag) and returned or consumed at
  settlement.
- While a live instance holds a character's lease, REST endpoints cannot mutate that character's inventory.

## Consequences
- A ledger invariant checker (sum of entries == balances) runs in tests and as a periodic job.
- Slightly more ceremony for every economy feature — intentional.
