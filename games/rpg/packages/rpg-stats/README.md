# @rpg/rpg-stats

Pure integer derivation of RPG combat stats from attributes + equipment
([combat-engine §3](../../../../docs/spec/combat-engine.md#3-stats-provisional)) and XP-curve helpers. One source of
truth for two callers ([ADR-0003](../../../../docs/adr/0003-simulation-server-only.md)):

- the **web client** (character sheet, equip previews) — display only;
- the **server / simulator** — authoritative; the server always recomputes.

Deterministic per [ADR-0004](../../../../docs/adr/0004-deterministic-step-engine.md): integers only, basis points
(`10000` = 100%), explicit rounding, no `Math.random` / `Date` / transcendental `Math.*`, no I/O.

## API

| Export | Purpose |
|---|---|
| `deriveStats({ level, attributes, equipment, modifiers? }, table)` | → `DerivedStats` (`attributes` (effective), `maxHp`, `powerBySchool { physical, magic }`, `power`, `armor`, `resist`, `critBp`, `haste`, `actionIntervalTicks`, `healPower`). |
| `StatFormulaTable`, `DEFAULT_STAT_FORMULAS`, `validateStatFormulaTable` | Formula constants as data. Default is **provisional** (open decision #2). |
| `actionIntervalTicks(haste, table)` | Haste → ticks between actions (floor 2). |
| `statDelta(before, after)`, `flattenStats`, `changedStats`, `STAT_DELTA_KEYS` | Compare-vs-equipped previews: `after − before` per displayed number. |
| `levelForXp`, `xpProgress`, `totalXpAtLevelStart`, `totalXpFromLevelProgress`, `xpToNextAtLevel`, `terminalLevel` | XP over the content `XpCurve` (`@rpg/rpg-schema`), **open-ended** since #129: past the authored table `xpToNext(L) = ⌊xpToNext(L − 1) × tailGrowthBp / 10000⌋`, no maximum level. A curve without `tailGrowthBp` is the legacy capped shape. |
| `deathXpLossBp(level)`, `applyDeathXpLoss(totalXp, curve)` | Death penalty (#129, live and idle alike): `lossBp(L) = max(200, 1000 − 20 × (L − 1))`, `xpLost = ⌊totalXp × lossBp(L) / 10000⌋`, total never below the start of level `L − 1` nor below 0 ([rewards §4](../../../../docs/spec/rewards-and-persistence.md), open decision #8). |
| `applyXpLoss(totalXp, lossBp, curve)`, `DEFAULT_DEATH_XP_LOSS_BP` (1000) | **Frozen legacy** penalty (10% of the XP required for the next level) retained for expeditions persisted by `rpg-idle@2.0.0`; pass the capped table curve. Do not use in new code. |
| `DEFAULT_XP_TAIL_GROWTH_BP` (12500) | Tail of the authored curve at #129 (pinned to the content file by a test); fallback only for persisted data that predates the stored tail. |

`equipment` takes anything with a `stats: StatMap` — `EquipmentItem` from `@rpg/rpg-schema` fits. `StatModifier`
mirrors the `stat_mod` effect (`{ stat, flat? , deltaBp? }`).

## Formulas (provisional — open decision #2)

`L = level − 1`; `⌊x × bp⌋` means `⌊x × bp / 10000⌋`. Every constant lives in `StatFormulaTable`.

| Stat | Formula (before gear) | Default constants |
|---|---|---|
| `maxHp` | `base + perLevel × L + perVit × VIT` | 50, 10, 8 |
| `powerBySchool.physical` | `⌊STR × perStrBp⌋ + perLevel × L` | 1.5 / STR, 1 / level |
| `powerBySchool.magic` | `⌊INT × perIntBp⌋ + perLevel × L` | 1.5 / INT, 1 / level |
| `power` | `max(physical, magic)` | — |
| `armor` | `⌊VIT × perVitBp⌋` | 0.5 / VIT |
| `resist` | `⌊SPI × perSpiBp⌋` | 0.5 / SPI |
| `critBp` | `baseBp + perAgiBp × AGI`, clamped to `[0, capBp]` | 500 bp + 20 bp / AGI, cap 5000 |
| `haste` | `⌊AGI × perAgiBp⌋` | 0.5 / AGI |
| `actionIntervalTicks` | `⌈base × 10000 / (10000 + haste × speedPerHasteBp)⌉` in `[min, base]` | base 6, min 2, 1% / haste |
| `healPower` | `⌊SPI × perSpiBp⌋ + perLevel × L` | 1.5 / SPI, 1 / level |

Pipeline order (all sums, so results do not depend on equipment/modifier order):

1. Effective attributes = base + gear attribute bonuses + flat attribute modifiers, then `× (10000 + ΣdeltaBp)`
   (floored), clamped `≥ 0`. Gear attributes therefore scale through the formulas.
2. Formula value + gear bonus of that stat.
3. Derived modifiers: `+ Σflat`, then `× max(0, 10000 + ΣdeltaBp) / 10000` (floored).
4. Clamps: `maxHp ≥ 1`, `critBp ∈ [0, capBp]`, everything else `≥ 0`.

Choices worth knowing:

- **Power per school.** combat-engine §3 says "max(STR, INT)-based per skill school". The simulator should read
  `powerBySchool[effect.school]` (STR → physical, INT → magic); `power` is the headline `max` for display and for
  school-less effects. Gear and modifier `power` apply to every school (there is no per-school gear stat yet).
- **Action interval rounds up**, unlike damage (which floors): a tick is saved only once it is fully earned; flooring
  would make the first haste point always save a tick. The `2`-tick spec floor is enforced by `validateStatFormulaTable`.
- All thresholds are safe integers. When the next threshold would exceed `Number.MAX_SAFE_INTEGER` (level 132 with the authored curve) the last representable level (`terminalLevel`) behaves like a cap: `xpToNext` is `null` and further XP stays in `xpIntoLevel`; sums that would overflow throw `RangeError`.
- On a capped (tail-less) curve, `applyXpLoss` uses the last table entry as "XP required for next level"; XP over the cap is kept.

Changing `DEFAULT_STAT_FORMULAS` or these rules changes simulation behaviour: bump the simulator's engine version and
update golden replays deliberately.

## Dependencies

- `@rpg/rpg-schema` (types, `ATTRIBUTES`, `DAMAGE_SCHOOLS`, `maxLevel`) — already shared with the client.
- **Not** `@engine/sim-core`: it is a simulator package (ADR-0003). The lint rule only checks direct imports from web
  apps, but depending on it here would put a simulator package in the client bundle transitively. The few integer
  helpers needed (`assertInt`, `divFloor`, `divCeil`, `mulDivFloor`, `mulBp`) are duplicated in `src/int-math.ts` with
  the same semantics and pinned by tests.

## Tests

`src/index.test.ts` (reference builds "bruiser/tank" and "striker/sustain" from `src/testing/builds.ts` at levels
1/5/10, stacking, modifiers, clamps, haste table, `statDelta`, a deterministic property loop), `src/xp.test.ts`.
