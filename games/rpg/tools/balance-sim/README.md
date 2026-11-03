# @rpg/balance-sim

Offline Monte Carlo balance reports over compiled RPG content (issue
[#24](https://github.com/mcastrucci/idle-rpg-adventure/issues/24), concept risk 15.1). It runs the real combat engine
(`@rpg/rpg-sim` `runToEnd`) on content compiled with the real compiler and RPG plugin. It then compares the results
with the provisional Region 1 targets ([region-1.md](../../../../docs/design/region-1.md) §5.3, §7).

This is a dev tool. Its numbers are **measurements, not balance decisions**. Every target check reports PASS, WARN or
N/A and never fails CI. Apps and server code never import it. The latest committed run is
[docs/design/balance/region-1-baseline.md](../../../../docs/design/balance/region-1-baseline.md).

## Usage

```sh
pnpm balance-sim                                   # Markdown to stdout, N=100, 50 hours
pnpm balance-sim --runs 500 --hours 200 --out report.md
pnpm balance-sim --sections boss --boss-levels 3-6 --format csv
pnpm balance-sim --regen-pct 10 --sections hourly  # idle regen is provisional (A9 / open decision #16)
pnpm balance-sim --scenario region-2 --runs 1000 --seed 24 --sections cells,boss --out docs/design/balance/region-2-measurements.md
```

| Option | Default | Meaning |
|---|---|---|
| `--content <dir>` | `games/rpg/content` | Content root, compiled on the fly (`contentHash` is printed). |
| `--scenario <name>` | `region-1` | `region-1` preserves the original default. `region-2` runs the fixed cohort comparison described below. |
| `--runs <n>` | 100 | Fights per encounter-group cell, attempts per boss row. |
| `--hours <n>` | 50 | Simulated hours per hourly row. |
| `--seed <uint32>` | 24 | Seed root. Run `i` of every cell uses `deriveSeed(root, 'balance', i)` (common random numbers). |
| `--levels`, `--boss-levels`, `--hour-levels` | `1-5`, `3-5`, `3-5` | Hero levels (`1-5` or `1,3,5`). |
| `--regen-pct <n>` | 15 | Idle between-fight regen, % of max HP. |
| `--sections <list>` | `cells,boss,hourly` | Which reports to run. |
| `--format md\|csv\|json` | `md` | CSV has one block per section (`# name`, header, rows); rates are bp and means ×100. |
| `--out <file>` | stdout | Write the report to a file. |

Exit codes: 0 report written, 1 content does not compile, 2 usage error. Wall-clock runtime goes to stderr only.
Every report header carries `ENGINE_VERSION`, `contentHash`, seed root, N and the model parameters. The same inputs
always produce a byte-identical report (tested).

Library: `loadBalanceContent(root)`, `runBalance(content, scenario, config)`, `renderReport(report, format)`,
`evaluateTargets(report)`, plus the building blocks (`fight`, `runCell`, `runBoss`, `runHours`,
`attentiveLivePolicy`, `rollLoot`).

## Reports

- **Encounter groups.** Every distinct non-boss group of the scenario's encounter tables × build × level. Each fight
  runs on automation only, from full HP, with 4 potions. Reported: win rate (bp), TTK p10/p50/p90 in ticks (wins
  only), mean net HP lost (a death counts as 100%), potions per fight, deaths and timeouts (3000-tick cap).
- **Mini-boss.** Boss loadout, 4 minor potions. Each row runs in two modes: **automation** (the build's rules only)
  and **attentive live** (the same rules plus the scripted player below).
- **XP and gold per hour.** Idle activities from content: the budget is `encountersPerHour` (pace ×1) rolled on the
  activity's encounter table. The live route is a scenario assumption, see below. Fights are chained with HP
  carry-over, regen between fights and a shared potion supply. Each enemy's loot table is rolled for gold and items,
  and items are valued at their content sell `value`. Idle `resourceYields` are rolled `rollsPerHour` times. An hour
  ends at its first death or timeout, which keeps 50% of that hour's gold and loot. XP/h is gross: the death XP loss
  is not applied.
- **Targets.** §7.2 TTK/HP/win rate at L1/L3/L5, the §7.2 design band at each group's own level, §7.4 boss success,
  fight length and live potions, §7.3 XP/potions/deaths per hour and the live/idle ratio, and §5.3 gold. Point
  targets use tool tolerances (`TOLERANCE` in `src/targets.ts`: TTK ±30%, HP ±10 points absolute, XP/h ±15%, gold/h
  ±25%, boss length ±30%). Targets that need a conquest model are listed as N/A.

## Modelling assumptions (provisional)

### Region 2 fixed cohorts

`--scenario region-2` compiles the selected content root with `compileContentDirectory` and runs the shared
`@rpg/rpg-sim` combat engine. It measures L4 fresh starter gear, L5 starter gear with fresh supplies, L5 farmed gear
with fresh supplies, L5 starter gear with farmed supplies, and the full L5 farmed setup. Two additional L5 rows remove
only the healing potion or only the sap tonic from the full farmed setup. The gear and supplies are explicit cohort
inputs; no farming, drops, merchant purchase history, travel, retreat, or gold acquisition is simulated. Supply gold
costs in the report are arithmetic at the documented merchant prices.

The tool validates each assumed equipment item's kind, required level and slot uniqueness. It uses the Bulwark and
Thornblade attributes, skills and six reference rules from `scenario.ts`. The mixed inventory is passed to combat as
individual item stacks, and each item's use is reported separately, including zero. Existing automation only requests
`minor_healing_potion`; the R1 reference rules do not use carried sap tonics or healing potions, so the corresponding
no-tonic and no-healing rows are controlled checks for this automation setup, not evidence that those supplies improve
outcomes. Manual Warden rows add the existing attentive guard/cleanse script. Paired seeds keep each cohort comparison
on the same deterministic combat draws.

Region 2 accepts `--runs`, `--seed`, `--sections cells,boss`, `--content`, `--format md|json` and `--out`. Its fixed
snapshot levels make `--levels`, `--boss-levels`, `--hour-levels`, `--hours`, and `--regen-pct` invalid. Default R1
scenario behavior and report structure remain unchanged.

All of these live in `src/scenario.ts`, `src/simulate.ts` and `src/policies.ts`.

- **Builds.** Bulwark and Thornblade are taken from design §4.2–§4.3. L1/L3/L5 use the design's attribute spreads;
  L2/L4/L6 continue its +4/level pattern. Stats come from the real `@rpg/rpg-stats` defaults, not the paper formulas
  A1/A3. Gear per level: starter gear at L1–2, `boar_hide_jerkin` from L3, and from L4 `tiller_plate_buckler`
  (Bulwark) or `lantern_lens` (Thornblade). The builds are tool inputs, not content and not a decision on open
  decision #13.
- **Rules.** Design §4.3, with one change: Thornblade's `second_wind` rule fires on `selfHasHarmfulEffect` (#71,
  §9 Q-B7) instead of `selfHpBelowBp 5500`. Thornblade's boss variant swaps `cleave` for `guard`. Bulwark's rules
  are verbatim; it has no cleanse.
- **Attentive live script.** Automation stays on. The script predicts each enemy's next action from public state
  (boss rotation position, AI list, cooldowns). It queues `guard` at the hero's **last** ready tick strictly before a
  telegraphed hit resolves. Inputs wait for the hero's next ready tick (A8), and enemies act first on equal initiative.
  It also queues the cleanse skill (Thornblade `second_wind`) while a DoT is on the hero. Limits: one hero only, and
  with several enemies another enemy's ordinary hit can still consume the guard.
- **Live route.** 36 fights/h, spread uniformly over the lantern ruins, pump station and terraces tables. Groups made
  only of mites are skipped at no time cost. The player rests 20% of max HP between fights (a short rest at 1%/tick,
  A9) and has 6 potions per hour. Potions use the same rules as automation.
- **Idle.** 5 escrowed potions per hour, 15% regen (`--regen-pct`), and an expedition stop at the first death (spec
  idle-simulation §4).

## Tests

`src/balance-sim.test.ts` covers: integer formatting and percentiles; a synthetic scenario with known outcomes
(`src/testing/synthetic.ts`: a 1-HP dummy always dies at tick 1, a brute always wins, exact XP/gold per hour, the
live skip rule); the Region 1 group set; determinism (identical report for the same inputs, different for another
seed root); the attentive script guarding every Matriarch telegraph; Markdown/CSV/JSON headers; and a CLI smoke run
on Region 1 with tiny N plus usage and content errors. The suite runs in about 2 s.
