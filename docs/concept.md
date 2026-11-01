# Game Concept — Exploration RPG + Idle Adventure

> **Status:** Consolidated concept / POC pending
> **Genre:** Fantasy RPG, cooperative exploration, idle progression
> **Initial platform:** Browser, mobile-first
> **Future platforms:** iOS / Android
> **Planned business model:** Free-to-play, monetizing efficiency, convenience, subscription and passes
> **Game name:** TBD (working repository name: `idle-rpg-adventure`)
>
> This document is the English source of truth for the product concept. Technical decisions live in
> [`docs/adr/`](adr/), the technical specification in [`docs/spec/`](spec/), and open questions in
> [`docs/open-decisions.md`](open-decisions.md).

---

## 1. Product vision

A fantasy RPG centered on exploration, discovery, character progression and cooperation between players.

The game combines two complementary experiences:

1. **Live Adventure** — active exploration of illustrated scenes, discovery of places, tactical combat and boss encounters.
2. **Idle Expeditions** — automatic expeditions that let the player progress while offline.

Both modes share the same character, inventory, equipment, skills, level and economy.

The core proposition: a player can progress when they have no time to play, but dedicating time and attention to live
play is potentially more rewarding and unlocks content that idle can never reach.

The game must feel satisfying both in short sessions of a few minutes and in long active sessions.

### Core principles

- One character, one shared progression.
- The player is never forced to play live to farm resources they have already unlocked.
- Idle cannot conquer regions and never replaces active discovery.
- Live rewards decisions, strategy and exploration.
- Death is a real risk in both modes.
- Regions keep their own difficulty; there is no automatic scaling to the player's level.
- Cooperation is voluntary.
- PvP is consensual.
- Monetization may accelerate progress but must not invalidate the free experience.

---

## 2. Universe and setting

### 2.1. Premise

Humanity built a technologically advanced civilization. Facing a cosmic catastrophe, it launched evacuation **Arks**
toward what seemed to be another stable universe. There was no time to verify whether that universe was inhabited.

One of the Arks became trapped in an interdimensional **Fracture**. Its life-support and repopulation systems kept
working, but the knowledge-transmission systems failed.

Generations later, the survivors' descendants live in a society of medieval appearance, surrounded by ancient machinery
they no longer understand. Ancestral technology is interpreted partly as magic, religion or divine intervention.

### 2.2. Sanctuary

**Sanctuary** is the starting settlement and main social hub: a small world protected by ancient technological
infrastructure. It contains merchants, storage, crafting, repairs, factions, important characters, social services,
expedition access and portals to other regions.

The infrastructure that sustains Sanctuary is starting to fail — the initial motivation to explore outside.

### 2.3. The Fracture

The Fracture connects fragments of different universes. These fragments form explorable regions or micro-worlds with
their own ecosystems, ruins, civilizations and dangers.

- Some regions contain remains of ancient humanity; others belong to completely alien civilizations.
- Time flowed at different speeds in some fragments, so survivors from earlier eras can be found.
- The ultimate origin of the Fracture is initially unexplained.

### 2.4. Guardians

Some passages are protected by extraordinary entities, provisionally called **Guardians**. They were not designed as
challenges for humans: they are creatures or entities tied to the Fracture's anomalies.

Defeating certain Guardians may open new portals for the whole community. Not every region needs a Guardian.

### 2.5. Narrative evolution

The universe humanity was trying to reach really exists. Reaching it is a later stage of the game: a huge, hostile world
inhabited by its own civilizations, where humans arrive as refugees, not legitimate conquerors.

**Out of POC scope.**

---

## 3. Game structure

|                       | Live                         | Idle                                  |
|-----------------------|------------------------------|---------------------------------------|
| Control               | Active                       | Automatic                             |
| Exploration           | Yes                          | No                                    |
| Discoveries           | Yes                          | No                                    |
| Region conquest       | Yes                          | No                                    |
| XP                    | Yes                          | Yes                                   |
| Loot                  | Yes                          | Yes                                   |
| Resources             | Yes                          | Yes                                   |
| Combat                | Tactical, with intervention  | Automatic                             |
| Party                 | Connected players            | Participants confirmed beforehand     |
| Death                 | Possible                     | Possible                              |
| Shared progression    | Yes                          | Yes                                   |

