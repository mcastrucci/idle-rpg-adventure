# Spec: Conquest Rules

> Status: **Draft v0.1**.

> **Engine mapping (ADR-0018):** conquest is the RPG configuration of the engine's generic completion rule
> (`pool: ordinary`, `thresholdBp: 7000`, `required: defeated(mandatory bosses)`). See
> [`../engine/world-model.md`](../engine/world-model.md).

## 1. Definition

A region is conquered by a character when both hold:

1. `|discovered ∩ conquestPool| ≥ requiredDiscoveries`
2. `mandatoryBosses ⊆ defeated_boss_ids`

## 2. Freezing the requirement

- Each location declares `conquestPool: true|false`. Secrets and later-added locations are `false` by default.
- `requiredDiscoveries = ceil(0.7 × |conquestPool|)` is computed by `content-cli` when a region is first published and
  stored **frozen** in the region JSON. The compiler fails if a published region's frozen value or conquest pool
  membership changes, unless an explicit migration note is added.
- Effect: adding locations or secrets later never alters an existing requirement (concept §5.2).

## 3. Evaluation

- Server-side, inside the transaction that records a discovery or a boss defeat.
- Once `conquered_at` is set it is never cleared, even if content changes.
- Emits a `RegionConquered` event → client celebration + "Idle unlocked" call to action.

## 4. Credit rules

- **Discovery:** granted to each participant present in the instance when the party enters the location.
- **Boss defeat:** granted to participants who were in the combat when it ended in victory (alive or dead) *(provisional)*.
- Conquest is always personal: a party member who already conquered a region does not grant conquest to others
  (concept §5.3).

## 5. UI requirements

- Region map shows discovered/undiscovered ordinary locations count `X / required` and boss status.
- Locations not in the conquest pool are never shown as "missing".
