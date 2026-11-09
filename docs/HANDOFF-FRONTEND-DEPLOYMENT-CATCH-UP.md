# PearlHub — Frontend & Deployment Catch-up Handoff

**Prepared:** 2026-11-08  
**Repository:** [Hong-Kong-Heritage-Archive/PearlHub](https://github.com/Hong-Kong-Heritage-Archive/PearlHub)  
**Branch:** `main`  
**Reviewed HEAD:** `7547bdb594f3263b42e4a6e4f9b4efa28e52f9d9`

> Start the next development chat from this handoff. First verify current HEAD because this SHA may have moved.

## 1. Next chat objective

Catch the existing Frontend and Deployment up with current Backend capabilities using **Incremental / Vertical-slice Development**.

Do not return to the old sequential approach (Backend first, then Frontend, Playground and Deployment). Do not regenerate or rewrite the backend. Every increment considers API, UI, deployment/configuration, tests and documentation together.

Read first: `docs/DEVELOPMENT-PLAN.md`, `docs/EXISTING-ARCHITECTURE-DESIGN.md`, `openapi.yaml`, `web/README.md`, `.github/copilot-instructions.md` and `.github/prompts/pearlhub-frontend-deployment-catch-up.prompt.md`.

## 2. Current baseline

Backend already includes:
- TypeScript + Hono + OpenAPI 3.1; Domain / Application / Ports / PostgreSQL adapter separation.
- PostgreSQL migrations 001–009, checksum validation and migration-current startup check.
- Draft create/edit/discard, atomic first publication and work-copy.
- Immutable Version reads, visibility update and Artifact tombstone.
- Fork / Clone Draft workflows, lineage reads and GitHub raw import provenance.
- Keyword/tag discovery, cursor pagination and discovery-index rebuild.
- Dependency declarations, dependency resolution service and immutable resolution manifests.
- Version dependency and compatibility-report read APIs with access-aware redaction.
- Unit/application/contract/HTTP/PostgreSQL integration tests.

Frontend already includes:
- Next.js 16 App Router + React 19 + TypeScript.
- Discovery/search/tag filters/sort/cursor; Draft create/edit/preview/publish.
- Knowledge-file/dependency declaration editing; Version list/detail.
- Fork/Clone, import/provenance, visibility editor, My Drafts, work-copy, Draft discard and Artifact tombstone.
- Loading/empty/error/retry states and frontend tests.

Deployment foundations: local PostgreSQL 16 in `compose.yaml`, `.env.example`, `scripts/setup-env.sh`, ordered SQL migrations and GitHub Actions CI. Production GCP deployment is not evidenced in the repository.

## 3. Critical implementation facts

### Dependency resolver vs HTTP API

`ResolveSourceVersionDependenciesService` exists and is wired into the runtime object, but there is no dedicated public HTTP route to trigger resolution. Do not invent one. The existing Version dependency GET route is read-only.

### Dependency / compatibility API contract

- Dependency response includes `resolutionState: none | available | redacted`.
- Compatibility response includes `availability: available | redacted`.
- Redacted responses must not expose hidden target Version IDs or report payloads.
- These fields are required contract semantics in the approved `/api/v1` response shape.

### Authentication

- `Authenticator` currently returns an internal PearlHub `userId`.
- `src/server.ts` configures development fake authentication and explicitly refuses `NODE_ENV=production`.
- Frontend auth is a temporary developer-only in-memory bearer-token field.
- `user_identities(provider, subject)` exists and maps external identity to internal `users.id`.
- Firebase Authentication is the confirmed direction, but Firebase token verification and frontend sign-in are not implemented.
- Legacy `users.external_subject` values have no inferred provider. Never auto-map by email or guessed Firebase UID.

Do not remove the production fail-closed guard until a real production authenticator is implemented and tested.

### Content persistence

- New Draft and complete published-Version snapshots are PostgreSQL-backed.
- `MemoryArtifactContentStore` is process-local, not durable production object storage.
- Legacy Version content may be unavailable; preserve documented behaviour rather than fabricate content.
- Migrations 001–009 are applied history. Never edit them; use forward-only numbered migrations for approved changes.

## 4. Confirmed GCP direction and access checks

Confirmed target: Firebase Authentication, Cloud SQL for PostgreSQL, and Cloud Run for the Hono backend.

Still verify; do not assume provisioned:
- GCP project ID and project access.
- IAM roles / service-account permissions.
- Firebase project and enabled sign-in provider(s).
- Cloud SQL instance, region, network/connectivity and authentication method.
- Artifact Registry access and Cloud Run deployment permissions.
- Next.js production hosting decision and permissions.

Never invent project IDs, resource names, URLs, regions, service accounts or access status. Never commit credentials, tokens or service-account keys.

## 5. Recommended catch-up slices

### Slice 1 — Frontend API contract and read views

1. Compare `web/lib/` clients/types against `openapi.yaml` and current Hono route schemas.
2. Add or complete clients for:
   - `GET /api/v1/artifacts/{artifactId}/versions/{version}/dependencies`
   - `GET /api/v1/artifacts/{artifactId}/versions/{version}/compatibility`
3. Add Version-level dependency and compatibility views.
4. Display declared SemVer range separately from resolved SemVer.
5. Render `none`, `available`, `redacted` and compatibility availability correctly.
6. Add tests for populated, empty, redacted, loading, error and unauthorized states.
7. Preserve existing workflows.

**Acceptance:** UI matches current OpenAPI; no redacted target-derived data is rendered; existing frontend tests remain passing.

### Slice 2 — Firebase Authentication

Frontend:
- Integrate Firebase client SDK after confirming Firebase project and provider choices.
- Obtain Firebase ID tokens and send them as API bearer tokens.
- Implement sign-in, sign-out, token refresh/expiry and unauthenticated states.
- Do not persist raw ID tokens in localStorage/sessionStorage or logs.

Backend:
- Implement Firebase ID-token verification in an Infrastructure adapter behind the existing `Authenticator`.
- Map verified `(provider, subject)` to internal `users.id`; keep `AuthenticatedPrincipal` provider-neutral.
- Reject invalid/expired tokens with 401.
- Keep fake auth local-only and production fail-closed.
- Test invalid/expired tokens, existing/unknown mappings, duplicates and production configuration.

Legacy identity rollout:
- Do not infer a provider for old `external_subject` values.
- Any backfill must use reviewed, authoritative provider/subject → internal-user mappings.
- Never merge accounts automatically by email.

**Acceptance:** Verified Firebase identity maps to the correct internal user; invalid tokens fail closed; owner authorization remains server-enforced.

### Slice 3 — Cloud Run + Cloud SQL

- Add production Dockerfile for the existing Node/Hono service; build a standard OCI image and test locally.
- Configure Cloud Run runtime service account, port, health/readiness and graceful shutdown.
- Configure Cloud Run → Cloud SQL connectivity using a documented supported method.
- Use Secret Manager or deliberately selected IAM database authentication.
- Bound PostgreSQL pool size to Cloud Run concurrency/scaling and Cloud SQL capacity.
- Run migrations as an explicit serialized release step; never migrate at every app instance startup.
- Configure structured logs without credentials/tokens.
- Document backup/PITR and restore validation.
- Add CI container build/deploy workflow only after environment and access are confirmed.

**Acceptance:** Same container works locally and on Cloud Run; Cloud SQL access is secure; migrations are repeatable; no secrets in Git.

### Slice 4 — Frontend hosting and end-to-end smoke test

- Inspect Next.js App Router/SSR needs before choosing hosting; do not assume static export.
- Configure API origin and Firebase public client configuration.
- Never put server secrets in `NEXT_PUBLIC_*`.
- Configure CORS for exact production frontend origins.
- Deploy only when target environment access is confirmed.
- Verify browser → Firebase → API → Cloud Run → Cloud SQL.
- Smoke-test anonymous discovery and authenticated owner workflows.

**Acceptance:** Correct production origins, approved CORS, sign-in and owner workflows work end to end.

## 6. Local development and verification

From repository root:

```sh
sh scripts/setup-env.sh
set -a && . ./.env && set +a
docker compose up -d postgres
npm install
npm run db:migrate
npm start
```

In another terminal:

```sh
cd web
npm ci
NEXT_PUBLIC_PEARLHUB_API_BASE_URL=http://localhost:8080 npm run dev
```

Backend: `npm run build`, `npm run test:unit`, `npm run test:integration`, `npm test`.

Frontend (from `web/`): `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

## 7. Rules for the next chat

- Verify current `main` HEAD first.
- Read the plan and architecture snapshot before changing code.
- Historical Chat 2.1/2.2 instructions that defer framework choice are superseded; Hono is implemented and frozen.
- Extend existing code; no backend/frontend rewrite.
- Keep Domain/Application independent of Hono, Firebase, PostgreSQL, Cloud Run and Gemini SDKs.
- Keep API schemas and frontend types synchronized.
- Never edit applied migrations.
- If GCP access/config is unavailable, produce an exact access checklist and continue independently testable local work.
- Update `docs/DEVELOPMENT-PLAN.md` after each accepted slice.
- Do not claim production deployment without a successful live smoke test.

## 8. Expected outputs from the next chat

1. Frontend/API gap matrix.
2. Dependency and compatibility UI aligned with current redaction contract.
3. Firebase Auth implementation in small tested steps, with missing project/provider inputs identified.
4. Cloud Run + Cloud SQL container/runtime implementation and deployment plan.
5. GCP resource/IAM access checklist with confirmed vs pending status.
6. Updated tests, READMEs/runbooks and Development Plan progress log.
7. A fresh handoff for the following incremental slice.
'''
cat > /mnt/data/pearlhub-catch-up/.github/prompts/pearlhub-frontend-deployment-catch-up.prompt.md <<'EOF'
---
mode: agent
description: Catch up PearlHub Frontend and GCP Deployment against the existing backend using incremental vertical slices.
---

# PearlHub — Frontend & Deployment Catch-up

Work in the existing PearlHub repository. Catch up Frontend and Deployment against current Backend capabilities using incremental / vertical-slice development.

## Mandatory first actions

1. Inspect current branch, HEAD and git status. The handoff SHA may be stale.
2. Read `docs/DEVELOPMENT-PLAN.md`, `docs/EXISTING-ARCHITECTURE-DESIGN.md`, `docs/HANDOFF-FRONTEND-DEPLOYMENT-CATCH-UP.md`, `openapi.yaml`, `web/README.md` and `.github/copilot-instructions.md`.
3. Inspect current source and tests before editing. Code wins over stale chat notes.
4. Produce a short gap matrix: backend capability, current UI support, deployment impact, tests and remaining work.
5. State the exact files expected to change before implementation.
6. Implement small, reviewable slices. Do not rewrite or regenerate the backend or frontend.

## Frozen architecture

- Backend: TypeScript + Hono + OpenAPI 3.1.
- Layers: Hono HTTP adapter → Application → Domain → Repository Ports → Infrastructure adapters.
- Persistence: PostgreSQL using `pg`, migrations 001–009.
- Frontend: Next.js 16 App Router + React 19 + TypeScript in `web/`.
- Confirmed cloud direction: Firebase Authentication + Cloud SQL for PostgreSQL + Cloud Run backend.
- GitHub Actions CI; no ORM/query builder currently used.
- Domain/Application must not depend on Hono, Firebase SDK, PostgreSQL, Cloud Run, OpenAPI runtime details or Gemini SDKs.
- Historical instructions that say framework selection is deferred are superseded by the implemented Hono backend.

## Frozen product/data invariants

- Use Pearl terminology.
- Artifact `id`, `name`, `slug` and `ownerId` are immutable; slug uniqueness is owner-scoped.
- Published Artifact Versions are immutable SemVer 2.x.
- Tombstone means status `tombstone` + visibility `unlisted`, preserving immutable snapshot/history. Never physically delete an Artifact.
- Fork creates permanent lineage; Clone creates none.
- GitHub import records provenance, not lineage.
- Dependencies use SemVer ranges and resolve to exact Artifact Versions with immutable manifests.
- Compatibility reports point to an exact source Artifact Version.
- Dependency/compatibility reads enforce current-access-aware redaction.
- MVP excludes Merge, Branch and executable scripts.
- Playground uses the user's Gemini API key; PearlHub must not store it.

## Current implementation facts

- Dependency resolution exists as an Application service, but there is no dedicated user-triggered HTTP route. Do not invent one.
- Dependency GET responses require `resolutionState: none | available | redacted`.
- Compatibility GET responses require `availability: available | redacted`.
- Redaction must not leak target Version IDs or target-derived report data.
- `Authenticator` returns the internal PearlHub user ID.
- `src/server.ts` currently refuses production startup and configures development fake auth only.
- Firebase token verification and frontend Firebase login are not yet implemented.
- `user_identities(provider, subject)` exists; do not infer provider for legacy `users.external_subject`.
- `MemoryArtifactContentStore` is process-local, not durable production storage.
- New complete Draft and published-Version snapshots are persisted in PostgreSQL; legacy content may be unavailable.
- Migrations 001–009 are applied history. Never edit them; use forward-only migrations for approved changes.
- Existing UI supports discovery, Draft, publish, Version, Fork/Clone, import, visibility, tombstone and work-copy. Extend it.

## Slice 1 — Frontend API contract catch-up

1. Compare `web/lib/` clients/types to `openapi.yaml` and Hono runtime schemas.
2. Identify contract drift before editing.
3. Add/complete clients for:
   - `GET /api/v1/artifacts/{artifactId}/versions/{version}/dependencies`
   - `GET /api/v1/artifacts/{artifactId}/versions/{version}/compatibility`
4. Add Version-level dependency and compatibility views.
5. Display declared SemVer range separately from resolved SemVer.
6. Render `none`, `available`, `redacted` and compatibility availability correctly.
7. Add tests for populated, empty, redacted, loading, error and unauthorized states.
8. Preserve existing user journeys.

From `web/`, run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`.

## Slice 2 — Firebase Authentication

Do not guess Firebase project settings or enabled providers.

Frontend:
- Integrate Firebase client SDK at the frontend boundary.
- Obtain Firebase ID tokens and send them as API bearer tokens.
- Implement sign-in, sign-out, token refresh/expiry and unauthenticated states.
- Do not persist raw ID tokens in localStorage/sessionStorage or logs.
- Public Firebase client config is not a server secret.

Backend:
- Add Firebase ID-token verification as an Infrastructure adapter implementing the existing Authenticator boundary.
- Map verified `(provider, subject)` to internal `users.id`.
- Keep `AuthenticatedPrincipal` provider-neutral.
- Never trust client-supplied owner IDs or auto-link accounts by email.
- Reject invalid/expired tokens with 401.
- Keep fake auth local-only and production fail-closed.
- Test invalid/expired token, existing/unknown mapping, duplicate mapping and production configuration.

Legacy identities: `user_identities` exists. Never guess a provider for legacy `external_subject` values. Backfill only from reviewed, authoritative provider/subject → internal-user mappings. Never merge users by email.

## Slice 3 — Cloud Run + Cloud SQL

First verify GCP project and resource access. Do not invent project IDs, regions, resource names, IAM roles or service accounts.

Implement incrementally:
- Production Dockerfile for the existing Node/Hono server.
- OCI image build and local container smoke test.
- Cloud Run configuration and runtime service account.
- Cloud SQL connection using a documented supported method.
- Secret Manager or deliberately selected IAM DB authentication.
- PostgreSQL pool limits aligned with Cloud Run concurrency/scaling and Cloud SQL capacity.
- Explicit serialized migration/release job; never run migrations at every app startup.
- Health/readiness, graceful shutdown and structured logs without secrets.
- Backup/PITR and restore runbook.
- CI container build/deploy workflow only when access/secrets/environments are configured.

GCP-specific details belong in Infrastructure/deployment configuration, not Domain/Application.

## Slice 4 — Frontend hosting and end-to-end verification

- Inspect Next.js App Router/SSR requirements before selecting hosting. Do not assume static export.
- Configure API origin per environment.
- Never place server secrets in `NEXT_PUBLIC_*`.
- Configure CORS for exact production origins.
- Deploy only when target resources and permissions are confirmed.
- Verify browser → Firebase → API → Cloud Run → Cloud SQL.
- Smoke-test anonymous discovery and authenticated owner workflows.

## Definition of Done per vertical slice

- Backend/API contract impact reviewed.
- Frontend user journey implemented.
- Deployment/configuration impact handled or explicitly N/A.
- Relevant backend and frontend tests pass.
- Frontend lint, typecheck, tests and production build pass.
- CI is green; security, privacy and redaction reviewed.
- Documentation and `docs/DEVELOPMENT-PLAN.md` updated.
- Deployed smoke test passes when target environment is available.

## Working rules

- Work in small, reviewable increments; no giant rewrite.
- Prefer existing code conventions, ports and adapters.
- Do not add dependencies without justification.
- Do not change public API semantics without updating OpenAPI and tests.
- Do not edit applied migrations.
- Do not claim Firebase, Cloud SQL or Cloud Run is operational without successful integration/deployment tests.
- If cloud access/config is missing, complete independently verifiable local work and list exact missing inputs.
- After each slice report changed files, behaviour, commands/tests and results, risks/blockers and next task.
