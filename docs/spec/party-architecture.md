# Spec: Party Architecture (POC phase 2)

> Status: **Draft v0.1**. Cooperation is **phase 2** of the POC. Phase 1 must still model `participants[]` in
> instances and expeditions so phase 2 is additive.

## 1. Party idle expedition

### Invitations
- Leader creates an expedition in `draft`, invites players (friends list *(provisional)*), status → `pending_invites`.
- Invite carries the full config + risk estimate per participant + reward distribution + `config_version`.
- Expiry: **5 min** (concept §7.2). Expired invites flip to `expired` via job or on read.
- Any config change bumps `config_version`; previous acceptances become invalid and invitees are re-prompted.
- Accepting requires the invitee to have conquered the region and be `activity_state = 'none'` at acceptance time
  (rechecked at start).

### Start
- Manual or auto-start when all accepted.
- Transaction locks all participant characters in ascending ID order, CASes each to `expedition`, escrows each one's
  consumables, snapshots all, runs one simulation with all heroes in the same combat.

### Reward distribution (provisional)
- XP: each participant gets XP per enemy killed × party XP factor / participants (factor provisional 1.2 for 2 players).
- Gold: equal split; remainder assigned deterministically by participant order.
- Loot: each drop assigned round-robin via the `loot` RNG stream; equipment drops can be restricted to "need" in later
  iterations.
- Distribution rules are part of the config (and thus `config_version`).

### Leaving mid-expedition
- Leaver: settled immediately as a solo cancellation at `now` (revealed encounters only).
- Remaining: `revision += 1`; re-simulate from `now` with remaining members (seed = hash(seed, revision)); new risk
  estimate is shown; settlement job for previous revision becomes a no-op (revision check).
- Optional preconfigured policy `cancelIfMemberLeaves: true` cancels for everyone instead.

## 2. Live coop

- A live party (max size **4**, *provisional*; POC validates 2) shares one instance (`participants[]`).
- All must be connected to start; joining requires each member in `none` state.
- Commands: travel/engage require leader *or* vote *(provisional: leader decides travel; any member can interact)*.
- Disconnection: 60 s grace *(provisional)*; character keeps fighting on automation; after grace → `left` (character
  exits the instance, run bag committed per normal rules — provisional).
- Rewards: kill XP shared as in idle; loot per-player personal rolls (avoids loot drama in coop) *(provisional)*.
- One cooperative live encounter in POC: Region 2 special encounter is designed to be clearly easier/better with two
  complementary builds.

## 3. Social minimum
- Friends: add by short code; accept/decline. No chat in POC (system messages only).
- Presence: online/offline + current activity, via WS for connected users.
