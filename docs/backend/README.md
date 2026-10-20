# PearlHub Backend Contract

This directory defines the framework-neutral domain/application contract for PearlHub v0.1. The existing HTTP adapter uses Hono; no framework types cross into domain or application services.

The Content API MVP vertical slice implements Draft creation/editing, atomic first publication, published-version reads, and owner work-copies. The API and PostgreSQL adapters are documented in [`../api/API-CONTRACT.md`](../api/API-CONTRACT.md) and the repository-root [`../../openapi.yaml`](../../openapi.yaml).

For local development and PostgreSQL setup, see [`DEV_ENVIRONMENT_SETUP.md`](DEV_ENVIRONMENT_SETUP.md).

## Documents

1. `01-domain-model.md` — domain entities and invariants
2. `02-postgresql-schema.md` — PostgreSQL schema and migration requirements
3. `03-repository-interfaces.md` — persistence and content-storage boundaries
4. `04-application-services.md` — use cases and transaction boundaries
5. `05-api-contract.md` — REST resource contract, independent of framework
6. `06-error-model.md` — error codes and HTTP mapping
7. `07-test-plan.md` — tests Copilot should generate and run

## Non-goals

Do not move HTTP framework dependencies into domain or application packages.

Do not add authentication-provider-specific code yet.

Do not add object-storage-provider-specific code yet.

Do not implement Playground execution yet.
