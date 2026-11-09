# PearlHub — Existing Architecture Design (As-Is)

**Reviewed:** 2026-11-08  
**Branch:** `main`  
**Reviewed HEAD:** `7547bdb594f3263b42e4a6e4f9b4efa28e52f9d9`  
**Purpose:** Record the architecture that exists in the repository today, not a proposed redesign.

> Checked-in source, SQL migrations, OpenAPI, tests and accepted decisions are authoritative. Refresh this document when implementation changes.

## 1. Architecture overview

PearlHub currently has a TypeScript/Hono backend, a separately maintained Next.js frontend, and PostgreSQL persistence.

```text
Browser
  |
  v
Next.js 16 App Router (web/)
  | HTTP/JSON, configured API origin
  v
Hono HTTP Adapter (src/http/)
  | routing, validation, auth boundary, DTO/error mapping, OpenAPI
  v
Application Services (src/application/)
  | use cases, access policy, transaction orchestration
  v
Domain Model (src/domain/)
  | Artifact, Version, Draft, Dependency, Pearl content, invariants
  v
Repository / Service Ports (src/ports/)
  |
  +--> PostgreSQL adapters (src/adapters/postgres.ts)
  +--> Migration runner
  +--> Safe GitHub raw-source adapter
  +--> Content-store adapter (currently in-memory)
  |
  v
PostgreSQL (migrations 001–009)
```

The frontend calls the configured API origin directly; there is no Next.js API proxy in the current UI. `NEXT_PUBLIC_PEARLHUB_API_BASE_URL` configures the API origin.

| Layer | Responsibility |
|---|---|
| Web UI | User journeys, form state, API calls and display |
| Hono HTTP | Routing, validation, auth boundary, DTO/error mapping, OpenAPI |
| Application | Use cases, access policy and transaction orchestration |
| Domain | Business rules, invariants and state transitions |
| Ports | Provider/framework-neutral repository and service contracts |
| Adapters | PostgreSQL, GitHub source and content-store implementations |
| Runtime | Composition root that wires concrete services |

**Rule:** Hono owns HTTP; Application owns use cases; Domain owns business rules; Infrastructure owns external systems; Cloud Run owns only runtime.

## 2. Repository map

| Path | Current role |
|---|---|
| `src/domain/` | Artifact, ArtifactVersion, Draft, Dependency, resolution run, Pearl content, SemVer and errors |
| `src/application/` | Draft workflow, import, discovery, Artifact lifecycle and dependency resolution use cases |
| `src/ports/repositories.ts` | Persistence, transaction and content-store interfaces |
| `src/adapters/postgres.ts` | PostgreSQL repositories and transaction implementation |
| `src/adapters/postgres-migrations.ts` | Ordered migrations, checksums and schema-current validation |
| `src/adapters/github-raw-source.ts` | Safe `raw.githubusercontent.com` retrieval |
| `src/adapters/content-store.ts` | In-memory content-store implementation |
| `src/http/` | Hono routes, schemas, auth interface, development CORS and error mapping |
| `src/runtime.ts` | PostgreSQL composition root |
| `src/server.ts` | Node server entry point and local auth bootstrap |
| `migrations/` | Forward-only SQL migrations 001–009 |
| `openapi.yaml` | OpenAPI 3.1 contract |
| `tests/` | Unit, application, contract, HTTP and PostgreSQL integration tests |
| `web/` | Next.js 16 frontend |
| `.github/workflows/ci.yml` | GitHub Actions CI |
| `compose.yaml` | Local PostgreSQL 16 |
| `docs/backend/` | Domain/schema/API/decision references |

The root is the backend npm package. `web/` is a separate frontend package with its own manifest and lockfile.

## 3. Backend

### HTTP and API

- Hono with `@hono/zod-openapi`; Node server adapter is `@hono/node-server`.
- API prefix: `/api/v1`.
- Runtime route schemas are in `src/http/app.ts`.
- `openapi.yaml` is the checked-in OpenAPI 3.1 client contract.
- Handlers call Application services; they do not own business rules or direct SQL.
- `src/http/error-mapping.ts` maps Domain errors to the API error envelope.

### Application use cases currently present

- Draft create/list/read/update/discard.
- Atomic first publication and owner work-copy creation.
- Fork Draft and Clone Draft workflows.
- Pasted content / GitHub raw URL import.
- Artifact metadata visibility update and tombstoning.
- Artifact, Version and lineage reads.
- Discovery listing and discovery-index rebuilding.
- Source-Version dependency resolution as an Application service.

**Important:** `ResolveSourceVersionDependenciesService` is constructed by `src/runtime.ts`, but the current HTTP route list does not expose a dedicated user-triggered resolution command. Do not invent a public endpoint or claim the complete Playground resolution flow exists.