A character can take part in **only one main activity at a time**. It cannot be on an idle expedition and in a live
adventure simultaneously.

---

## 4. Live Adventure

### 4.1. Experience

An atmospheric exploration adventure with moments of intense danger. The player moves through regions via connected
illustrated scenes. Each scene may contain: routes to other locations, enemies, resources, interactive objects,
characters, secrets, events, dungeon entrances and boss rooms.

Exploration must not become a constant sequence of fights. Pacing alternates discovery, navigation, decisions, tension
and dangerous encounters.

### 4.2. Visual representation

- Illustrated 2D scenes.
- Character and enemies as sprites or animated elements overlaid on the scene.
- Bosses may occupy a large part of the scene and have specific animations.
- The POC prioritizes readability, atmosphere and ease of producing new scenes.
- No free 3D movement is required.

### 4.3. Instanced exploration

Live exploration happens in **private instances**. A player explores alone or creates a party; party members enter the
same instance together. Players outside the party never appear in it. Sanctuary and other social spaces may be shared.

### 4.4. Live cooperation

All members of a live party must be connected simultaneously. Exploration and relevant decisions require active
participation. Characters may use configured combat automation but do not keep exploring while disconnected.
Accidental disconnections get a reconnection window.

### 4.5. Live farming

Players can return to explored regions to defeat enemies, look for materials, gather resources, obtain equipment,
complete repeatable tasks, find special creatures and investigate pending secrets.

Live must offer a potentially higher yield than idle. That advantage should come mainly from **efficient decisions and
player skill**, not from an arbitrary reward multiplier. Live farming must not require repetitive interactions without
strategic value.

---

## 5. Regions and conquest

### 5.1. Structure

Each region contains a set of connected locations and has: visual identity, characteristic enemies, resources, its own
difficulty, routes, discoveries, and possible mini-bosses or bosses.

### 5.2. Conquest

A region is **conquered** when the player:

1. Discovers at least **70% of its ordinary locations**, and
2. Defeats its mandatory bosses or mini-bosses, if any.

Both conditions are required. Exceptional secrets and content added later must not retroactively change the required
percentage. Conquest is permanent.

### 5.3. Idle unlock

Conquering a region enables idle expeditions in it. Each player must conquer a region **personally** to use it in
idle, even when partying with more advanced players.

### 5.4. Conquest vs. mastery

Conquest does not make a region safe. Practical mastery depends on level, equipment, skills and preparation. Regions do
not scale with player level: an initially dangerous region becomes easy as the character grows.

---

## 6. Idle Expeditions

### 6.1. Concept

Idle is a **simulation independent of physical exploration**. It does not represent the character literally walking
through the live instance. The player picks a conquered region and configures an automatic expedition, which keeps
running on the server even if the app is closed.

### 6.2. Duration

Initially: 15, 30, 60 and 180 minutes (subject to balancing).

### 6.3. Configuration

Before starting, the player selects: region, activity type, duration, available consumables, and auto-combat
configuration. The system shows estimates of XP, gold, resources, possible rewards, potion consumption and death
probability.

Estimates must derive from **the same combat model that runs the expedition**. They are not guarantees.

### 6.4. Resolution

The simulation covers encounters, combat actions, resource consumption, damage taken, healing, rewards and possible
death. If supplies run out, the expedition may end early according to return rules. An expedition can be cancelled
before it finishes. Exact settlement and cancellation rules must be defined before implementing the final system.

### 6.5. Result

A report with: effective duration, enemies defeated, XP, gold, loot, consumed resources, relevant events and final
character state. On death, an understandable record of the causes.

---

## 7. Party idle

### 7.1. Creation

