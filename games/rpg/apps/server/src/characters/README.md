# RPG characters and generic actor activity (#27)

The engine owns `actors` identity, account/game ownership, activity state/identity, and the optimistic `version`.
RPG state belongs to `rpg_characters`, whose primary key is `actor_id`. Its account/game columns are an ownership
projection used by `UNIQUE(account_id, game_id)`: a composite foreign key to the actor's ID/account/game proves
those values match the authoritative actor. Requests never choose an account/game ID. The POC allows one RPG
character per account; generic actors remain usable by games with other actor models.

## Transaction contract

`createCharacterService(tx, content)` and the engine actor helpers receive the caller's existing Drizzle
transaction. This lets a future live/expedition/ledger service create its domain rows, transition activity and mutate
assets atomically. A failure after an activity or configuration update rolls back its version as well. Services throw
on domain failures: callers must not swallow an error and commit a failed creation's transaction.

`transitionActivity(tx, actorId, expected, next)` compares **both** the previous state and activity UUID, incrementing
version only on success. Allowed edges are `none → live/expedition` and `live/expedition → none`; there is no direct
active-to-active replacement. An old settlement cannot clear a newer activity with another ID. The database checks
`activity_state = 'none'` iff `activity_id IS NULL`, restricts the state vocabulary, and rejects negative versions.
CAS returns `null` on a conflict; it performs no implicit ownership check because settlement/party coordinators use
it internally. Public operation adapters must first prove ownership with `requireOwnedActor` in that transaction.

`lockActors(tx, ids)` de-duplicates and locks actors in ascending immutable UUID order. Multi-actor operations must
supply the complete actor set before taking any actor lock; acquiring one lock first and then expanding the set can
still introduce a deadlock. `requireSanctuaryMutation` both checks ownership and locks the actor row, then requires
`none`. Keep the transaction open through the inventory/loadout/rule mutation. It is exported as the inventory
integration guard; this change does not implement inventory.

Character configuration uses that same row lock, so an activity start waits for an earlier configuration mutation,
and a configuration mutation behind an activity start observes the busy state. Foreign-account IDs return 404.

## Provisional starter policy

This is a narrow starting configuration, not a finalized build/unlock/level system. The level-1 Bulwark allocation
from `docs/design/region-1.md` is copied explicitly: STR 9, AGI 4, INT 2, VIT 10, SPI 5 (30 allocated points), with
zero unspent points, XP 0, and level 1. Starter gear/inventory is not created. The only provisioned active skills are
`shield_bash`, `guard`, `cleave`, and `mend`; each must exist in the compiled content. These four are also the temporary
unlocked set. A content addition or a client body cannot unlock enemy/future/alternate-build skills. At most four
active slots are accepted, without duplicates. `basic_attack` is always available outside the active slots.

`CreateCharacterSchema` accepts only a name. Configuration accepts name, additive `allocate` deltas, loadout, and
automation rules. It never accepts level, XP, account ID, game ID, actor ID, total attributes or unspent-point grants.
Allocation can spend only persisted earned unspent points; no public grant, respec or progression endpoint exists.
Actual closed RPG schemas validate IDs/rules. Automation action and `skillReady` references must name an equipped
skill or basic attack, and consumable references must identify real consumable item definitions. This validates
references; it does not claim inventory ownership or award consumables. Target selectors must suit the skill target.

Rules and the four-slot limit remain provisional alongside the owner design/open decision #13. Starter automation
uses guard, mend, cleave, bash and basic attack; it has no potion rule because inventory is absent.

## HTTP and integration ownership

The API-role module exposes `GET /characters`, `POST /characters`, `GET /characters/:actorId`, and
`PATCH /characters/:actorId/configuration`. It calls the engine's real `requireAccount(request, context)` and uses
its authenticated `accountId`. Mutating handlers use the shared command envelope and transaction runner (#29).
The composition root normalizes HTTP route targets and WS payloads into one fingerprint, rechecks ownership on
replays, and invokes the transaction-scoped character service only for new commands. Failed mutations roll back
the command reservation. Credential handshakes are separate and never enter the command log.

The engine migration owns actors; the game migration owns RPG characters in a separate `rpg_migrations` journal.
Checked-in SQL is generated from these schemas; no test-only replacement schema is used here. Validation
unit tests compile real content. Real PostgreSQL integration tests cover competing live/idle CAS, stale release,
state/null database checks, composite ownership, party lock order, busy edits and rollback with caller transactions.
They require `TEST_DATABASE_URL` and are skipped locally when it is absent; CI must provide it. No mocked-auth test
is claimed as authenticated HTTP acceptance; the composition's real-auth integration tests own that acceptance.