### Domain invariants

- Artifact `id`, `name`, `slug` and owner are immutable; slug uniqueness is owner-scoped.
- Visibility: `private`, `unlisted`, `public`; status: `active`, `tombstone`.
- Tombstone is unlisted and is not physical deletion.
- Published Artifact Versions are immutable SemVer 2.x.
- Fork creates permanent lineage; Clone creates no lineage.
- GitHub import records provenance, not Fork lineage.
- Dependencies use SemVer ranges and resolve to exact Artifact Versions.
- Compatibility reports are associated with an exact source Artifact Version.
- MVP excludes Merge, Branch and executable scripts.

`PearlContent` is validated as a JSON object with a SemVer `version`, a `skill` object and a `knowledge` array. The format is extensible JSON; do not silently substitute a different manifest format.

### PostgreSQL

The schema is created by migrations `001`–`009`. The schema documentation identifies fourteen application tables:

1. `users`
2. `user_identities`
3. `artifacts`
4. `artifact_versions`
5. `drafts`
6. `artifact_lineage`
7. `provenances`
8. `dependencies`
9. `dependency_resolutions`
10. `dependency_resolution_runs`
11. `compatibility_reports`
12. `tombstone_snapshots`
13. `artifact_discovery_index`
14. `artifact_discovery_index_state`

The migration runner applies ordered SQL transactionally, records filename and SHA-256 checksum, uses an advisory lock, and rejects changed/missing/unknown migration history. The HTTP runtime checks that the database schema is current before serving.

New Drafts and new complete published-Version snapshots are persisted in PostgreSQL JSONB. Legacy Versions created during the former in-memory content-store period may not have recoverable complete content; preserve the documented unavailable/conflict behaviour.

There is no ORM/query-builder layer. Use `pg`, existing repository ports and transaction abstractions.

### Content and import

`SafeGitHubRawSource` supports HTTPS `raw.githubusercontent.com` only. It validates URL/path, resolves and rejects prohibited network destinations, disallows redirects, applies time/size limits and requires UTF-8 text. Import provenance is distinct from Fork lineage.

`MemoryArtifactContentStore` is process-local. It validates SHA-256 hashes but is not durable production object storage. Do not describe it as GCS/S3-compatible production storage. New complete snapshots are also persisted in PostgreSQL as described by migration 005/schema docs.