A player configures an expedition and invites others. The invitation includes region, duration, activity, conditions,
reward distribution and risk estimates.

### 7.2. Invitations

Invitations expire (initial proposal: 5 minutes). All participants must accept before the start. If the configuration
changes, previous acceptances are invalidated.

### 7.3. Start

All characters start simultaneously; auto-start when everyone has accepted can be configured. After the start, nobody
needs to stay connected.

### 7.4. Rewards

XP, gold and loot are distributed according to the accepted rules. A party may generate more total rewards than a solo
player, but that does not imply each member receives more. The initial two-player split can be equal.

### 7.5. Advantages

A party can combine builds, add healing and support, improve survival, face harder enemies, and farm conquered regions
that would be dangerous solo. There is no artificial, universal risk reduction: effectiveness depends on actual
composition.

### 7.6. Cancellations

A member may leave an idle expedition. Remaining participants get a risk re-evaluation. An automatic cancellation
policy if a teammate leaves can be preconfigured. Exact split and settlement rules after abandonment are pending.

---

## 8. Combat

### 8.1. Shared engine

Live and idle use one common combat engine: **server-authoritative and tick-based**, with actions happening on a
consistent timeline. The final tick duration is pending tests.

### 8.2. Automation

The character has configurable rules to use skills automatically, enabling combat without constant intervention. In
live, the player can trigger skills manually and make tactical decisions. In idle, combat uses the automatic
configuration.

### 8.3. Builds

One main character with multiple specialization paths: damage, resilience, healing, support, control. No rigid class
system for the POC.

### 8.4. Bosses

Bosses use recognizable behaviours and special mechanics: phases, telegraphed attacks, patterns, weaknesses, abilities
requiring a tactical response.

Control abilities must state clearly whether their duration is measured in **ticks, actions or attacks**. Example: a
three-attack taunt is consumed by three eligible enemy attacks, not three global ticks.

---

## 9. Death and risk

Death has significant consequences: XP loss, possible level loss, loss of unsecured loot, risk of losing equipment, safe
storage in Sanctuary.

- **Live:** death may leave a recoverable body/container at the place of death. Since live regions are instanced,
  specific persistence and recovery rules are needed.
- **Idle:** death happens inside a simulation. A live recovery activity is being considered but not approved.
- **Design goal:** death creates real tension without feeling arbitrary. Probabilities and consequences must be
  communicated before significant risks are taken.

---

## 10. Progression and economy

### 10.1. Two axes of progress

- **Character power** — level, XP, attributes, skills, equipment, builds. Advanced through live and idle.
- **Exploration progress** — discovered locations, conquered regions, defeated bosses, secrets, narrative. Advanced
  mainly through live.

The two axes need not advance at the same pace.

### 10.2. Shared economy

Both modes feed one economy: gold, random loot, materials, crafting, consumables, repairs, storage. The economy needs
sinks that remove resources and gold from circulation. Player-to-player trade is out of the initial POC.

### 10.3. Difficulty and XP

Enemies keep their own levels and difficulty; XP per enemy is stable. Lower regions lose relative relevance through the
progression curve, not necessarily through artificial penalties.

---

## 11. Social and PvP

- **Social:** friends, party invites, cooperative exploration, cooperative idle expeditions, sharing discoveries.
  Shared social spaces may include Sanctuary and other settlements.
- **PvP:** voluntary only (challenges, duels, arenas, tournaments). No involuntary open PvP during exploration.
  **Out of POC scope.**
- **Social accessibility:** main progression must be viable solo. Cooperation offers advantages and extra content, but
  finding other online players must never be required to continue the main story.

---

## 12. Planned monetization

The POC does not need real payments, but the architecture must allow adding monetization without redesigning
progression.

- **Model:** F2P with full subscription, idle accelerators, convenience, gatherer pets, adventure passes, cosmetics,
  events.
- **Live:** extra inventory space, build configuration options, travel convenience, repairs and supplies, pass
  progress, personalization.
