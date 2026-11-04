# Survival and death economy accounting proof (#56)

## Purpose and limits

This real-PostgreSQL integration proof compares safe banking with death, corpse recovery, and banking using the unchanged
authored Region 1 content. Each arm receives the same character configuration, starter kit, three minor healing potions,
and 80 Level 1 XP. Both select two potions as live supplies and gather at the authored glowcap node in the Overgrown
Causeway. The survival arm returns without engaging its optional encounter. The death arm engages a normally rolled
non-boss group, turns off hero attacks, uses one carried potion after taking damage, then leaves the fight to its authored
enemies. This deliberate inaction drives an end-to-end death/recovery accounting case; it is not a natural death-rate or
player-behavior sample.

The three starting potions and 80 XP are controlled test fixtures, not fresh-player evidence. Starter equipment is
claimed and equipped through public inventory commands. Initial potion funding uses a test-only ledger source because
the merchant requires gold; one potion is moved to storage through the public inventory API. Content is compiled from
the repository's authored files without edits. The integration currently uses independent production CSPRNG instance
seeds because the live host does not expose a seed injection seam. This is a matched-input accounting comparison, not a
fixed-seed replay, causal balance estimate, or final tuning claim.

## Reproduction

Run against a private ephemeral PostgreSQL database using the repository's normal integration-test setup. Set
`TEST_DATABASE_URL` to that target; do not point the test at shared or production data.

```sh
TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm exec vitest run --project @rpg/server games/rpg/apps/server/src/inventory/death-economy.integration.test.ts
```

The test creates both authenticated characters and performs setup through the public character and inventory routes.
It starts instances through `POST /live/start`, reads the authored current view through `GET /live/current/:actorId`,
and submits live command objects to the host with the owning account and actor identity. It checks gathering replay,
corpse interaction replay, sale replay, ledger invariants, inventory/storage/equipment safety, and the persisted death
XP loss. The direct host submission exercises the same live command handler, but does not test WebSocket framing or
transport delivery.

## Accounting checked

- Gather quantity is read from the durable run bag and must match the authored one-to-two glowcap yield.
- Safe return moves the survival arm's run bag to inventory. Death moves the fallen arm's run bag into its corpse;
  recovery moves the same quantity into a new run bag, and explicit return banks that quantity.
- The fallen arm's selected supplies decrease by one potion after a real use. Its other selected potion remains in
  inventory; the stored potion and all equipped starter items remain unchanged. The survival arm's two selected
  potions remain unused.
- Each arm sells only its banked glowcaps. The material quantity becomes zero and the public authored sale value credits
  exactly two gold per glowcap. Replaying a sale command or a corpse recovery command does not add another effect.
- The death row records a positive loss from the controlled 80 XP starting state. The test checks the persisted XP
  result rather than asserting a stale fixed percentage or a next-level-only curve assumption.
- `checkLedgerInvariants` is empty before the runs, after death/recovery, and after sale.

The test prints an aggregate JSON summary to the CI log. It contains only arm totals; no actor, account, command, or
instance identifiers are reported. Gather quantities may differ across the independent CSPRNG runs and each arm is
reconciled against its own observed quantity. The proof does not estimate income/hour, demonstrate expected death
frequency, model human input timing, or complete #56's broader balance decisions.
