# ADR-0001: TypeScript full-stack monorepo with pnpm workspaces

- **Status:** Accepted
- **Date:** 2026-11-01

## Context
Very small team assisted by AI agents. Content schemas, protocol types and the combat simulation must be reused by the
web client, the server and offline tools (content compiler, balance simulator). Alternatives considered: Godot client +
TS server (splits languages, heavy web export, no C# on web), Elixir/Phoenix server (great for stateful rooms, but our
hard problems — economy integrity and idle — are database-centric, and we would lose code sharing with tools).

## Decision
- TypeScript (strict) for client, server and tools.
- One repository using **pnpm workspaces**: `apps/*`, `packages/*`, `tools/*`, `content/`.
- No Turborepo/Nx until build times justify it.

## Consequences
- One language for humans and agents; shared types end to end.
- Node is the only server runtime; CPU-heavy work (Monte Carlo) must be measured (spike 1) and may need worker threads.
- If a native client is needed later, the protocol package is the contract it implements.