- **Idle:** faster expeditions, management convenience, limited parallel gathering, subscription benefits.
- **Principles:**
  - Never sell invulnerability.
  - Never sell automatic access to unconquered regions.
  - Never sell exclusive best-in-slot boss gear directly.
  - Avoid unbounded cumulative economic advantages.
  - An efficient live player must be able to beat the hourly yield of a premium idle player.
- Direct purchase of gold, materials and power remains an open decision.

---

## 13. POC scope

### 13.1. Goal

Validate one complete gameplay loop:

**Explore → Conquer → Unlock idle → Farm → Improve character → Explore a harder region.**

The POC must demonstrate the integration of both modes. It must not try to reproduce the whole planned universe.

### 13.2. Minimum content

- **Sanctuary** — simplified hub: character management, inventory, equipment, storage, start adventures, start
  expeditions.
- **Region 1** — ~10 illustrated locations, connected routes, common enemies, resources, one mandatory mini-boss,
  discovery progress, 70% conquest, idle unlock.
- **Region 2** — harder, fewer scenes, tougher enemies, one special encounter, higher preparation requirements. Its
  purpose is to prove that Region 1 progress is useful.
- **Character** — one hero, level and XP, basic attributes, equipment, inventory, a small skill set, auto-combat rules,
  at least two distinguishable builds.
- **Combat** — shared engine, automatic actions, manual intervention in live, common enemies, mini-boss with a special
  mechanic, damage, healing, consumables, possible death.
- **Idle** — conquered region selection, duration, risk estimates, automatic resolution, rewards, results report.
- **Cooperation** — party creation, invite and accept, invite expiry, shared idle expedition, reward distribution, one
  cooperative live encounter. **Decision: cooperation is POC phase 2** (see [roadmap](roadmap.md)).

### 13.3. Out of scope

PvP, guilds, full player trading, global market, real-money store, functional battle pass, the story's final world,
multiple classes, deep crafting, dozens of regions, complex world events, native mobile apps.

---

## 14. Conceptual architecture

Superseded in detail by [`docs/architecture/overview.md`](architecture/overview.md) and the ADRs. Concept-level
constraints that remain binding:

- Browser, mobile-first client: illustrated scenes, navigation, combat UI, inventory, character management,
  expeditions, parties, reports.
- The server owns character state, action validation, combat, idle expeditions, rewards, inventory, conquest, parties
  and persistence. **The client is never trusted** to compute rewards, damage or results.
- Live and idle share definitions of enemies, skills, stats, effects, combat rules and loot.
- Regions, scenes, enemies, skills and loot tables are **data-driven**; adding content should not require substantial
  code changes.

---

## 15. Risks to validate

1. **Live / idle relationship** — does idle complement live or end up replacing it?
2. **Retention** — after conquering a region, does the player want to explore another?
3. **Active farming** — does live offer higher reward potential without becoming repetitive work?
4. **Combat** — is the tactical system interesting with occasional interventions?
5. **Risk** — does death create satisfying tension or excessive frustration?
6. **Production** — is producing new regions viable with reusable tools and content?
7. **Cooperation** — do parties bring strategic decisions and real advantages?

---

## 16. Success criteria

The POC is conceptually successful if it shows that:

1. Exploring illustrated scenes is interesting.
2. The player clearly understands how to conquer a region.
3. Unlocking idle feels like an important reward.
4. Automatic expeditions produce useful progression.
5. Returning to live offers a perceptible advantage.
6. The second region motivates improving the character.
7. Shared combat works in both modes.
8. The architecture allows adding content without rewriting core systems.

The POC does not need to prove commercial viability.

---

## 17. Pending decisions

Tracked with provisional proposals in [`docs/open-decisions.md`](open-decisions.md). They must be documented
progressively and **never resolved through improvised implementations**.

## 18. Recommended next step

Do not start with the full universe or with monetization. Start with a small, complete, playable vertical slice that
validates the core loop. The technical specification lives in [`docs/spec/`](spec/) and the milestone plan in
[`docs/roadmap.md`](roadmap.md).
