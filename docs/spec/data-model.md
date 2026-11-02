# Spec: Data Model

> Status: **Draft v0.1**. Field lists are indicative; final schemas are defined in migrations (M2) and
> `packages/content-schema` (M1). Provisional values are marked *(provisional)*.

> **Engine split (ADR-0017):** generic tables (accounts, actors with `activity_state`, ledger, containers, area progress,
> expeditions, live instances, command log) belong to engine packages; `characters` is the RPG extension of an actor
> (`characters.actor_id`). `region_progress` below is the RPG view of engine `area_progress`.

Two kinds of data:

- **Content** — immutable at runtime, authored in `content/`, compiled into a bundle with a `contentHash`
  (see [content-format.md](content-format.md)).
- **State** — per-player, mutable, persisted in PostgreSQL.

## 1. Content entities (summary)

| Entity | Key fields |
|---|---|
| `Region` | `id`, `name`, `difficulty`, `recommendedLevel`, `locations[]`, `startLocation`, `mandatoryBosses[]`, `conquest.requiredDiscoveries` (frozen), `idle.activities[]` |
| `Location` | `id`, `region`, `kind` (`ordinary`/`secret`/`boss_room`/`safe`), `conquestPool` (bool), `scene` (Tiled ref), `exits[]`, `hotspots[]`, `encounters` (table ref), `resources[]` |
| `EnemyDef` | `id`, `level`, `stats`, `skills[]`, `ai` (behaviour ref), `xp`, `lootTable`, `tags[]` |
| `BossDef` | `EnemyDef` + `phases[]`, `telegraphs[]` |
| `SkillDef` | `id`, `cost`, `cooldownTicks`, `windupTicks`, `targeting`, `effects[]` |
| `EffectDef` | closed set: `damage`, `heal`, `shield`, `dot`, `hot`, `stat_mod`, `taunt`, `stun`, `cleanse`… each with `duration: { value, unit: ticks|actions|attacks }` |
| `ItemDef` | `id`, `kind` (`equipment`/`consumable`/`material`/`quest`), `slot`, `stats`, `stackable`, `maxStack`, `value` |
| `LootTable` | weighted entries, guaranteed drops, gold range |
| `EncounterTable` | weighted enemy groups per location/activity |
| `IdleActivity` | `id` (`hunt`, `gather`), `encountersPerHour`, `encounterTable`, `resourceYields` |

## 2. State entities

### accounts
`id` UUID, `created_at`. Generic engine identity, preserved through guest-to-email upgrades.
Credentials are separate: `guest_credentials` (purpose-hashed device token, disabled on upgrade),
`email_credentials` (unique normalized email and salted password hash), and `auth_sessions` (hashed opaque token,
expiry/revocation). `live_sessions` holds a renewable fenced lease, unique per account. See
[authentication](../../engine/server-kit/src/auth/README.md) for the HTTP/WS and rotation contract.

### actors (engine)
`actor_id` UUID, `account_id` FK, `game_id`, `activity_state`, `activity_id`, `version`.
This is the sole physical owner of activity state and mutation version. Database checks enforce the state/null
invariant; transaction-scoped helpers lock actors in canonical UUID order and compare both prior state and activity ID.

