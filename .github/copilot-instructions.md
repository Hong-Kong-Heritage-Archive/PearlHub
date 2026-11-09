# PearlHub — GitHub Copilot Instructions

## Project purpose and development method

PearlHub is an open, portable community hub for Pearls, Skills, Prompts and Knowledge. Use **Pearl** terminology.

Development uses **Incremental / Vertical-slice Delivery**. Backend, Frontend and Deployment move together for each feature. Do not use the old sequential plan of completing all Backend work before starting Frontend, Playground or Deployment.

For current catch-up work, read:

1. `docs/DEVELOPMENT-PLAN.md`
2. `docs/EXISTING-ARCHITECTURE-DESIGN.md`
3. `docs/HANDOFF-FRONTEND-DEPLOYMENT-CATCH-UP.md`
4. `openapi.yaml`
5. Relevant READMEs and source files.

Task-specific Copilot prompt: `.github/prompts/pearlhub-frontend-deployment-catch-up.prompt.md`.

## Current architecture — frozen

- Backend: TypeScript + Hono.
- API contract: OpenAPI 3.1.
- Layers: Hono HTTP adapter → Application → Domain → Repository Ports → Infrastructure adapters.
- Persistence: PostgreSQL with direct `pg` adapters and ordered SQL migrations.
- Frontend: Next.js 16 App Router + React 19 + TypeScript in `web/`.
- Confirmed cloud direction: Firebase Authentication + Cloud SQL for PostgreSQL + Cloud Run backend.
- CI: GitHub Actions; no ORM/query builder currently used.

Historical planning documents that say framework selection is deferred are superseded by the checked-in Hono implementation and later frozen references.

## Layering rules

- Hono owns HTTP routing, validation, middleware and response mapping.
- Application owns use cases, authorization orchestration and transaction boundaries.
- Domain owns business rules and invariants.
- Repository Ports define provider-neutral boundaries.
- Infrastructure owns PostgreSQL, Firebase token verification, GitHub source access and content-storage adapters.
- Runtime/composition code wires concrete implementations.
- Domain and Application must not import Hono, Firebase SDK, PostgreSQL, Cloud Run, OpenAPI runtime code or Gemini SDKs.
- Do not put business logic in route handlers or frontend components; do not access PostgreSQL directly from HTTP handlers.

## Frozen product and domain decisions

- Artifact `id`, `name`, `slug` and owner are immutable; slug uniqueness is owner-scoped.
- Visibility: `private`, `unlisted`, `public`; lifecycle status: `active`, `tombstone`.
- Tombstone is unlisted and preserves immutable snapshots/history; never physically delete an Artifact.
- Published Artifact Versions are immutable SemVer 2.x.
- Fork creates permanent PearlHub lineage; Clone creates no lineage.
- GitHub import records provenance, not lineage.
- Dependencies use SemVer ranges; resolution records exact Artifact Versions and immutable run manifests.
- Compatibility reports point to an exact source Artifact Version.
- Dependency/compatibility reads enforce current-access-aware redaction.
- MVP excludes Merge, Branch and executable scripts.
- Playground uses the user's own Gemini API key; PearlHub must not store it.

## Persistence and migration rules

- Use existing repository ports, PostgreSQL adapters, `pg` and transaction manager.
- Do not add an ORM or query builder without an explicit ADR.
- Migrations 001–009 are applied history. Never edit them; add a new numbered forward-only migration for an approved schema change.
- Keep migration checksums and schema-current validation intact.
- Do not expose SQL, Pool, PoolClient or PostgreSQL-specific errors outside Infrastructure.
- Preserve complete snapshots, immutability, lineage and dependency target integrity.
- Do not assume `MemoryArtifactContentStore` is durable production storage.

## Authentication and security

- Internal PearlHub `users.id` is authoritative.
- External identities map by `(provider, subject)` through `user_identities`.
- Never trust client-supplied owner IDs or auto-link accounts by matching email.
- Never infer a provider for legacy `users.external_subject` values.
- Current server uses development fake authentication and explicitly refuses production startup. Do not remove this fail-closed guard until a real production authenticator exists and is tested.
- Firebase provider-specific verification belongs in an Infrastructure adapter.
- Never commit credentials, ID tokens, API keys or service-account keys; do not log bearer tokens or secrets.
- Redaction is a security boundary; do not expose hidden target-derived data.

## Frontend and deployment rules

- Extend the existing Next.js UI; do not replace it.
- Keep frontend API types and behaviour aligned with `openapi.yaml`.
- Implement loading, empty, validation, error, permission and redaction states.
- Firebase client configuration is public config only; never put server secrets in `NEXT_PUBLIC_*`.
- Confirm GCP project/resource access before provisioning or deploying.
- Keep Cloud Run and Cloud SQL details in deployment/Infrastructure layers.
- Use explicit migration/release steps; do not run migrations concurrently at every app startup.
- Inspect Next.js SSR requirements before choosing frontend hosting.

## Testing and delivery

- Add Domain/Application tests for invariants and use cases.
- Add PostgreSQL integration tests for persistence and transactions.
- Add HTTP/contract tests for API changes.
- Add frontend tests for user-visible behaviour and redaction.
- Keep OpenAPI, Hono runtime schemas, frontend types and docs synchronized.
- Run relevant backend and frontend checks after each slice.
- Update `docs/DEVELOPMENT-PLAN.md` after accepted vertical slices.
- A feature is not Done until Backend/API, Frontend, Deployment impact, tests, security review and documentation are addressed.

## Copilot working style

1. Inspect current code and git status before editing.
2. Read relevant design and contract documents.
3. State the proposed small change and exact files before broad edits.
4. Preserve existing architecture and conventions; do not silently alter frozen decisions.
5. Do not invent endpoints, cloud resources, secrets or configuration values.
6. If cloud settings/access are unknown, record blockers and continue only with independently verifiable local work.
7. Report changed files, tests run, results, risks and the next increment.
