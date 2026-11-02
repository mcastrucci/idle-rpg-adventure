# spikes/live-colyseus — throwaway Colyseus comparison (spike 3, #13)

**Not production code.** Nothing imports this package. It exists only to compare Colyseus with the in-house
`InstanceHost` ([engine/live-kernel](../../engine/live-kernel/README.md)) for [ADR-0012](../../docs/adr/0012-live-instance-hosting.md).
Delete it once the decision no longer needs the evidence.

`src/room.ts` implements the same 2-player room semantics as the in-house host with a counter stub instead of combat:
`commandId` dedupe (hand-written), ticks only while "fighting" (`setSimulationInterval` installed/cleared), sequenced
event broadcasts, `allowReconnection` grace during which the fight keeps ticking, then `left`. `src/room.test.ts`
drives it with the real `@colyseus/sdk` client over WebSocket:

- a dropped client (server-side socket terminated) keeps the room ticking; reconnecting with the reconnection token
  restores the session and the full schema state, **but broadcast events sent during the drop are lost** (seq gap);
  a replayed `commandId` is ignored only because the room code dedupes it;
- after the grace (scaled to 1 s, real time) the participant is `left` and the token is rejected.

Run: `pnpm vitest run --project @spikes/live-colyseus` (no database needed).

## Versions and dependency policy

Pinned exact: `@colyseus/core` 0.18.19, `@colyseus/ws-transport` 0.18.4, `@colyseus/schema` 5.0.41,
`@colyseus/sdk` 0.18.5 (dev). These are the newest releases at least two weeks old at the time of the spike; Colyseus
publishes `@colyseus/core` every few days. The tree adds **83 packages** to the lockfile (including Express 5 as an
auto-installed peer of the transport and `better-call`/`better-fetch` from the auth-oriented router), and 8 transitive
packages resolved to releases younger than two weeks (`msgpackr` and its native `msgpackr-extract` were published on
the day of the spike). They are pinned through `pnpm-workspace.yaml` overrides instead of weakening the policy, and the
optional native `msgpackr-extract` build is disallowed (`allowBuilds`). Client SDK bundle: `dist/colyseus.js` 217 KB
unminified, ~67 KB gzip.

Findings are summarized in ADR-0012.