## 4. Current API surface

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/v1/artifacts` | Discovery/search, tags, sort, visibility and cursor |
| GET | `/api/v1/artifacts/{artifactId}` | Artifact metadata |
| PATCH | `/api/v1/artifacts/{artifactId}` | Owner visibility update |
| DELETE | `/api/v1/artifacts/{artifactId}` | Tombstone Artifact |
| GET | `/api/v1/me` | Authenticated internal user ID |
| GET | `/api/v1/artifacts/{artifactId}/lineage` | Visible Fork lineage |
| POST | `/api/v1/artifacts/{artifactId}/fork` | Fork Draft |
| POST | `/api/v1/artifacts/{artifactId}/clone` | Clone Draft |
| POST | `/api/v1/imports/github` | Pasted/GitHub import into Draft |
| GET/POST | `/api/v1/drafts` | List/create Drafts |
| GET/PUT/DELETE | `/api/v1/drafts/{draftId}` | Read/update/discard Draft |
| POST | `/api/v1/drafts/{draftId}/publish` | Publish Draft |
| GET | `/api/v1/artifacts/{artifactId}/versions` | Version list |
| GET | `/api/v1/artifacts/{artifactId}/versions/{version}` | Exact immutable Version |
| GET | `/api/v1/artifacts/{artifactId}/versions/{version}/dependencies` | Dependencies and resolution history |
| GET | `/api/v1/artifacts/{artifactId}/versions/{version}/compatibility` | Compatibility reports |
| POST | `/api/v1/artifacts/{artifactId}/versions/{version}/work-copy` | Owner work-copy |

Direct `POST /api/v1/artifacts` is retired. First publication creates the Artifact and initial Version atomically.

Dependency responses require `resolutionState: none | available | redacted`; resolutions expose resolved SemVer and timestamp. GET does not calculate or persist a new resolution.

Compatibility responses require `availability: available | redacted`. Redacted records must not expose target-derived report payload or hidden target Version identity. These are security semantics, not optional UI hints. The approved response change remains under `/api/v1`.

## 5. Authentication and identity — current implementation

Implemented:
- `Authenticator` in `src/http/authentication.ts` accepts request headers and returns an `AuthenticatedPrincipal` containing internal `userId`, or null.
- Protected handlers require a principal.
- Development-only fake authenticator supports local identities.
- `user_identities` stores provider-neutral `(provider, subject)` mapping to internal `users.id`.
- Internal `users.id` remains authoritative.

Not implemented:
- No Firebase Admin SDK token verifier / Firebase `Authenticator` adapter is present.
- `src/server.ts` explicitly refuses `NODE_ENV=production`.
- The only server auth mode is `PEARLHUB_AUTH_MODE=development-fake`.
- Frontend bearer-token field is a temporary developer tool, not login.
- No production account-linking or verified legacy identity backfill flow exists.

Firebase Authentication is the confirmed target provider, not an already completed integration. Legacy `users.external_subject` values must not be assigned a provider by guesswork or email matching.

## 6. Frontend — current implementation

`web/` is Next.js 16 App Router + React 19 + TypeScript. Current journeys:

- Artifact discovery, query/tag filters, sorting and cursor pagination.
- Draft create/edit/preview/publish.
- Knowledge-file and dependency declaration editing.
- Published Version list and immutable Version detail.
- Fork/Clone, pasted/GitHub import and provenance display.
- Visibility editor, My Drafts, Draft discard, work-copy and Artifact tombstone.
- Loading, empty, validation, API error and retry states.

The UI calls the configured API origin directly. The temporary bearer token is held in component memory, not browser storage. The UI does not decode the token; the API owns authentication and authorization.

Frontend gaps: no Firebase login/session flow; no Version-level dependency/compatibility views documented as implemented; no complete user-facing Playground; no production frontend hosting/pipeline evidenced in the repository.

## 7. Local development and CI

Local foundations:
- `compose.yaml` runs PostgreSQL 16.
- `scripts/setup-env.sh` creates an untracked `.env` from `.env.example`.
- Backend defaults to port 8080; frontend defaults to port 3000.
- Frontend API origin: `NEXT_PUBLIC_PEARLHUB_API_BASE_URL`.
- Development CORS is configured by `PEARLHUB_DEV_CORS_ORIGINS`.

Backend scripts (root): `npm run build`, `npm start`, `npm run db:migrate`, `npm run db:migrate:baseline`, `npm test`, `npm run test:unit`, `npm run test:integration`.

Frontend scripts (from `web/`): `npm run dev`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

GitHub Actions checks backend build/unit, PostgreSQL integration and frontend checks. Green CI is not proof of production deployment.

## 8. Deployment — current vs confirmed target

| Capability | Target direction | Evidence in current repository |
|---|---|---|
| Backend runtime | Google Cloud Run | Not deployed/configured |
| Database | Cloud SQL for PostgreSQL | Local PostgreSQL Compose only |
| Authentication | Firebase Authentication | Identity mapping table exists; token verification and UI login absent |
| Frontend | Next.js 16 | Local app exists; production hosting/pipeline absent |
| Content store | Provider-neutral port | In-memory adapter; no GCS adapter evidenced |

No production Dockerfile, Cloud Run config, Cloud SQL connection setup, Firebase client/server config, Secret Manager wiring or production deployment workflow was found in the reviewed tree. Verify GCP project, IAM, Firebase project, Cloud SQL instance, Artifact Registry and deployment access; do not infer resource existence from technology selection.

## 9. Constraints for future changes

1. Extend the existing implementation; do not regenerate it.
2. Keep business rules out of Hono handlers and UI components.
3. Keep Domain/Application independent of Hono, Firebase SDK, PostgreSQL, Cloud Run and Gemini SDKs.
4. Do not introduce ORM/query builder without an ADR.
5. Never edit applied migrations 001–009; add forward-only migrations.
6. Keep OpenAPI and Hono runtime schemas synchronized.
7. Preserve API error codes, authorization and redaction semantics.
8. Never trust client-supplied owner IDs or auto-link accounts by email.
9. Never enable fake authentication in production.
10. Never persist the user's Gemini API key.
11. Preserve Fork/Clone/provenance distinctions, immutability and tombstone retention.
12. Deliver changes as Backend + Frontend + Deployment vertical slices.

## 10. Source references

Derived from `docs/backend/PearlHub_Chat_2.3-2.10_Frozen_Reference.md`, `docs/backend/01-domain-model.md` through `07-test-plan.md`, `docs/backend/02-postgresql-schema.md`, `docs/api/API-CONTRACT.md`, `openapi.yaml`, `src/`, `migrations/001..009`, `web/README.md`, `web/lib/`, `web/app/`, `web/components/`, `compose.yaml`, `.env.example` and `.github/workflows/ci.yml`.

If this document conflicts with newer checked-in code, update this snapshot from the implementation.
