# Roadmap — POC Milestones

Each milestone is a GitHub **epic** issue (type *Feature*, label `epic`) with verifiable **sub-issues** (type *Task*).
Labels: `milestone:M0…M8`, `area:*`, `phase:1|2`, `spike`.

Core loop to validate: **Explore → Conquer → Unlock idle → Farm → Improve character → Explore a harder region.**

## Current implementation snapshot

The browser client and Fastify/PostgreSQL server support guest authentication, character creation, and
server-authoritative character commands. Inventory includes an explicit one-time starter-kit claim (new characters are
not auto-equipped), inventory/storage/equipment moves, equip/unequip, and merchant purchases. The worker runs a
recurring read-only ledger audit. See the [server guide](../games/rpg/apps/server/README.md) and [inventory
contract](../games/rpg/apps/server/src/inventory/README.md).

Live exploration is persisted and supports movement, encounters, rewards, death and return; server-recorded area
completion unlocks eligible idle expeditions. The solo lifecycle includes transactional escrow, settlement,
cancellation, unavailable-policy recovery and terminal reports. The web flow includes live exploration, expedition
setup/progress/results, and server-computed estimates. See [live server
behavior](../games/rpg/apps/server/src/live/README.md) and [web client](../games/rpg/apps/web/README.md).

The local Compose setup for PostgreSQL and API/live/worker roles is documented in
[docs/ops/container.md](ops/container.md). Region content, balance measurements and simulation reports are evidence
for continued tuning, not final balance decisions or human playtest results. Human playtesting, public hosting, and
real-device renderer validation remain outstanding. Process-crash recovery validation is tracked in
[#37](https://github.com/mcastrucci/idle-rpg-adventure/issues/37). Open progression decisions remain in [open decisions](open-decisions.md); this snapshot does not close milestones
or infer final art readiness.

## Dependency guidance

- Finish the expedition-kernel contract fixes surfaced by the survival sandbox before building game simulators on its
  current interface. Implement the RPG step engine, effects, automation/AI, and replay safeguards as their contracts
  stabilize; apply the Region 1 combat review decisions after the shared combat behaviors are integrated.
- Server foundation work can proceed alongside simulation and does not need to wait for every M0 spike. Keep the
  persistence and hosting choices explicit where their ADRs remain proposed.
- Balance results require the RPG simulator and usable draft content; technical seed data alone cannot validate Region
  1 balance.
- Complete the mobile renderer and texture-budget validation on real devices before producing final scene art. The
  paper design can continue in parallel.

```
Phase 1 (solo vertical slice)
M0 Foundations & spikes ─► M1 Simulation core ─┬─► M2 Server foundation ─► M4 Live adventure ─► M5 Region 1 & conquest ─► M6 Idle ─► M7 Region 2 & validation
                                                └─► M3 Sanctuary client ───┘
Phase 2 (cooperation)
M8 Party idle + live coop
```

## M0 — Foundations & spikes

Epic: [#1](https://github.com/mcastrucci/idle-rpg-adventure/issues/1)

Time-boxed (~3 weeks). Spikes first; in parallel, continue the **paper design** and prepare schema-valid draft numerical
content as inputs to simulation. Such draft data remains provisional and does not count as a validated Region 1. Do not
produce final scene art until spike 2 measures the renderer, texture budget, and scene format on real devices.

- Monorepo bootstrap (pnpm, TS strict, lint incl. sim import ban, Vitest, CI)
- **Spike 1** — combat engine + idle precompute + estimates (ADR-0013) — **done**, ADR-0013 Accepted; 200-run estimate latency (5.2 s / 3.9 s vs 2 s) needs the cache of #53; report: [`docs/spikes/spike-1-sim.md`](spikes/spike-1-sim.md)
- **Spike 2** — mobile rendering PixiJS vs Phaser + Capacitor on real devices (ADR-0010, ADR-0011)
- **Spike 3** — live instance + economy integrity under adversarial tests (ADR-0012)
- Region 1 paper design — [`docs/design/region-1.md`](design/region-1.md) (draft for product review)
- Close spikes: update ADR statuses

**Exit:** ADR-0010…0013 are Accepted or Rejected with data; repo builds in CI. The rendering and mobile distribution
decisions require real-device evidence; do not infer those outcomes from a desktop prototype.

## M1 — Simulation core

Epic: [#2](https://github.com/mcastrucci/idle-rpg-adventure/issues/2)

**Engine foundations** (package boundaries, `sim-core`, `world` graph model, `expedition-kernel` interface, survival
sandbox), RPG content schema extensions, content compiler, stats, step engine, effects with duration units, automation rules, enemy/boss
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

Start transaction + precompute, reveal API + progress screen, settlement, cancellation, unavailable-policy recovery,
terminal reports and server-computed estimates are implemented for actors whose area completion is persisted. Live
exploration now records area completion, and ordinary gameplay can unlock eligible idle activities. Human playtesting
and final balance decisions remain pending.

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
