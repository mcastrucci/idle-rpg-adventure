# Local RPG server container

This is a repeatable local setup for the long-lived RPG API, authenticated live WebSocket and worker roles with PostgreSQL 16. The image builds the authored RPG content bundle and includes workspace TypeScript packages and the engine/RPG migration files. The image also builds the production web app (`@rpg/web`) and the server serves it on the same origin as the API and WebSocket (`WEB_DIST_DIR`, set by the image), so `http://127.0.0.1:3000/` opens the game. Unset `WEB_DIST_DIR` for an API-only container. For phone testing through a TLS tunnel see [self-host-tunnel.md](self-host-tunnel.md).

Requirements: Docker Engine with the Compose plugin. Run these commands from the repository root:

```sh
docker compose build server
docker compose up -d db
docker compose --profile ops run --rm migrate
docker compose up -d server
docker compose ps
docker compose logs -f server
```

Optional environment passed through from your shell or a `.env` file (all empty by default, which keeps the strict same-origin behavior): `TRUST_PROXY` (which peers may set `X-Forwarded-*`) and `ALLOWED_ORIGINS` (extra exact origins, comma-separated). They are only needed behind a TLS-terminating proxy or tunnel; see [self-host-tunnel.md](self-host-tunnel.md). Debug tools stay disabled unless you deliberately add the staging overlay: `docker compose -f compose.yaml -f compose.staging.yaml up -d server`.

The migration command uses the same image as the server and exits nonzero if migration application or journal verification fails. Run it explicitly after building and before starting a server against a new or upgraded database. Server boot verifies migrations but does not apply them. The Compose health check waits on `/health/ready`; the app listens on `http://127.0.0.1:3000` from the host.

For web client development with hot reload, run it separately in another terminal (Vite proxies API and WebSocket paths to the server):

```sh
pnpm --filter @rpg/web dev
```

Stop app containers and PostgreSQL while retaining database data:

```sh
docker compose down
```

The named `postgres-data` volume remains. Do not add `--volumes`/`-v` if you want to keep local data. To resume, run the database, explicit migration and server startup commands above. Local Compose credentials are only for development; choose deployment secrets and database access settings separately before any hosted deployment.
