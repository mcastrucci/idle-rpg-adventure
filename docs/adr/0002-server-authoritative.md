# ADR-0002: The server is the exclusive authority

- **Status:** Accepted
- **Date:** 2026-11-01

## Context
Shared economy across live and idle, real death penalties and future monetization make any client-side authority an
exploit vector.

## Decision
- The server alone computes combat, damage, rewards, loot, XP, conquest, inventory changes and timers.
- Clients send **intents/commands** (`travel`, `useSkill`, `startExpedition`…), never results.
- All time is server time (`now()` from the injectable server clock / database).

## Consequences
- The client is a renderer + input device; it can be replaced (e.g. native client) without touching game rules.
- Every feature needs a server endpoint/command; no "quick" client-only shortcuts for gameplay.