### rpg_characters (game-owned character extension)
| Field | Notes |
|---|---|
| `actor_id` | PK/FK to the generic actor UUID; this is the API character identity |
| `account_id`, `game_id` | Ownership projection constrained by a composite FK to actors; unique per account/game |
| `name`, `level`, `xp` | XP is cumulative within level *(provisional)* |
| `attributes`, `unspent_points` | Validated allocated attributes and persisted earned point budget |
| `skill_loadout` | JSONB: equipped skill IDs (≤4 active slots *(provisional)*) |
| `automation_rules` | JSONB: ordered rule list (see [combat-engine.md](combat-engine.md#automation-rules)) |

Activity and version are joined from actors in API projections; they are never duplicated in RPG storage. A name-only
creation request provisions the explicitly provisional level-1 Bulwark kit. Configuration can spend persisted points,
but cannot grant levels, XP, attributes or unknown skills. See [character contracts](../../games/rpg/apps/server/src/characters/README.md).

### item_instances (equipment, unique items)
`id` UUID, `character_id`, `def_id`, `container`, `slot?`, `rolls` JSONB, `created_by_source` (ledger key).

### stack_balances (consumables, materials)
`character_id`, `def_id`, `container`, `qty CHECK (qty >= 0)`; PK `(character_id, def_id, container)`.

### currency_balances
`character_id`, `currency` (`gold`), `amount CHECK (amount >= 0)`.

### Containers
| Container | Meaning | Lost on death? |
|---|---|---|
| `equipped` | worn gear | No (POC, *provisional*) |
| `inventory` | carried bag | Partially *(provisional, see rewards spec)* |
| `storage` | Sanctuary vault | Never |
| `run_bag` | loot gained during the current live run ("unsecured") | Yes → goes to corpse |
| `escrow` | consumables reserved by an active expedition | Consumed or returned at settlement |
| `corpse` | contents of a corpse awaiting recovery | Expire with corpse |

### ledger_entries (append-only)
`id`, `character_id`, `asset_kind` (`item`/`stack`/`currency`), `asset_ref`, `delta`, `from_container?`,
`to_container?`, `source_type` (`expedition_settlement`, `live_loot`, `purchase`, `death_penalty`, `debug_grant`…),
`source_id`, `seq`, `created_at`. **Unique `(source_type, source_id, seq)`.**

### region_progress
`character_id`, `region_id`, `discovered_location_ids` (text[]), `defeated_boss_ids` (text[]), `conquered_at?`,
`conquest_baseline_hash`. PK `(character_id, region_id)`.

### live_instances
`id`, `region_id`, `participants` (character IDs), `status` (`active`/`closed`/`crashed`), `node_id`,
`lease_expires_at`, `checkpoint` JSONB, `checkpoint_seq`, `engine_version`, `content_hash`, `created_at`.

### corpses
`id`, `character_id`, `region_id`, `location_id`, `created_at`, `expires_at`, `status` (`active`/`recovered`/`expired`).
Contents live in the `corpse` container keyed by corpse ID.

### expeditions
| Field | Notes |
|---|---|
| `id`, `region_id`, `activity_id`, `duration_min` | |
| `status` | `draft` → `pending_invites` → `running` → `settled` \| `cancelled` |
| `outcome` | `completed` \| `retreated` \| `died` \| `cancelled` |
| `seed`, `revision` | revision increments on party re-simulation |
| `engine_version`, `content_hash` | |
| `config` JSONB, `config_version` | config changes invalidate acceptances |
| `snapshot` JSONB | frozen participant stats/loadouts/rules |
| `timeline` JSONB (compressed) | encounter summaries with wall-clock offsets; full event log optional |
| `starts_at`, `ends_at`, `settled_at?`, `cancelled_at?` | |

### expedition_participants
`expedition_id`, `character_id`, `role` (`leader`/`member`), `status` (`invited`/`accepted`/`declined`/`active`/`left`),
`accepted_config_version?`, `left_at?`, `share_policy`.

### party_invites (phase 2)
`id`, `expedition_id` or `live_party_id`, `inviter_id`, `invitee_id`, `config_version`, `status`, `expires_at`.

### command_log
`account_id`, `command_id`, `operation`, `fingerprint`, `created_at`, `expires_at`, `response_status`, `response_body`,
`tombstoned_at`. PK `(account_id, command_id)`. Public JSON responses are retained for 24 h by default; expiry removes
the response but retains the key/fingerprint tombstone, so a late retry cannot repeat a committed mutation. The
shared HTTP/WS runner authenticates/authorizes before replay and commits command plus game changes atomically.
See [command contract](../../engine/server-kit/src/commands/README.md); auth handshakes never store credential responses here.

## 3. Invariants

1. `activity_state = 'none'` ⇔ `activity_id IS NULL`.
2. A character appears in at most one `running` expedition or `active` live instance, matching its `activity_id`.
3. For every asset: `Σ ledger deltas == materialized balance`.
4. No balance is ever negative.
5. Every ledger entry has a unique `(source_type, source_id, seq)`.
6. `region_progress.conquered_at` is never cleared.
7. Items in `escrow` belong to exactly one non-settled expedition.
