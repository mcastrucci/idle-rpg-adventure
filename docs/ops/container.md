# Local RPG server container

This is a repeatable local setup for the long-lived RPG API, authenticated live WebSocket and worker roles with PostgreSQL 16. The image builds the authored RPG content bundle and includes workspace TypeScript packages and the engine/RPG migration files. The static web app remains a separate development process; this container does not build or host it.

Requirements: Docker Engine with the Compose plugin. Run these commands from the repository root:

```sh
docker compose build server
docker compose up -d db
docker compose --profile ops run --rm migrate
docker compose up -d server
docker compose ps
docker compose logs -f server
```

The migration command uses the same image as the server and exits nonzero if migration application or journal verification fails. Run it explicitly after building and before starting a server against a new or upgraded database. Server boot verifies migrations but does not apply them. The Compose health check waits on `/health/ready`; the app listens on `http://127.0.0.1:3000` from the host.

Run the web client separately in another terminal:

```sh
pnpm --filter @rpg/web dev
```

Stop app containers and PostgreSQL while retaining database data:

```sh
docker compose down
```

The named `postgres-data` volume remains. Do not add `--volumes`/`-v` if you want to keep local data. To resume, run the database, explicit migration and server startup commands above. Local Compose credentials are only for development; choose deployment secrets and database access settings separately before any hosted deployment.
