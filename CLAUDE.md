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

## Issue claiming protocol (multiple agents work in parallel)

Before writing any code for an issue:

1. **Check availability.** Read the issue's labels and comments. If it has `status:in-progress` or `status:in-review`,
   or an unreleased 🔒 claim comment, **do not start it** — pick another issue.
2. **Check dependencies.** If the issue depends on unfinished work (see its parent epic/roadmap), pick another one.
3. **Claim it.** Add the label `status:in-progress` (keep existing labels) and post a comment:
   `🔒 Claimed by agent <short-name> (session <session link>). Branch: <branch>.`
4. **Resolve races.** Re-read the comments right after claiming. If another 🔒 claim was posted earlier than yours
   and not released, post `🔓 Released (duplicate claim)`, remove your label change and pick another issue.
5. **Hand off.** When the work is ready for review, replace `status:in-progress` with `status:in-review` and comment
   with the branch, commits and a short summary. The reviewer closes the issue when the work is integrated.
6. **Release if you stop.** If you abandon or get blocked, remove `status:in-progress`, comment
   `🔓 Released: <reason>`, and leave notes for the next agent.

Never work on an issue claimed by someone else, and never remove another agent's claim.
