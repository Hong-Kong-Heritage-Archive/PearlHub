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

Apply the initial schema after PostgreSQL is healthy:

```sh
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < migrations/001_initial.sql
```

The migration is forward-only. Do not reapply it to a database where its tables already exist; use a fresh local database/volume for a clean initialization.

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

This repository currently has no HTTP framework, route adapter, or backend server entrypoint. Therefore there is not yet a long-running API process to start; backend source and tests are executed locally with npm as described above. Framework selection remains intentionally deferred.

## Stop PostgreSQL

Stop the container while preserving database data:

```sh
docker compose down
```

To delete the local database volume and all persisted development data:

```sh
docker compose down -v
```