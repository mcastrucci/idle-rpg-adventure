# @rpg/web

Mobile-first React + Vite client shell for the RPG (issue #33, `docs/spec/ui-mobile.md` §1). The client renders server
state and sends commands; it contains no game logic and must never import simulator packages (ADR-0002/0003,
enforced by lint). The scene renderer (ADR-0010) is not part of this shell.

## Run web + server locally

The server needs PostgreSQL and a compiled content bundle (see [the server README](../server/README.md)). From the
repository root:

```sh
pnpm install
pnpm content-cli build games/rpg/content --game ./games/rpg/tools/content-plugin/src/index.ts --out dist/rpg-content.json
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/idle_rpg
export CONTENT_BUNDLE_PATH="$PWD/dist/rpg-content.json"
pnpm --filter @rpg/server db:migrate
pnpm --filter @rpg/server start          # api,live,worker roles on http://127.0.0.1:3000

# second terminal
pnpm --filter @rpg/web dev               # http://localhost:5173
```

Vite proxies `/auth` (including the `/auth/live` WebSocket), `/characters`, `/content`, `/expeditions` and `/health` to
`RPG_SERVER_URL` (default `http://127.0.0.1:3000`). The proxy keeps the browser's `Host` (`changeOrigin: false`) so the
server's same-origin check passes, and the server's `__Host-` session cookie stays first-party. Open the app on
`http://localhost` (not a LAN IP): browsers accept `Secure` cookies over plain HTTP only on localhost. For a phone on the
LAN, serve the app over HTTPS behind the same origin as the API.

Other scripts: `pnpm --filter @rpg/web build` (production bundle in `dist/`), `pnpm --filter @rpg/web typecheck`,
`pnpm vitest run --project @rpg/web`.

## Structure

| Path | Role |
|---|---|
| `src/api/http.ts` | Typed `ApiClient` over the real routes (`/auth/*`, `/characters`, `/content`, `/expeditions/*`); `ApiError` vs `NetworkError`. |
| `src/api/auth.ts` | Device token (32 CSPRNG bytes, base64url) in `localStorage`; `ensureSession` reuses the cookie session or logs in as the device guest. |
| `src/api/commands.ts` | Command envelopes (`command_id` UUID generated once per intent, validated by `@rpg/protocol`) and `sendCommand` with safe retries. |
| `src/live/state.ts` | Pure reconnect state machine for `/auth/live`. |
| `src/live/client.ts` | `LiveClient`: socket driver, `authenticated` ack, ping/pong liveness, backoff reconnects, online/offline hooks. |
| `src/app/*` | Shell: header, connection banner, bottom tab bar with hash routing, session bootstrap. |
| `src/screens/*` | Character (create, attributes, derived stats, loadout editor), automation rules editor (`#/character/rules`), expedition lifecycle, placeholder tabs. |
| `src/character/*` | Character screen logic (#34): derived stat rows over `@rpg/rpg-stats`, XP progress, loadout draft/conflicts/presets, point allocation. |
| `src/rules/*` | Rules editor logic (#36): closed condition/target catalog, `describeRule` summaries, draft operations, client validation, Bulwark/Thornblade presets. |
| `src/content/labels.ts` | Display labels derived from stable content IDs until a client content endpoint exists. |

## Contracts with the server

- **Auth.** HTTP and WS authenticate with the HttpOnly `__Host-idle_session` cookie set by `POST /auth/guest`. The
  client never stores the session token (WebSocket upgrades cannot carry an `Authorization` header in browsers). Before
  every live (re)connect the client re-checks `GET /auth/session` and renews through the device guest login, because a
  rejected upgrade is only visible to the browser as close code 1006.
- **Commands.** Each user intent builds one envelope `{ command_id, operation, payload }`. `sendCommand` re-sends the
  *same* envelope after network errors and 408/429/5xx (statuses where the server committed nothing). Every other
  status is final, including `409 command_id_conflict` and `410 command_expired`; an expired id is never replaced with a
  new one automatically. After the retry budget the caller gets `CommandUnconfirmedError` holding the original request,
  and the UI offers "Retry" with the same `command_id`. Commands wait while the live socket is down, and command
  buttons are disabled.
- **Expeditions.** The Expeditions tab reads server options and expedition DTOs, starts and cancels through commands,
  and refreshes the character after settlement. The header chip reflects the character's server-provided activity.
- **Inventory sales.** The Merchant tab keeps existing purchases and shows material sales only when `/merchant` supplies
  `sellOffers`; only cataloged material stacks in the safe inventory container appear. Sale prices, command outcomes,
  gold, and refreshed holdings come from the server.
- **Expedition setup (#53).** Area → activity → duration chips → consumable → retreat → automation rules preview (link
  to `#/character/rules`) → estimate card → Start. The estimate card shows the server's Monte Carlo figures
  (`POST /characters/:actorId/expedition-estimate`, `ExpeditionEstimateDto` from `@rpg/protocol`): XP and gold as
  "median (p10–p90)", consumables used, death and retreat chance, the run count, and an "Estimate" badge; the client
  computes nothing from game rules. Requests are debounced (400 ms after the last change), stale answers are dropped,
  and errors offer a retry; the estimate refreshes when the character version changes (e.g. edited rules). "Repeat last
  expedition" starts the last *started* request/config with one tap; it is a per-device convenience stored in
  localStorage per character (guarded; the screen works without storage) and is disabled with a reason when the area,
  duration or consumables are no longer available.
- **Live socket.** The client waits for `{ type: 'authenticated' }` before treating the connection as open (frames
  sent earlier would be closed with 1008 by the server). It pings every 15 s (the server answers `pong` and renews the
  lease) and drops the socket after 10 s without an inbound frame. Reconnects use exponential backoff with jitter
  (1 s → 30 s). `4409` (another live connection holds the lease, e.g. a stale lease after network loss, which expires
  after 30 s) and `4401` (session revoked/expired) are retried, with the session renewed first. A 4xx from the session
  renewal (for example `guest_credential_disabled` after an email upgrade) stops reconnecting and shows a Retry action.

## Automation rules editor (#36)

`#/character/rules` edits the ordered rule list (`docs/spec/combat-engine.md` §6). Pickers are built from the closed
sets in `@rpg/rpg-schema` (a shared schema package, not a simulator, so ADR-0003 allows it); `skillReady`/`useSkill`
offer only `basic_attack` plus the loadout. Save is enabled only when the draft differs from the server's rules, passes
`AutomationRulesSchema` plus the server's reproducible checks (equipped skills, known consumables, selector fits the
skill), and the live socket is open. It sends one `character.configure` command with `{ automationRules }` to
`PATCH /characters/:actorId/configuration`; the screen then shows the character the server returned. Presets are the
reference rule sets of `docs/design/region-1.md` §4.3, disabled with a reason when their skills are not equipped.

Without a content endpoint, skill targeting and the consumable list are mirrored from Region 1 content in
`src/rules/catalog.ts`. Consumables found in the server's saved rules are trusted too. The server stays the authority.

## Character screen (#34)

`#/character` shows level and XP progress, attributes, derived stats and the skill loadout. Derived stats come from
`deriveStats` in `@rpg/rpg-stats` with `DEFAULT_STAT_FORMULAS` (shared, display only; ADR-0003 allows it, and it pulls
no simulator package). Each stat carries a one-line explanation generated from the formula table. Without an
inventory the stats are shown without gear.

- **Loadout.** Four provisional slots (open decision #13) plus the always-equipped basic attack. Picking a skill that
  sits in another slot swaps the two. Save sends one `character.configure` command with `{ skillLoadout }` (the
  `command_id` survives retries; "Retry save" re-sends the same envelope) and is disabled while disconnected or
  outside the Sanctuary. The server validates the saved rules against the new loadout in the same update, so when a
  saved rule names a skill the draft drops, Save is disabled and a warning lists those rules with two ways out:
  open the rules editor, or "Save and remove N rules" (one command with `{ skillLoadout, automationRules }`).
- **Presets.** Bulwark / Thornblade loadouts from `docs/design/region-1.md` §4.2 fill the draft. A preset whose
  skills are not unlocked is disabled with the reason (today: Thornblade).
- **Attributes.** The server accepts only additive spending of earned points (`allocate`), never a respec, so
  attribute presets are not offered. When `unspentPoints > 0`, steppers preview the stat change and "Spend N points"
  sends `{ allocate }`.

## Known gaps (server side, tracked as findings of #33)

- No response DTOs in `@rpg/protocol`: `src/api/types.ts` mirrors the server's current shapes.
- No resume token or server push over `/auth/live`: reconnects restore liveness, and missed state is re-read over HTTP.
- WS `{ type: 'error' }` frames carry no `command_id`, so they cannot be matched to a command. The shell therefore sends
  commands over HTTP.
- No client content endpoint (`GET /content` is metadata only): no skill/item names and no world graph. The XP curve
  (`src/character/progression.ts`) and the hero skill list (`src/rules/catalog.ts`) are mirrored from content and
  pinned to the content files by tests; the XP bar falls back to raw XP if the server's level does not fit the curve.
- No unlock endpoint: the client mirrors the server's provisional unlocked set (the four starter skills) and treats
  skills already in the saved loadout as unlocked. The server remains the authority (`invalid_configuration`).
- No progression yet: `unspentPoints` is always 0, so the allocation UI only appears once levelling grants points.
- No gold balance in the character DTO (gold is shown from inventory holdings). Expedition hosting and settlement are available
  in the Expeditions tab; the header chip reads the actor's server-provided `activityState`.
- No sign-in UI yet. An upgraded account's device token is disabled server-side, so this device then shows a fatal
  connection state.

## World map touch evidence (#68)

Opt-in browser evidence that the world map (`@engine/client-kit` `WorldMap`, integrated in #98) works at 360 px width
with touch pan/zoom. It is **not** part of `pnpm check` and needs Playwright + Chromium on the machine (they are
deliberately not repository dependencies). Harness: the real production build of this app (`vite preview`, which reuses
the dev proxy table) against a real local server and PostgreSQL, so the evaluated world comes from the real
`GET /characters/:actorId/world` with real Region 1/2 content. A character is created through the UI; the debug tool
`debug.recordWorldProgress` completes `area:region_1` (the debug route is not in the Vite proxy, so the script calls the
server origin directly; cookies are host-scoped, not port-scoped).

```sh
pg_isready -h 127.0.0.1 || pg_ctlcluster 16 main start
createdb -h 127.0.0.1 -U postgres idle_rpg_touch          # or any empty database
pnpm content-cli build games/rpg/content --game ./games/rpg/tools/content-plugin/src/index.ts --out dist/rpg-content.json
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/idle_rpg_touch CONTENT_BUNDLE_PATH="$PWD/dist/rpg-content.json"
pnpm --filter @rpg/server db:migrate
RPG_DEBUG_TOOLS=1 APP_ENV=test pnpm --filter @rpg/server start &     # http://127.0.0.1:3000
pnpm --filter @rpg/web build
pnpm --filter @rpg/web exec vite preview --port 4173 --strictPort --host 127.0.0.1 &
OUT_DIR=/some/dir node games/rpg/apps/web/scripts/world-map-touch-evidence.mjs   # BASE_URL / SERVER_URL override the defaults
```

Environment: Chromium (Playwright), viewport 360x740, `deviceScaleFactor: 2`, `hasTouch`, `isMobile`. Gestures are raw
CDP `Input.dispatchTouchEvent` (one finger for pan/tap, two fingers for pinch). Scale limits are read from
`MIN_MAP_SCALE` / `MAX_MAP_SCALE` in `engine/client-kit/src/world-map-layout.ts` (0.7 / 2.6). Screenshots go to `OUT_DIR`.

| Check | Result (2026-11-04) |
|---|---|
| No horizontal page overflow (fresh and Region-1-complete character) | scrollWidth 360 = innerWidth 360 |
| Single-finger drag pans the map (scale unchanged) | viewport (0,0) -> (197.4,-131.6) |
| Pinch-out (2x finger spread) zooms in | scale 1.00 -> 2.00 |
| Pinch-out clamps at documented max | 2.60 |
| Pinch-in clamps at documented min | 0.70 |
| Pinch does not zoom the browser page | `visualViewport.scale` 1 |
| Every area node reachable by touch panning at max zoom (4 nodes: Sanctuary, Verdant Hollow, Region 2, Test Grove) | 4/4, 2-3 drags each (at the initial fit all 4 are already in view) |
| Node hit areas >= 44x44 CSS px at min, initial and max zoom | 44.00 px smallest |
| Zoom controls and detail-sheet buttons >= 44x44 CSS px | 44.00 px smallest |
| Tap on an area opens its detail sheet; close button dismisses it by touch | pass |
| Locked area (Region 2 for a fresh character) shows "Locked" and its reason ("Conquer the preceding area first."), enter action disabled; dismissible by touch | pass |

Observation (not gating): at the initial fit the three node labels around the Sanctuary overlap each other ("Sanctuary" /
"The Verdant Hollow" / "Test Grove" are drawn on top of one another because the authored positions are about 64 CSS px
apart at 360 px width). Zooming in separates them.

Limitation: this is emulated touch in desktop Chromium. It is not real-device acceptance (no iOS Safari, no Android
WebView, no real multi-touch hardware, no OS gesture or safe-area behaviour); #68 still needs a manual pass on devices.
