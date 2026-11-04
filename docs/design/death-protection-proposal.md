# Death protection: bounded POC proposal

> **Status: PROPOSED — owner decision required; not approved or implemented.**
> Scope: #130, informed by concept §9, rewards-and-persistence §4–5, and #56's economy evidence.

## Recommendation

For the POC, sell two independent consumable protections in Sanctuary: an XP blessing that reduces the next death's
XP loss by a fixed share, and a run-bag/expedition-loot ward that protects one death's unsecured rewards. Buy each
separately; consume each only when a qualifying death settles. Keep storage and equipped gear safe as today. This is
the smallest model that makes the XP and item tradeoff legible, creates a gold sink, and avoids bundling protection
players may not want. All prices and caps below are examples for owner review, not balance findings.

## POC options

| Option | Rule | Benefits | Costs / risks |
|---|---|---|---|
| A. Separate one-use protections (**recommend**) | Buy XP blessing and item ward independently; each covers one death. | Clear choice; item and XP sinks measured separately; no tier stack complexity. | Two inventory/economy items; pricing needs tuning. |
| B. Tiered blessings | Buy one or more XP blessings; each reduces penalty by a fixed share to a cap; optional item ward remains separate. | Matches the proposed “blessings” theme and supports spending choice. | More balancing and UI cases; stacked reduction can erase risk or confuse players. |
| C. Combined protection token | One purchase reduces XP loss and protects items at the same death. | Simplest purchase flow. | Bundles different needs and makes the sink harder to tune; can approach paid invulnerability if too strong. |

### Proposed provisional parameters (Option A)

- XP blessing: one-use, reduces the death XP penalty by **50%**; no stacking.
- Item ward: one-use, protects the entire eligible run bag / expedition loot from that death's item-loss rule.
- Illustrative prices: XP blessing **20 gold**, item ward **30 gold**. Both are provisional; owner sets prices and stack cap.
- No expiry while carried. A successful purchase is bound to the character and cannot be traded in the POC.

The #129 death-XP formula is an input only: tail growth 1.25 after the authored XP table; `lossBp(L) = max(200,
1000 − 20 × (L−1))` of total XP, floored, with at most one level lost. First compute `baseLoss` as the final #129
loss after its floor and one-level cap. With a blessing, `protectedLoss = floor(baseLoss × 5000 / 10000)`; do not
reorder the cap and percentage. This proposal does not change #129's formula or implementation.

## Mode semantics

- **Live:** death ends the adventure. Without an item ward, the current unsecured run bag goes to the corpse and
  ordinary recovery remains unchanged. With a ward, the eligible bag is deposited into durable inventory at death
  settlement and is omitted from the corpse; this is an explicit exception to normal return-to-Sanctuary banking.
  XP is granted immediately per current live rules; apply the XP protection exactly once at death settlement.
- **Idle:** use the policy frozen when the expedition starts. Without an item ward, 50% of expedition loot is lost;
  with it, that death loses none of that eligible loot. The XP blessing reduces only the death penalty. Protection
  is reserved/escrowed at start and consumed only if that expedition dies; survival or cancellation returns it.
- Existing in-flight idle expeditions keep their frozen settlement semantics and receive no retroactive protection or
  policy change. New protection rules apply only to expeditions started under the new policy version.
- The carry-versus-bank choice applies while alive in a live run: return to Sanctuary to move the run bag into
  inventory, or keep carrying it at risk. Death ends that instance; there is no continuing dead instance. A warded
  bag is deposited once and never copied. Recovered unprotected corpse loot is likewise claimed once.
- Equipment and Sanctuary storage remain unaffected. Future PvP is excluded; it needs a separate explicit policy.

## Transaction and replay requirements

1. Purchase debits gold and credits the protection atomically under the actor lock, with a unique ledger source and
   idempotent command key. A retry returns the saved result and cannot charge or grant twice.
2. For idle, reserve protection at expedition start in the same transaction as its escrow and frozen policy snapshot.
   Enforce one main activity per character; do not permit a second device or request to spend the same item.
   If an expedition survives or is cancelled, return the reservation. At death consume each reserved protection
   independently only if it avoided a positive loss: XP protection requires `baseLoss - protectedLoss > 0`; item
   protection requires at least one eligible item would otherwise be lost under that mode's rule. If the computed
   avoided XP loss rounds to zero, do not consume the XP blessing. Unused reservations return.
3. Apply the same avoided-positive-loss consumption rule in live. Consume the XP blessing and item ward independently;
   an empty bag does not consume an item ward, and a zero base XP loss does not consume an XP blessing. Record death
   settlement, XP adjustment, item/corpse disposition, protection consumption, and ledger
   entries atomically and idempotently. Duplicate jobs or command replay must not consume twice or reapply loss.
4. A crash before commit has no partial effects; after commit, replay returns the committed outcome. A retry after
   idle settlement must not resurrect returned protection or re-create loot.
5. Serialize activity purchases in Sanctuary with the same actor/economy lock. A purchase cannot race expedition
   start, live entry, or another spend to produce a negative balance or duplicate protection.

These are design acceptance constraints, not a schema or persistence implementation decision.

## Tiny illustrative accounting (not balance evidence)

Assume only for arithmetic that a character has 100 gold, carries 4 eligible loot units, and an unprotected death
would lose 2 units. An item ward at the illustrative 30 gold leaves 70 gold and, on death, preserves those same 4
units; it does not create 2 additional units. A separately purchased 20-gold XP blessing would reduce a hypothetical
100-XP penalty to 50 XP. These figures show transaction flow only; they are not observed balances, sustainable earning
rates, or evidence that either price is fair.

## Owner decisions before implementation

- Select A, B, C, or another bounded rule; decide exact protection strength, prices, and per-character stack caps.
- Confirm whether protection persists indefinitely while carried and whether death consumes only the protection used.
- Define eligible item categories and confirm live corpse contents when an item ward is used.
- Confirm idle reservation/refund behavior for cancellation, expiry, or invalidated starts.
- Decide when prices and protection values may change, with versioned snapshots for already-started idle expeditions.
- Review measured gold sinks and progression after #56 evidence and playtesting; no balance conclusion is made here.

## Evidence boundary

The #56 record reports a narrow real-PostgreSQL sample (four cycles per case) of gathering, banking, selling, and
buying a potion with exact ledger reconciliation. It establishes that this tested economy path worked; it does not
establish human throughput, sustained gold supply, acceptable death frequency, or blessing prices. Those require
separate observed runs and playtests.
