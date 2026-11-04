# Self-hosting for phone testing (Windows 10 + Docker Desktop + Cloudflare quick tunnel)

This guide runs the whole game (web app, API, live WebSocket and worker) from one Docker image on a Windows 10 PC
(for example a ROG Ally, x86_64) and exposes it to a phone through a Cloudflare quick tunnel
(`https://<random>.trycloudflare.com`). It is for private playtests, not production hosting: it does not choose a
provider and does not change [ADR-0016](../adr/0016-hosting.md). The generic container workflow is in
[container.md](container.md).

How it fits together:

```
phone browser --https--> Cloudflare edge --tunnel--> cloudflared (PC) --http--> 127.0.0.1:3000 (server container)
                                                                                  |-- web app (static, same origin)
                                                                                  |-- API + /auth/live WebSocket
                                                                                  '-- db container (127.0.0.1:5432)
```

The server serves the production web build on the same origin as the API and the WebSocket, so the client needs no
base URL and the `__Host-idle_session` cookie (`Secure; HttpOnly; SameSite=Strict`) stays first-party. TLS ends at
Cloudflare, so the server only sees plain HTTP and must be told which proxy it may trust (below).

## 1. Prerequisites

- Windows 10 22H2 (or newer) with virtualization enabled and **Docker Desktop** using the **WSL2** backend.
- **Git for Windows** (or Git inside a WSL distribution).
- **cloudflared**: `winget install --id Cloudflare.cloudflared` (then open a new terminal). No Cloudflare account is
  needed for quick tunnels.
- Keep the PC awake and plugged in while testing (sleep drops the tunnel). Docker Desktop must be running.
- The image is plain `linux/amd64` (`node:24-bookworm-slim`); nothing is architecture specific.

Commands below use PowerShell from the repository root unless noted.

## 2. Clone (line endings)

Set Git to keep LF line endings **before** cloning, or clone inside WSL:

```powershell
git config --global core.autocrlf input
git clone https://github.com/mcastrucci/idle-rpg-adventure.git
cd idle-rpg-adventure
```

Why this matters (checked against this repository, which stores every file with LF and has no shell scripts):

- SQL migrations: Drizzle hashes the raw file text, so the same migration with CRLF line endings has a different
  hash. A database migrated by an LF checkout is then refused by a CRLF build with `database migration version differs`,
  and the other way around. A single consistent CRLF checkout would still work, but switching setting or tools later
  breaks it.
- Compiled content: JSON content compiles to the identical `contentHash` with CRLF or LF (verified), so content is not
  affected.
- TypeScript sources and the Dockerfile are tolerated with CRLF, but there is no reason to keep them.

The repository also carries a `.gitattributes` (`* text=auto eol=lf`) that makes Git check files out with LF whatever
`core.autocrlf` says. If you cloned with `core.autocrlf=true` before that file reached your branch, delete the clone
and clone again after setting the option (a database migrated from the CRLF clone must then be recreated or restored
from a backup, see the migration note above).

## 3. Build, database and migrations

```powershell
docker compose build server
docker compose up -d db
docker compose --profile ops run --rm migrate
```

The first build downloads dependencies and compiles the web app and content bundle (several minutes). Migrations are
always an explicit step: re-run `migrate` after every update that adds one.

## 4. Start the tunnel, then the server

Start the quick tunnel in its own terminal and leave it running. Use the IPv4 address: the container port is
published on `127.0.0.1` only, and `localhost` can resolve to `::1` on Windows.

```powershell
cloudflared tunnel --url http://127.0.0.1:3000
```

cloudflared prints a line such as `https://quiet-river-1234.trycloudflare.com`. Put that origin into a `.env` file in
the repository root (Compose reads it automatically; `.env` is git-ignored and never copied into the image):

```
TRUST_PROXY=loopback,uniquelocal
ALLOWED_ORIGINS=https://quiet-river-1234.trycloudflare.com
```

Then start (or recreate) the server in the first terminal:

```powershell
docker compose up -d server
docker compose logs -f server      # wait for "server ready"
```

Open the `https://…trycloudflare.com` URL on the phone. The game creates a guest account on first visit.

