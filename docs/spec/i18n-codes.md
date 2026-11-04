# Server i18n codes (issue #137)

The server never sends localized prose as the only representation of a player-visible message. It sends a stable
**code** (plus **params** where the sentence needs values) and the client renders `ui.code.<code>` from its catalog
(es/en), interpolating `{param}` placeholders. Rules:

- Codes are stable identifiers; never renamed (same policy as content IDs, ADR-0008).
- Params are scalars (`string | number`). Item/enemy/area params are content IDs; the client resolves display names
  through the content `nameKey` catalog.
- Protocol changes are **additive**: legacy English text fields remain until clients render from codes. When both exist,
  the code array is parallel to the text array (same length, same order).
- Engine codes (`engine/*`) are generic (no game concepts). Game codes live in `games/rpg`.
- Unknown codes must degrade gracefully (show the English fallback if present, else the raw code).

Catalog key = `ui.code.` + code. Reference sentences below are the English source of truth.

## 1. Expedition result report (`ExpeditionResultReportDto`, new fields)

Wire shape: `{ code: string; params?: Record<string, string | number> }` (`ExpeditionReportCodeDto`).

### `report.eventCodes[]` (parallel to `report.events[]`)

| Code | Params | English reference |
| --- | --- | --- |
| `idle.event.kill` | `enemy` (enemy content ID) | Defeated {enemy}. |
| `idle.event.consumable` | `item` (item ID), `qty` (int) | Used {qty} {item}. |
| `idle.event.loot` | `item` (item ID), `qty` (int) | Found {qty} {item}. |
| `idle.event.gold` | `qty` (int) | Found {qty} gold. |
| `idle.event.death` | none | A character died in combat. |
| `idle.event.retreat` | none | The party retreated. |

### `report.death.suggestionCodes[]` (parallel to `report.death.suggestions[]`)

| Code | Params | English reference | Emitted when cause key present |
| --- | --- | --- | --- |
| `idle.suggestion.bring_healing` | none | Consider bringing healing consumables. | `idle.death.no_consumables` |
| `idle.suggestion.bring_more_healing` | none | Consider bringing more healing consumables. | `idle.death.out_of_consumables` |
| `idle.suggestion.review_risk_retreat` | none | Review the expedition risk and retreat settings. | `idle.death.outnumbered` |
| `idle.suggestion.restore_health` | none | Restore health before starting another expedition. | `idle.death.started_wounded` |
| `idle.suggestion.review_stuns` | none | Review options for handling enemy stuns. | `idle.death.stunned` |
| `idle.suggestion.review_defenses` | none | Review defenses against the recorded enemy attacks. | `idle.death.damage_taken` or `idle.death.biggest_hit` |

### `report.death.causes[].key` (already a code; pre-existing)

Cause entries carry optional fields `enemy`, `skill`, `amount`, `count`, `crit` that act as params
(`{enemy}`, `{skill}`, `{amount}`, `{count}`, `{crit}`).

| Code | Params | English reference |
| --- | --- | --- |
| `idle.death.no_consumables` | none | You brought no healing consumables. |
| `idle.death.out_of_consumables` | `count` | You ran out of healing consumables. |
| `idle.death.outnumbered` | `count` | You were outnumbered by {count} enemies. |
| `idle.death.started_wounded` | none | You started the expedition wounded. |
| `idle.death.stunned` | `enemy`, `skill` | You were stunned by {enemy} ({skill}). |
| `idle.death.damage_taken` | `enemy`, `skill`, `amount` | {enemy} dealt {amount} damage with {skill}. |
| `idle.death.biggest_hit` | `enemy`, `skill`, `amount`, `crit` | The biggest hit was {amount} damage from {enemy} ({skill}). |

(Params in the last table are optional per cause; the English text is a suggestion for the UI agent.)

## 2. Codes the server already sends (no change; documented for the catalog)

These were audited and are already code-only; they need `ui.code.*` entries but no protocol change.

### World map `areas[].lockedReasons[]` (strings; parameter-free by design, never leaks operands or hidden IDs)

| Code | English reference |
| --- | --- |
| `world.noRouteFromReachableArea` | No known route leads here yet. |
| `requires.areaCompleted` | Conquer the preceding area first. |
| `requires.discovered` | Discover more of the world first. |
| `requires.flag` | A required event has not happened yet. |
| `requires.hasItem` | A required item is missing. |
| `requires.game.levelAtLeast` | Your level is too low. |
| `requires.game.defeated` | A required enemy has not been defeated. |
| `requires.not` | A blocking condition is active. |
| `requires.other` | A requirement is not met. |

