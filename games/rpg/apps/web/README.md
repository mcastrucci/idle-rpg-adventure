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

Vite proxies `/auth` (including the `/auth/live` WebSocket), `/characters`, `/content` and `/health` to
`RPG_SERVER_URL` (default `http://127.0.0.1:3000`). The proxy keeps the browser's `Host` (`changeOrigin: false`) so the
server's same-origin check passes, and the server's `__Host-` session cookie stays first-party. Open the app on
`http://localhost` (not a LAN IP): browsers accept `Secure` cookies over plain HTTP only on localhost. For a phone on the
LAN, serve the app over HTTPS behind the same origin as the API.

Other scripts: `pnpm --filter @rpg/web build` (production bundle in `dist/`), `pnpm --filter @rpg/web typecheck`,
`pnpm vitest run --project @rpg/web`.

## Structure

| Path | Role |
|---|---|
| `src/api/http.ts` | Typed `ApiClient` over the real routes (`/auth/*`, `/characters`, `/content`); `ApiError` vs `NetworkError`. |
| `src/api/auth.ts` | Device token (32 CSPRNG bytes, base64url) in `localStorage`; `ensureSession` reuses the cookie session or logs in as the device guest. |
| `src/api/commands.ts` | Command envelopes (`command_id` UUID generated once per intent, validated by `@rpg/protocol`) and `sendCommand` with safe retries. |
| `src/live/state.ts` | Pure reconnect state machine for `/auth/live`. |
| `src/live/client.ts` | `LiveClient`: socket driver, `authenticated` ack, ping/pong liveness, backoff reconnects, online/offline hooks. |
| `src/app/*` | Shell: header, connection banner, bottom tab bar with hash routing, session bootstrap. |
| `src/screens/*` | Character (create/view), automation rules editor (`#/character/rules`), placeholder tabs. |
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

## Known gaps (server side, tracked as findings of #33)

- No response DTOs in `@rpg/protocol`: `src/api/types.ts` mirrors the server's current shapes.
- No resume token or server push over `/auth/live`: reconnects restore liveness, and missed state is re-read over HTTP.
- WS `{ type: 'error' }` frames carry no `command_id`, so they cannot be matched to a command. The shell therefore sends
  commands over HTTP.
- No client content endpoint (`GET /content` is metadata only): no skill/item names, no XP curve (XP bar is a
  placeholder), no world graph.
- No ledger (gold placeholder), inventory, or expedition hosting (chip reads the actor's `activityState` only).
- No sign-in UI yet. An upgraded account's device token is disabled server-side, so this device then shows a fatal
  connection state.
