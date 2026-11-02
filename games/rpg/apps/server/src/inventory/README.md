# RPG inventory and merchant

The inventory projection is built from the ledger's current materialized balances and unique item instances. Stack
holdings are aggregated by actor, item, and container; `maxStack` describes a presentation stack size, not total
inventory capacity. There are no physical slot limits. One move command is bounded to 10,000 stack units.

The inventory endpoint returns only holdings for the authenticated account's actor. Equipment, unequip, storage moves,
and purchases require Sanctuary (`activityState: none`) and hold the actor row lock through their transaction. Inventory
commands use the shared command runner and a ledger source keyed by account ID plus command UUID. Replacing an equipped
item returns the previous instance to inventory in the same ledger batch that equips the new instance; instance UUIDs
and rolls are preserved.

The merchant catalog is a public projection of authored merchant offers. Buy prices are explicit provisional gold
amounts, independent of item sell `value`; merchant stock is infinite for the POC. Offer eligibility is rechecked
inside the purchase transaction from persisted actor progress and the RPG world's completion evaluator.

## HTTP contract

- `GET /characters/:actorId/inventory` requires the owning account and returns `{ actorId, holdings }`.
- `GET /merchant` returns `{ merchants: [{ id, offers: [{ id, item, buyPrice, stock, requiresCompletedArea? }] }] }`.
- `POST /characters/:actorId/inventory/commands` takes the shared `{ command_id, operation, payload }` envelope.

Inventory payloads are strict objects: `inventory.equip` takes `{ actorId, itemId, slot }`; `inventory.unequip` takes
`{ actorId, itemId }`; `inventory.move` takes either `{ actorId, itemId, from, to }` for a unique item or
`{ actorId, item, quantity, from, to }` for a stack; `inventory.buy` takes `{ actorId, offerId, quantity }`. Move
containers are only `inventory` and `storage`, and must differ. The same operations are accepted by the existing
WebSocket shared command dispatcher. Successful mutations return `{ actorId, version }`.

Every replay still parses the canonical payload and checks current actor ownership before the shared command runner
returns its stored response. Business checks (including the current offer price, stock definition, and conquest gate)
run only for a new command, so content hash changes do not rewrite an already-confirmed purchase. The web inventory
experience tracked by issue #35 remains a separate deliverable.
