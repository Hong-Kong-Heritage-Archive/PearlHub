# Development Environment Setup

PearlHub's development backend runs on the host with Node.js. Docker Compose is only for external development dependencies; it does not build or run the backend.

The canonical OpenAPI 3.1 contract is [the repository-root `openapi.yaml`](../../openapi.yaml).
When the server is running, its runtime-generated representation is available at
`http://localhost:8080/openapi.json`; it includes only registered runtime routes.

## Prerequisites

- Node.js 20 or newer and npm
- Docker Desktop or Docker Engine with the Docker Compose plugin

## Configure local environment

From the repository root, create the local environment file:

```sh
sh scripts/setup-env.sh
```

The script creates `.env` from `.env.example` and does not overwrite an existing `.env`. These values are for local development only; do not reuse them outside your machine.
If you already have `.env`, add the new test-database and development-authentication
variables from `.env.example` manually; the setup script deliberately preserves it.

Load the variables into the current terminal before running Compose, migrations, or integration tests:

```sh
set -a && . ./.env && set +a
```

`DATABASE_URL` is the backend's local PostgreSQL connection string. `TEST_DATABASE_URL` must point to a separate disposable database whose name ends in `_test`; the integration suite refuses to run against the configured application database and removes only its randomly named schema.

## Start PostgreSQL

```sh
docker compose up -d postgres
docker compose ps
```

PostgreSQL is available at `localhost:54329` by default. The port, database, username, and password can be changed in `.env`. Compose persists data in the `pearlhub-postgres-data` volume.

Create the dedicated test database once:

```sh
docker compose exec -T postgres createdb -U "$POSTGRES_USER" pearlhub_test
```

## Migrate the application database

`npm run db:migrate` applies ordered SQL files transactionally and records each
filename and SHA-256 checksum in `schema_migrations`. Running it again is safe; it
does not reapply completed migrations, and it fails if an already-applied migration
has changed.

```sh
npm run db:migrate
```

This command uses `DATABASE_URL`, not `TEST_DATABASE_URL`. Run it only against a
database intended for PearlHub and after confirming its state. The checked-in
migrations may have been run manually without a ledger. Do not run normal migration
mode against that database. After verifying its migration history and taking a
backup, the explicit baseline command checks for all final-schema tables, selected
columns, and invariant triggers before recording the migration checksums without
rerunning SQL:

```sh
npm run db:migrate:baseline
```

Baseline mode never changes application rows, but it trusts the operator's
confirmation that the full checked-in migration set was previously applied. If the
schema or history is uncertain, use a fresh local database instead.

## Run backend checks locally

Install dependencies and run the compiler and unit/application/contract tests directly on the host:

```sh
npm install
npm run build
npm run test:unit
```

Run the PostgreSQL integration suite against the separate `pearlhub_test` database:

```sh
npm run test:integration
```

The command fails with an actionable error when `TEST_DATABASE_URL` is missing,
does not identify a database ending in `_test`, or points to the same database as
`DATABASE_URL`. It creates a random schema inside the dedicated test database,
applies all migrations twice to verify repeat safety, then removes only that test
schema on completion.

## Run the API locally

The local server requires a migrated database and explicitly opted-in development
authentication. Provision the configured internal user once in the migrated
application database:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO users (id) VALUES ('00000000-0000-4000-8000-000000000001') ON CONFLICT (id) DO NOTHING"
```

Keep `PEARLHUB_AUTH_MODE=development-fake` and `DEV_AUTH_TOKEN` local-only. The
development authenticator uses `DEV_AUTH_USER_ID` as the internal owner ID. The
server refuses to start in production because production authentication is not
implemented; it never enables fake authentication as a production fallback.

```sh
npm run build
npm start
```

The local endpoint is `http://localhost:8080/api/v1/artifacts`; pass
`Authorization: Bearer $DEV_AUTH_TOKEN`. The OpenAPI 3.1 document is available at
`/openapi.json`. Runtime configuration uses `DATABASE_URL`, `PORT`,
`PEARLHUB_AUTH_MODE`, `DEV_AUTH_USER_ID`, and `DEV_AUTH_TOKEN`. Connection settings
are never logged.

Firebase Authentication remains a future provider adapter; the route receives only
the provider-neutral verified internal user ID.

## Stop PostgreSQL

Stop the container while preserving database data:

```sh
docker compose down
```

To delete the local database volume and all persisted development data:

```sh
docker compose down -v
```