# ADR-0016: Hosting for the POC

- **Status:** Proposed
- **Date:** 2026-11-01
- **Validation:** M2

## Decision (hypothesis)
- One long-lived container (Fly.io, Railway, Render or a VPS) for `apps/server`; static web build on a CDN.
- Managed PostgreSQL with **direct connections** (needed for `LISTEN/NOTIFY` and pg-boss).
- No serverless functions for the game server (WebSockets and in-memory instances require long-lived processes).

## Consequences
Target cost USD 20–50/month for the POC.