What the two settings do (full contract in [engine/server-kit](../../engine/server-kit/README.md#reverse-proxy-and-web-hosting)):

| Setting | Effect |
|---|---|
| `ALLOWED_ORIGINS` | Comma-separated exact origins (`https://host[:port]`, no wildcard, no path) that the cookie same-origin check accepts in addition to the request's own origin. Applies to every HTTP mutation and the WebSocket upgrade. This alone is enough to make the game work through the tunnel. |
| `TRUST_PROXY` | Which peers may set `X-Forwarded-*` headers. With it, `request.protocol` becomes `https` behind the proxy and the per-IP rate limits see the real client address instead of one shared proxy address. |

`TRUST_PROXY` values: unset/`false` (default: ignore forwarded headers); a comma-separated list of IPs, CIDRs or
`loopback`/`linklocal`/`uniquelocal`; or `true` (trust every peer). With Docker Desktop the container sees cloudflared
as a private bridge address (on a Linux Docker host it is the `172.17.0.1` gateway), which is what
`loopback,uniquelocal` covers. If the 403 persists on Docker Desktop, rely on `ALLOWED_ORIGINS` alone first, then try
`TRUST_PROXY=true` knowing the caveat below.

### Security notes

- Enable `TRUST_PROXY` only when the server is reachable **solely** through a proxy you control. Otherwise any client
  can send `X-Forwarded-Proto: https` and forge its protocol and address. `true` additionally trusts the left-most
  `X-Forwarded-For` entry, which a client can forge through Cloudflare, so prefer the restricted list.
- Only list origins you control in `ALLOWED_ORIGINS`: a listed origin can make cookie-authenticated requests. Never use
  wildcards (they are rejected). The default without these variables remains strict same-origin.
- A quick tunnel is a **public** URL. Anyone who learns it can open the game and create guest accounts. Treat the URL
  as private, stop the tunnel when you are done, and do not enable debug tools on it unless you accept that.
- The database port is published on `127.0.0.1` only and is not part of the tunnel. The Compose credentials
  (`postgres`/`postgres`) are development defaults; change them if other people use the PC.

## 5. The URL changes on every tunnel restart

A quick tunnel gets a new random hostname each time `cloudflared` starts. After a restart:

1. Copy the new origin into `ALLOWED_ORIGINS` in `.env`.
2. `docker compose up -d server` (recreates the container with the new value).

Browser storage is per origin, so a new hostname is a new site: the phone starts a **new guest account** and the old
characters stay in the database but are unreachable from that device. For a stable address use a **named tunnel** with a
domain on your Cloudflare account (`cloudflared tunnel login`, `cloudflared tunnel create <name>`,
`cloudflared tunnel route dns <name> game.example.com`, and an ingress rule `service: http://127.0.0.1:3000`; see the
Cloudflare Tunnel documentation). Then `ALLOWED_ORIGINS=https://game.example.com` never changes and saved progress
survives restarts.

## 6. Optional: staging mode with debug tools

The debug tools (time travel, grants, progression) are off in the default Compose file and refuse to run in
production. Enable them only deliberately, with the staging overlay:

```powershell
docker compose -f compose.yaml -f compose.staging.yaml up -d server
```

The overlay sets `APP_ENV=staging`, `RPG_DEBUG_TOOLS=1` and `NODE_ENV=staging` (the image defaults to
`NODE_ENV=production`, which the debug guard refuses). Any authenticated account can use the debug routes, so only do
this while the tunnel URL is known to people you trust. Return to the safe default with
`docker compose up -d server` (without the overlay).

## 7. Backups

```powershell
docker compose exec -T db sh -c "pg_dump -U postgres -Fc idle_rpg > /tmp/idle_rpg.dump"
docker compose cp db:/tmp/idle_rpg.dump ./idle_rpg-backup.dump
```

(Do not redirect `pg_dump` output with PowerShell `>`; Windows PowerShell 5.1 re-encodes binary output.) `*.dump` is
git-ignored. Restore into an empty or existing database:

```powershell
docker compose cp ./idle_rpg-backup.dump db:/tmp/restore.dump
docker compose exec db pg_restore -U postgres -d idle_rpg --clean --if-exists /tmp/restore.dump
```

The data also lives in the `postgres-data` volume. `docker compose down` keeps it; `docker compose down -v` deletes it.

## 8. Updating

```powershell
# back up first (section 7)
git pull
docker compose build server
docker compose --profile ops run --rm migrate
docker compose up -d server
```

`index.html` is served with `no-cache` and the hashed bundles are immutable, so a refresh on the phone picks up the new
build. Keep the tunnel running; it does not need a restart (and keeps its URL).

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `403 {"error":"origin_forbidden"}` on sign-in, character actions or the live connection | The request's `Origin` is not accepted. Check that `ALLOWED_ORIGINS` is exactly the tunnel origin (https, no trailing slash, current hostname after a tunnel restart) and that you recreated the server after editing `.env` (`docker compose up -d server`, then `docker compose exec server printenv ALLOWED_ORIGINS`). Without `ALLOWED_ORIGINS`, `TRUST_PROXY` must include the proxy's address. |
| Server container restarts and `docker compose logs server` shows `Invalid server configuration: …` | A value failed validation: `ALLOWED_ORIGINS` entries must be `http(s)://host[:port]` without wildcards, paths or empty items; `TRUST_PROXY` must be `true`/`false` or a list of IPs, CIDRs and `loopback`/`linklocal`/`uniquelocal`. |
| Cloudflare error 1033/502 in the browser | cloudflared cannot reach the server. Check `docker compose ps` (server `healthy`), `curl http://127.0.0.1:3000/health/ready`, and that the tunnel uses `http://127.0.0.1:3000`. |
| Sign-in loops, the session cookie is never stored | The cookie is `__Host-…; Secure`, so browsers only keep it over HTTPS (or `localhost`). Open the `https://…trycloudflare.com` address, not `http://<LAN-IP>:3000` (the port is also bound to `127.0.0.1` only). |
| "Reconnecting" banner, WebSocket closes with 1006 | Almost always the same 403 on the upgrade (see the first row). Code `4409` means another tab or device holds the live session; it frees itself after about 30 seconds. If the network blocks QUIC, start cloudflared with `--protocol http2`. |
| `429` on `/auth/*` | Per-IP rate limit. Without `TRUST_PROXY` every phone shares the proxy's address and one bucket; enable it as shown above. |
| Everything worked yesterday but the phone shows a new empty character list | The tunnel hostname changed, so browser storage (device token) is new; see section 5. |
| `database migration version differs` | A different build or line-ending state than the one that migrated the database. Run the `migrate` step with the image you start, and see section 2. |
