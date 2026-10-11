# Development Environment Setup

PearlHub's development backend runs on the host with Node.js. Docker Compose is only for external development dependencies; it does not build or run the backend.

## Prerequisites

- Node.js 20 or newer and npm
- Docker Desktop or Docker Engine with the Docker Compose plugin

## Configure local environment

From the repository root, create the local environment file:

```sh
sh scripts/setup-env.sh
```

The script creates `.env` from `.env.example` and does not overwrite an existing `.env`. These values are for local development only; do not reuse them outside your machine.

Load the variables into the current terminal before running Compose, migrations, or integration tests:

```sh
set -a && . ./.env && set +a
```

`DATABASE_URL` is the backend's local PostgreSQL connection string. `TEST_DATABASE_URL` currently points at the same local database; the integration test creates and removes its own randomly named schema, so it does not drop or overwrite the development schema.

## Start PostgreSQL

```sh
docker compose up -d postgres
docker compose ps
```

PostgreSQL is available at `localhost:54329` by default. The port, database, username, and password can be changed in `.env`. Compose persists data in the `pearlhub-postgres-data` volume.

## Initialize the database

For a **fresh, empty** local database, apply all forward-only migrations once, in order, after PostgreSQL is healthy:

```sh
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" < migrations/001_initial.sql &&
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" < migrations/002_persistence_hardening.sql &&
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" < migrations/003_identity_mapping_and_tombstone_snapshots.sql
```

Do not run this sequence against a database that already has PearlHub tables, or
reapply a migration that has already run. The migrations are not a repeatable
initialization script. For an existing database, confirm its migration history and
apply only unapplied migrations in order; if its state is unknown, use a fresh local
database/volume instead. The PostgreSQL integration suite uses its own random schema
and applies all three migrations itself.

## Run backend checks locally

Install dependencies and run the compiler and unit/application/contract tests directly on the host:

```sh
npm install
npm run build
npm run test:unit
```

Run the PostgreSQL integration test against the local Compose database:

```sh
npm run test:integration
```

The integration test is skipped when `TEST_DATABASE_URL` is unset. It creates a dedicated temporary schema in the configured database and removes only that schema on completion.

The frozen architecture selects Hono for HTTP, OpenAPI 3.1 for the API contract, and a
standard OCI container on Google Cloud Run. Firebase Authentication is one
Infrastructure identity provider; provider-specific verification belongs there. These
are architectural decisions, not claims that those components are implemented. This
repository does not yet contain a Hono adapter or backend server entrypoint, so there
is no long-running API process to start. Backend source and tests are executed locally
with npm as described above.

## Stop PostgreSQL

Stop the container while preserving database data:

```sh
docker compose down
```

To delete the local database volume and all persisted development data:

```sh
docker compose down -v
```