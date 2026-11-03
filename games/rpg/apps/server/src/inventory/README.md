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
amounts; merchant stock is infinite for the POC. Offer eligibility is rechecked inside the purchase transaction
from persisted actor progress and the RPG world's completion evaluator. `sellOffers`, when present, lists eligible
stackable materials at their unchanged authored `Item.value`; it does not define separate prices or a conversion
formula.

## HTTP contract

- `GET /characters/:actorId/inventory` requires the owning account and returns one repeatable-read snapshot of `{ actorId, holdings, actorVersion, activityState, level, attributes, completedAreas, catalog }`. The catalog includes only client-safe item fields (`id`, `kind`, `nameKey`, equipment slot/requirements/stats, and `stackable`), plus the active `contentHash`; it never returns full authored item definitions. `completedAreas` contains only persisted server progress and supports merchant gate display. Mutations remain authoritative and recheck the gates.
- `GET /merchant` returns `{ merchants: [{ id, offers: [{ id, item, buyPrice, stock, requiresCompletedArea? }] }], sellOffers?: [{ item, unitPrice: { currency: 'gold', amount } }] }`.
- `POST /characters/:actorId/inventory/commands` takes the shared `{ command_id, operation, payload }` envelope.

Inventory payloads are strict objects: `inventory.equip` takes `{ actorId, itemId, slot }`; `inventory.unequip` takes
`{ actorId, itemId }`; `inventory.move` takes either `{ actorId, itemId, from, to }` for a unique item or
`{ actorId, item, quantity, from, to }` for a stack; `inventory.buy` takes `{ actorId, offerId, quantity }`. Move
containers are only `inventory` and `storage`, and must differ. `inventory.sellMaterial` takes
`{ actorId, item, quantity }`, with quantity from 1 to 10,000. The server accepts only an authored stackable
material with positive integer `value`, and sells only the requested units in the actor's inventory container.
Materials in storage, equipment, consumables, quest items, zero value items, and other containers cannot be sold.
The server computes proceeds from authored content and atomically debits the material stack and credits inventory
gold. The sale requires Sanctuary and the proceeds and resulting gold balance must fit the ledger's signed integer
range. The same operations are accepted by the existing WebSocket shared command dispatcher. Successful mutations
return `{ actorId, version }`.

Every replay still parses the canonical payload and checks current actor ownership before the shared command runner
returns its stored response. Business checks (including the current offer price, stock definition, and conquest gate)
run only for a new command, so content hash changes do not rewrite an already-confirmed purchase. The web inventory
experience tracked by issue #35 remains a separate deliverable.
