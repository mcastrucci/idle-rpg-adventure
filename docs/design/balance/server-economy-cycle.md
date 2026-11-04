# Server economy cycle proof (#56)

## Purpose and limits

This is a bounded proof that an authenticated, fresh player can gather authored materials in live play, return and bank them, sell banked materials, then buy one authored minor healing potion and carry it into another live instance. It validates reachable server transactions and conservation, not an economy rate or balance outcome. Combat is not required: current non-boss combat encounters are opt-in under the live rules.

The test uses a fresh Level 1 character with zero XP, gold, and holdings. The starter kit is explicitly claimed through the public inventory command and equipped through public inventory commands; character creation does not grant it automatically. The test may stop once the potion is affordable and purchased. Live supplies are not escrowed: the potion remains in inventory while selected/live and decrements only when actually used, unlike idle expedition escrow. Do not report a final balance claim.

## Authored arithmetic (not empirical)

In current content, `loot:region_1.glowcap_gather` has one roll, `nothingWeight: 0`, and `item:glowcap` quantity 1–2. `item:glowcap` is a stackable material with authored value 2 gold. The Region 1 merchant's `offer:minor_healing_potion` costs 12 gold. Thus, conditional on the glowcap node being accessible, no inventory/run-bag loss, successful return, and selling only glowcaps, each gather yields 2–4 gold. Affordability falls between gather 3 (maximum case) and gather 6 (minimum case); with stopping at the first affordable sale, the remaining gold is 0 or 2. This is theoretical arithmetic from authored quantities and values, not a deterministic seeded guarantee, measured yield, or time estimate. Content/compiler changes can invalidate it.

Sources: [glowcap node](../../../games/rpg/content/resource-nodes/region_1.json), [glowcap loot table](../../../games/rpg/content/loot-tables/region_1.json), [item definitions](../../../games/rpg/content/items/region_1.json), [merchant offers](../../../games/rpg/content/merchants/region_1.json), [live gather and return rules](../../../games/rpg/apps/server/src/live/game.ts), [return banking and sale rules](../../../games/rpg/apps/server/src/live/effects.ts) and [inventory service](../../../games/rpg/apps/server/src/inventory/service.ts).

## Reproduction

Run against a private ephemeral PostgreSQL database using the repository's normal integration-test setup. Set `TEST_DATABASE_URL` to that target; never point the test at a shared or production database. The test setup must migrate/clean only its private test database and must not delete real user progress.

```sh
TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm exec vitest run --project @rpg/server games/rpg/apps/server/src/inventory/economy-cycle.integration.test.ts
```

Use a fresh registered account/session and character through public auth/character routes. Record initial holdings and verify zero gold/XP. Claim the kit publicly, then explicitly equip it through public inventory commands. Use authenticated HTTP plus authenticated WebSocket live commands to travel via `exit:region_1.portal_clearing.overgrown_causeway` to `overgrown_causeway`, gather the glowcap resource node discovered in the live view (`res:glowcap`), travel via `exit:region_1.overgrown_causeway.portal_clearing` back to `portal_clearing`, and safely return to sanctuary with `returnToSanctuary`. In sanctuary, sell only banked `item:glowcap` using `inventory.sellMaterial`; repeat bounded live cycles if needed. Buy exactly one minor healing potion from the authored merchant once gold is at least 12. No admin/debug grants, seeded holdings, test-only loot edits, or preclaimed progression may participate in the proof.

## Required recorded data

Record a compact aggregate JSON summary, without account/actor/command/instance IDs or secrets:

```json
{
  "proof": "",
  "cycles": 0,
  "gathered": 0,
  "banked": 0,
  "sold": 0,
  "materialGold": 0,
  "spent": 0,
  "finalGold": 0,
  "potionQty": 0,
  "level": 1,
  "xp": 0
}
```

No empirical sample is frozen in this method document. The exact-head run and compact summary belong in the #56 verification comment and CI log.

## Assertions and interpretation

- Reconcile each asset's expected before/after quantity: gather grants match live run-bag drops; safe return moves eligible run-bag holdings into inventory; sale removes the sold material and creates `quantity × authored value` gold; purchase removes exactly 12 gold and grants exactly one potion. Check ledger invariants and ensure no per-asset quantity is lost or duplicated in the successful path. Sales convert one asset into another, so cross-asset debits and credits are not equal.
- Replay HTTP sale and buy requests with the same command ID and identical payload; result and holdings must be unchanged with no second ledger effect. This proof does not attempt changed-payload HTTP ID reuse; that conflict behavior is covered by [inventory integration tests](../../../games/rpg/apps/server/src/inventory/inventory.integration.test.ts). Live WebSocket deduplication is by live command ID and cached acknowledgement; a fresh gather against an already gathered node is rejected. The service expects an HTTP sale during live activity to fail with 409. Check ledger invariants before and after each cycle.
- Record only the compact, non-identifying summary and relevant aggregate counts/results. A successful sale requires banked inventory; do not infer gold from run-bag contents.
- This is a finite reachable-path proof. It does not estimate gold/hour, compare live and idle yields, establish a risk-free infinite-profit loop, or claim a final balance. Command timing, human decisions, other content, longer runs, combat, death/corpse handling, and idle behavior remain outside this bounded proof.

## Relationship to prior work

Issue #118 and [starter-kit evidence](starter-kit-live-baseline.md) report a finite authored combat-route simulation with provisioned cohorts; they do not show a fresh account claiming/equipping the kit or completing database-backed inventory transactions. This #56 proof uses live server APIs and PostgreSQL ledger persistence to cover that reachability gap. The [economy sinks audit](economy-sinks-audit.md) documents authored values and transaction semantics, but its historical balance discussion is not evidence for this fresh-player cycle. No content prices or authored values are changed here.
