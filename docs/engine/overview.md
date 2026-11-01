# Engine Overview

> Status: **Draft v0.1**. Decisions: [ADR-0017](../adr/0017-reusable-engine-and-game-layers.md),
> [ADR-0018](../adr/0018-hierarchical-world-graph.md), [ADR-0019](../adr/0019-game-agnostic-expedition-kernel.md).
> Product name of the engine: TBD (packages use the `@engine/*` placeholder scope).

## 1. What the engine is

A game-agnostic foundation for **hub-and-world-map exploration games with live and idle modes**:

- A **hub** where the player prepares (inventory, loadout, services).
- A **world map** of areas reachable through routes with requirements.
- **Areas** made of connected locations, explored live in private instances.
- **Completion** of an area (discovery threshold + required objectives) unlocks **idle expeditions** there.
- Expeditions are simulated server-side, revealed over time and settled into a shared, idempotent economy.

The engine does **not** know what combat, XP, regions, enemies, zombies or hunger are. Games bring those.

## 2. Layers

```
┌──────────────────────────── games/<slug> ─────────────────────────────┐
│ simulators (combat, survival…) · stats · schema extensions · predicates│
│ content/ · art · theme · apps/web · apps/server (composition root)     │
└───────────────▲───────────────────────────────────────▲──────────────┘
                │ plugin interfaces                      │ uses
┌───────────────┴──────────────── engine/* ─────────────┴──────────────┐
│ client-kit     React shell pieces, SceneRenderer, WorldMap, AreaMap,   │
│                expedition setup/progress/report screens (themeable)    │
│ server-kit     Fastify modules: accounts, actors, activity lock,       │
│                command log, jobs, clock, debug                          │
│ live-kernel    InstanceHost, leases, checkpoints, exploration FSM over  │
│                the world graph, encounter hook                          │
│ expedition-kernel  precompute, reveal, settlement, cancel, party,       │
│                    estimates                                            │
│ economy        ledger, containers, escrow, idempotency                  │
│ world          world/area graph schemas, requirements, discovery,      │
│                completion, visibility, graph validation                 │
│ content-compiler  pluggable schemas, references, hashing, Tiled import │
│ sim-core       seeded RNG streams, integer/bp math, determinism helpers │
└───────────────────────────────────────────────────────────────────────┘
```

Rules: `engine/*` never imports `games/*`; within the engine, lower layers never import higher ones
(`sim-core` ← `world`/`economy` ← kernels ← kits).

## 3. Plugin points

| Plugin point | Interface (engine) | RPG implementation | Survival sandbox |
|---|---|---|---|
| Expedition simulator | `ExpeditionSimulator` | combat-driven hunts/gathering | scavenging runs with hunger, injuries, hordes |
| Live encounter handler | `EncounterHandler` | tick-based tactical combat | threat event (fight/flee/hide) |
| Requirement predicates | `PredicateRegistry` | `defeated`, `levelAtLeast` | `hasTool`, `dayAtLeast` |
| Content schema extensions | Zod schemas registered with the compiler | enemies, skills, effects, loot | threats, supplies, recipes |
| Actor snapshot | `snapshotActor()` | stats, loadout, automation rules | survivors, gear, condition |
| Post-settlement hook | `afterSettlement(tx, actor, deltas)` | level-up / de-level | morale, condition updates |
| Hub services | `HubService` registry | merchant, storage, repairs | workbench, stash |
| Theme / rendering | client-kit theme + `SceneRenderer` assets | fantasy illustrations | ruined-city illustrations |

## 4. Mapping examples

| Engine concept | RPG (this game) | Survival game |
|---|---|---|
| Hub area | Sanctuary | Shelter / base |
| World map | Portals to Fracture fragments | City districts map |
| Explorable area | Region | District |
| Location | Illustrated scene | Building / street |
| Route requirement | Guardian defeated | Bridge repaired |
| Completion | Conquest (70% + mini-boss) | District secured |
| Idle expedition | Hunt / gather | Scavenging run |
| Actor | Hero | Survivor group / drone |
| Run bag | Unsecured loot | Carried scavenged supplies |

## 5. What is intentionally *not* reusable
Balance and feel, simulators, art, narrative, and the specific design loop parameters. The "conquer live to unlock idle"
loop is a **design pattern** documented here, not code beyond the generic completion → unlock mechanism.

## 6. Repository layout (target)

```
engine/
  sim-core/  world/  economy/  expedition-kernel/  live-kernel/
  content-compiler/  server-kit/  client-kit/
games/
  rpg/
    apps/web  apps/server
    packages/rpg-schema  packages/rpg-sim  packages/rpg-stats  packages/protocol
    content/  tools/balance-sim
  survival-sandbox/        # toy game: simulator + tiny content, tests/CLI only
docs/
```

## 7. Extraction
When a second real game starts, `engine/` moves to its own repository with history, packages get versioned and
published, and this repo consumes them (ADR-0017).
