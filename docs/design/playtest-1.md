# Combined player playtest script (reserved issue #58)

**Status: plan only.** No participants have run this script and no player findings or telemetry are claimed. Run as one combined batch with about 5–10 external testers over roughly one week; the phase 2 go/no-go decision remains pending evidence. This script complements the geared combat reports planned under issue #56; it is not a replacement for those reports.

## Before starting

Run from the repository root. Use the existing install where available; otherwise `pnpm install --frozen-lockfile` (requires pnpm and network access). Bring up the local service using the documented roles:

```sh
git switch codex/live-playable
git pull --ff-only
docker compose build server
docker compose up -d db
docker compose --profile ops run --rm migrate
docker compose up -d server
docker compose ps
pnpm --filter @rpg/web dev
```

Use `http://localhost:5173` on the same host as Docker. `docker compose down` stops services while preserving the named database volume; never use `down --volumes`/`-v`, reset the database, or wipe browser storage for an existing tester. The web app proxies API and live WebSocket traffic to the local server. Phone/LAN configuration is unvalidated; device acceptance needs a configured accessible environment (see issues #12 and #32).

Use the same browser profile/device and guest session for follow-up sessions. If a character already exists, resume it; do not create another or replace the saved character. New testers can use the guest session, then in **Character** choose **Create your character**, enter a name and choose **Create**. The starter kit is a one-time claim per character; existing saves keep their state. No admin/debug actions are needed for ordinary player steps.

## Short smoke (about 10–15 minutes)

1. Open the app and note whether the guest session reaches the Character screen. Record any error; do not clear site data to recover an existing save.
2. If this is a new character, create it as above. Open **Inventory** → **Inventory**. If offered, choose **Claim starter kit** once. Open a starter equipment item and choose **Equip …**; verify it appears under **Equipment**. If an ordinary stack is available, move one into **Storage** using its detail view's **Move to storage**, verify it is listed there, then move it back if needed. A fresh character may have no ordinary stacks yet; defer this check until live resources have been banked, and do not count absence as a failure.
3. In **World map**, inspect **The Verdant Hollow** and the displayed required-location progress / mandatory boss status. Choose the region's live entry only if available; start a solo adventure and select any available supplies. Record the actual options.
4. In an encounter, inspect **Combat**, **Your actions**, the **Auto** checkbox, skill slot readiness/cooldown and current HP. Choose one ready skill once; distinguish a command receipt or queued action from execution, and note whether the action executed or was rejected. Record cooldown remaining and authored cooldown duration. If current HP is below maximum and a **Minor Healing Potion** is carried, use one only if you are comfortable spending it; record stock and HP before/after. Do not spam clicks while an action is pending.
5. Use **World map** → **Resume live adventure** to verify navigation preserves the active run. Explore only as far as desired, then choose **Return to Sanctuary** when available. Confirm the run ends and record whether run-bag rewards appear in ordinary inventory/banked holdings.

## Longer progression route (roughly 45–90 minutes active, plus any 15-minute wait)

1. Keep using the same character and browser profile. In **Inventory** → **Merchant**, inspect currently offered sales. If a material sale is available, sell a small quantity of an in-inventory material stack; verify the displayed gold/stack update. Buy a small quantity of **Minor Healing Potion** if offered and affordable. Do not assume storage materials can be sold. Record unavailable offers or rejected actions without using admin tools.
2. Go to **World map** → **The Verdant Hollow** → live entry. Select an available area and assign one or more carried supplies in the entry form, then start. Verify the active run's **Live supplies** quantity. Follow open routes and gather available resources; note location discoveries, combat, HP changes and any live skill/consumable receipts.
3. Inspect each boss-room prompt only when encountered. The UI should show **Boss room risk** before explicit **Confirm entry**. Read the server-provided warning; testers may choose **Cancel**. Do not push an under-levelled character into the boss just to finish this script. Use the region's authored guidance when deciding readiness; do not infer a new recommended level from a test outcome.
4. If choosing to continue toward conquest, track **Required locations** and **Mandatory bosses** on World map. Conquest requires the authored ordinary-location threshold and mandatory boss completion. If a mandatory boss remains, the map should continue to show it as required; stop or return if risk is not acceptable. Do not treat ordinary exploration or an idle result as conquest.
5. If a death occurs naturally, record the visible XP/level change and death record. To check corpse recovery, use **New adventure**, choose the same area, navigate to the recorded death location, and then choose **Recover your corpse** if available; return to Sanctuary and check whether recovered loot is banked. The death screen itself does not show an immediate recovery hotspot. Do not deliberately engineer death. If no death occurs, mark these checks “not observed,” not pass.
6. Once idle is unlocked by the server after conquest, open **Expeditions**. Choose an available area/activity, set **15 minutes**, review consumable, retreat and automation settings plus the server **Estimate**, then choose **Start expedition**. Verify the running state and activity lock. Exercise **Cancel expedition** only if the tester wants to end early: inspect the preview, choose **Keep running** or **Confirm cancel**, and note returned supplies/rewards as reported. Otherwise let the full 15 minutes elapse.
7. Reopen **Expeditions** and record the result report: outcome, effective duration, XP, gold, loot, consumables, events and death record (if any). Check the **Go again** card, choose **Go again** to prefill only, inspect the setup, and do not start a second run unless intentionally continuing. Return to **World map** and verify expedition/resume navigation and the region's current conquest/idle state.

## Short debrief (ask after the run)

- How clear was the World map's explanation of what remains for conquest?
- Did the map and route navigation make it easy to resume live play after visiting another screen?
- Did the expedition result feel useful, and did it make you want to return to live play? Why?
- If death occurred, did the XP loss and death record explain what happened? Was corpse recovery understandable?
- What was the most confusing or frustrating step, and what would you change first?

## Tester record (one copy per participant)

| Field | Record |
|---|---|
| Tester code (no real name) | |
| Date / local time zone | |
| OS and version | |
| Browser and version | |
| Device / screen size; host or phone | |
| Build commit (`git rev-parse --short HEAD`) | |
| Character: new or existing; level at start/end | |
| Starter kit: already claimed / claimed once / unavailable | |
| Live supplies selected; expedition supplies selected | |
| Steps attempted and time spent | |
| Expected behavior vs actual behavior | |
| Pass / fail / not observed, with step number | |
| Error text / screenshot reference (redact account identifiers) | |
| Notes: clarity, fun, friction, risk, return-to-live motivation | |

Capture actual observations only. Do not enter personal identifiers or secrets in the record. Aggregate outcomes after the batch; until then, tester count, one-week timing, success criteria assessment and phase 2 go/no-go all remain pending.