### Expedition options `activities[].reason`

| Code | English reference |
| --- | --- |
| `start.areaNotCompleted` | Complete this area before sending an expedition. |

### Live command ack `reason` (status `rejected`) and `live.error`

| Code | English reference |
| --- | --- |
| `malformed` | That command was not understood. |
| `instance_closing` | The run is ending. |
| `not_present` | That hero is not present. |
| `hero_dead` | That hero is dead. |
| `in_combat` | You cannot do that during combat. |
| `not_in_combat` | You are not in combat. |
| `not_safe_location` | You can only do that in a safe location. |
| `no_such_consumable` | You do not have that consumable. |
| `no_effect_out_of_combat` | That has no effect outside combat. |
| `full_hp` | Health is already full. |
| `no_living_heroes` | No heroes are alive. |
| `retreat_not_allowed` | You cannot retreat from here. |
| `unknown_exit` | That exit does not exist. |
| `exit_locked` | That exit is locked. |
| `not_a_boss_room` | That is not a boss room. |
| `boss_room_requires_confirmation` | Confirm entering the boss room. |
| `confirmation_required` | Confirmation is required. |
| `unknown_group` | That enemy group does not exist. |
| `unknown_hotspot` | That object does not exist. |
| `unknown_node` | That resource does not exist. |
| `already_gathered` | Already gathered. |
| `corpse_unavailable` | That corpse is no longer available. |
| `invalid_live_command` | (live.error) The command was invalid. |

### Live `live.evicted` `reason`

| Code | English reference |
| --- | --- |
| `lease_lost` | The run moved to another server; reconnecting. |
| `store_error` | The run hit a storage problem; reconnecting. |

### Live view and events (keys, not prose)

| Code | Where | English reference |
| --- | --- | --- |
| `live.death.cause.unknown` | death summary `causes[].label` | Unknown cause |
| `live.corpse` | corpse hotspot `textKey` | Your fallen body. Recover your run bag here. |
| `live.death.run_bag_to_corpse` | boss-room `bossRoomWarning.risk.onDeath[]` | If you die, your run bag stays with your corpse. |
| `live.death.xp_penalty` | boss-room `bossRoomWarning.risk.onDeath[]` | If you die, you lose a share of your experience. |

Content-driven keys (`nameKey`, hotspot `textKey`, `labelKey`) come from authored content and are translated through
the content catalogs, not this document.

### HTTP error bodies `{ error: <code> }`

| Code | English reference |
| --- | --- |
| `invalid_request` | The request was invalid. |
| `invalid_command` | The command was invalid. |
| `operation_route_mismatch` | The command does not match this endpoint. |
| `unsupported_operation` | That operation is not supported. |
| `not_found` | Not found. |
| `unauthorized` | Please sign in again. |
| `forbidden` | You are not allowed to do that. |
| `rate_limited` | Too many requests; try again shortly. |
| `internal_error` | Something went wrong on the server. |
| `region_locked` | That area is locked. |
| `activity_conflict` | This character is already busy with another activity. |
| `busy` | This character is busy. |
| `instance_unavailable` | The run is unavailable. |
| `invalid_live_start` | The run cannot start there. |
| `insufficient_consumables` | You do not have enough of those consumables. |
| `invalid_configuration` | The character configuration is invalid. |
| `character_exists` | That character already exists. |
| `command_expired` | The command expired. |
| `command_id_conflict` | The command ID was already used for a different command. |
| `stale_start_snapshot` | Your data changed; review and try again. |
| `estimate_busy` | Estimates are busy; try again shortly. |
| `expedition_version_unavailable` | This expedition's rules version is no longer available. |
| `not_hosted` / `not_participant` | The run is not available to this character. |

Debug-only errors (`debug_clock_limit`, `invalid_progression`, `too_many_unique_items`, `unknown_area`, `unknown_enemy`,
`unknown_item`, `unknown_location`) are developer tooling and are not localized.

## 3. Intentionally not localized

- `engine/content-compiler`, `engine/world` registry/schema `message` fields, and `engine/expedition-kernel` contract
  violations: build-time or developer diagnostics, never sent to players.
- Server logs and thrown `Error` messages that are mapped to the codes above before reaching a client.
