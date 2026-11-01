# Working agreements for agents and contributors

- Docs, issues, code and identifiers are in **English**.
- Read the relevant ADRs in `docs/adr/` and specs in `docs/spec/` before implementing a system. Do not resolve an item
  from `docs/open-decisions.md` through an improvised implementation: propose the decision, record it, then implement.
- **Engine vs game (ADR-0017):** `engine/*` must never import `games/*` and must not contain game concepts (combat, XP,
  regions, enemies…) in names, types or tables. Game-specific behaviour goes through engine plugin interfaces. If
  `games/survival-sandbox` would need RPG code, fix the engine boundary instead.
- **Server authority:** clients send commands, never results (ADR-0002).
- **Simulator rules (ADR-0004), for `engine/sim-core`, `engine/expedition-kernel` and `games/*/packages/*-sim`:** no `Math.random`, `Date`, `performance.now`, transcendental `Math.*`, floats in
  game math, or I/O. Use the injected RNG streams and integer/basis-point math. Bump `ENGINE_VERSION` on behaviour
  changes and update golden replays deliberately.
- Web apps must never import simulator packages (ADR-0003).
- **Economy (ADR-0007):** only `engine/economy` (ledger) changes balances/ownership; every mutation has an idempotency key;
  activity changes are compare-and-set; lock characters in ascending ID order.
- **Content (ADR-0008):** JSON only; IDs are stable and never renamed; run the content compiler before committing
  content.
- Keep `participants[]` generic in instances and expeditions even though phase 1 is solo.
