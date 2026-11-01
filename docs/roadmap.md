# Roadmap — POC Milestones

Each milestone is a GitHub **epic** issue (type *Feature*, label `epic`) with verifiable **sub-issues** (type *Task*).
Labels: `milestone:M0…M8`, `area:*`, `phase:1|2`, `spike`.

Core loop to validate: **Explore → Conquer → Unlock idle → Farm → Improve character → Explore a harder region.**

```
Phase 1 (solo vertical slice)
M0 Foundations & spikes ─► M1 Simulation core ─┬─► M2 Server foundation ─► M4 Live adventure ─► M5 Region 1 & conquest ─► M6 Idle ─► M7 Region 2 & validation
                                                └─► M3 Sanctuary client ───┘
Phase 2 (cooperation)
M8 Party idle + live coop
```

## M0 — Foundations & spikes

Epic: [#1](https://github.com/mcastrucci/idle-rpg-adventure/issues/1)

Time-boxed (~3 weeks). Spikes first; in parallel only **paper design** of Region 1 (no art production until spike 2
fixes the texture budget and scene format).

- Monorepo bootstrap (pnpm, TS strict, lint incl. sim import ban, Vitest, CI)
- **Spike 1** — combat engine + idle precompute + estimates (ADR-0013)
- **Spike 2** — mobile rendering PixiJS vs Phaser + Capacitor on real devices (ADR-0010, ADR-0011)
- **Spike 3** — live instance + economy integrity under adversarial tests (ADR-0012)
- Region 1 paper design
- Close spikes: update ADR statuses

**Exit:** ADR-0010…0013 Accepted or Rejected with data; repo builds in CI.

## M1 — Simulation core

Epic: [#2](https://github.com/mcastrucci/idle-rpg-adventure/issues/2)
Content schemas, content compiler, RNG, stats, step engine, effects with duration units, automation rules, enemy/boss
AI, golden replay tests, balance simulator.

**Exit:** `balance-sim` runs Region 1 draft enemies vs 2 reference builds deterministically on two Node versions.

## M2 — Server foundation

Epic: [#3](https://github.com/mcastrucci/idle-rpg-adventure/issues/3)
Fastify skeleton with roles and injectable clock, Postgres + migrations, guest auth, characters + activity lock, ledger
+ invariant checker, command idempotency, job queue, debug endpoints, deploy pipeline.

**Exit:** deployed server; ledger invariant checker green under concurrent test load.

## M3 — Sanctuary & character client

Epic: [#4](https://github.com/mcastrucci/idle-rpg-adventure/issues/4)
Web app shell (routing, API/WS clients), character screen, inventory/storage/equip, automation rules editor.

**Exit:** on a phone, a player can create a character, equip items and edit automation rules.

## M4 — Live adventure (solo)

Epic: [#5](https://github.com/mcastrucci/idle-rpg-adventure/issues/5)
InstanceHost with leases/checkpoints, exploration state machine, live WS protocol, scene viewport, combat overlay, run
bag/return, death/penalties/corpses.

**Exit:** a player explores a test region, fights, dies or returns, and state survives a server restart.

## M5 — Region 1 & conquest

Epic: [#6](https://github.com/mcastrucci/idle-rpg-adventure/issues/6)
Tiled import, 10 locations, enemies/loot/mini-boss, discovery + conquest evaluation, adventure screen.

**Exit:** Region 1 can be conquered in live and unlocks idle (success criteria 1–3).

## M6 — Idle expeditions (solo)

Epic: [#7](https://github.com/mcastrucci/idle-rpg-adventure/issues/7)
Start transaction + precompute, reveal API + progress screen, settlement, cancellation, estimates + setup screen, report
+ death log.

**Exit:** expeditions of 15–180 min complete/cancel/die correctly with app closed (success criterion 4).

## M7 — Region 2 & loop validation

Epic: [#8](https://github.com/mcastrucci/idle-rpg-adventure/issues/8)
Region 2 + special encounter, balance pass (live > idle XP/hour for efficient play), telemetry for success criteria,
playtest round.

**Exit:** success criteria 5–8 evaluated with playtest data; go/no-go report.

## M8 — Cooperation (phase 2)

Epic: [#9](https://github.com/mcastrucci/idle-rpg-adventure/issues/9)
Friends + presence, party idle invitations (expiry, `config_version`), party simulation + reward split, leaving +
re-simulation, live coop (2 players) with disconnection grace, cooperative encounter.

**Exit:** two players complete a shared idle expedition and a cooperative live encounter.
