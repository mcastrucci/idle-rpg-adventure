# Working on idle-rpg-adventure

## Sources of truth

- Product rules: `docs/concept.md`.
- Approved Region 1 decisions: `docs/design/region-1.md` §9 (takes precedence over the earlier draft narrative).
- Architecture and package boundaries: `docs/engine/overview.md`, `docs/architecture/overview.md`, and accepted ADRs.
- Provisional gameplay numbers and unresolved choices: `docs/open-decisions.md`. Keep them provisional until evidence
  supports an explicit decision. A content fixture is not proof of balance or playability.
- GitHub issues and PRs track current ownership and acceptance; README/roadmap summarize the implementation boundary.

## Orchestration

The orchestrator reads the current code, issue discussions, and open PRs before assigning work. Check existing claim
comments and `status:in-progress` labels; another session may already own a dependency. Avoid competing implementations.

Before implementing or delegating an issue, reserve it on GitHub: add `status:in-progress` and a claim comment naming
the orchestrator, owned scope, and branch/worktree. Re-read its discussion before claiming; do not take another
session's reserved work. Refresh the default branch and open PRs before integration. When a task ends, link its PR
and release the reservation (or close the issue only when all acceptance criteria pass).

Delegate bounded tasks to smaller models when available: routine documentation and inventory can use a lightweight
model; implementation needs a coding model appropriate to the task. The orchestrator owns architecture, scope,
integration, and final review. Each task needs:

- An explicit issue or narrowly defined deliverable, owned paths, and dependency assumptions.
- An isolated branch/worktree, with no overlapping file ownership unless coordinated.
- Concrete acceptance criteria and meaningful verification.
- A commit, verification results, remaining limitations, and review findings returned to the orchestrator.

Review each diff before integration. Return defects to the implementing agent, then verify the corrected result.
Do not weaken an issue's acceptance criteria to declare it complete. Partial prerequisites should reference the issue
without closing it. Preserve other sessions' work and recheck the target branch before publishing changes.

## Implementation and validation

- `engine/*` stays game agnostic; game composition belongs in `games/rpg`. Respect the lint-enforced import layers.
- Simulations use injected RNG and integer math, never clocks or I/O. Behavior changes need deliberate version and
  replay-fixture updates.
- Server services receive a clock. The server owns state, rewards, validation, and economic transactions.
- Validate all authored JSON with the real content compiler. Keep the technical seed and authored draft region
  distinguishable. No final scene art before the real-device rendering spike establishes its budget and format.
- Run `pnpm check` for integrated code changes. Database changes need real PostgreSQL tests, including the CI path.
  Report any checks that could not run; do not substitute mocks for persistence acceptance.
- Keep dependency policies enabled. Resolve a rejected dependency with an eligible compatible release and commit the
  updated lockfile rather than disabling the policy.

Future domain work is tracked independently: adding a server foundation does not implement authentication, the ledger,
jobs, live hosting, or idle settlement. Keep module boundaries explicit as these features arrive.
