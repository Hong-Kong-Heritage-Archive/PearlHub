# PearlHub — Frontend & Deployment Catch-up Prompt

You are continuing development of `Hong-Kong-Heritage-Archive/PearlHub`.

## Mission

Bring the existing Next.js frontend and deployment foundations up to date with the already implemented backend. Use **Incremental / Vertical-slice Development**: Backend, Frontend, Deployment/configuration, tests and documentation move together for each feature. Do not restart or rewrite the backend.

## Mandatory first steps

1. Inspect `git status`, current branch and `git log -1`; verify the current `main` HEAD rather than assuming the handoff SHA is current.
2. Read:
   - `docs/DEVELOPMENT-PLAN.md`
   - `docs/EXISTING-ARCHITECTURE-DESIGN.md`
   - `docs/HANDOFF-FRONTEND-DEPLOYMENT-CATCH-UP.md`
   - `openapi.yaml`
   - `web/README.md`
   - `.github/copilot-instructions.md`
3. Inspect the actual Hono routes, runtime schemas, frontend API client/types, components and tests before proposing edits.
4. Produce a concise gap matrix with API contract, existing UI, missing UI, tests and deployment impact. Do not change code until the matrix is grounded in the current checkout.

## Frozen architecture

- Backend: TypeScript + Hono; OpenAPI 3.1.
- Frontend: Next.js 16 App Router + React 19 + TypeScript in `web/`.
- PostgreSQL with direct `pg` adapters; no ORM/query builder.
- Layers: HTTP → Application → Domain → Repository Ports → Infrastructure.
- Confirmed GCP direction: Firebase Authentication + Cloud SQL for PostgreSQL + Cloud Run backend. Actual project/resources/IAM access remain to be verified.
- Internal PearlHub `users.id` is authoritative. External identity mapping uses `(provider, subject)` via `user_identities`.
- Published Versions are immutable; Fork creates lineage; Clone does not; GitHub import creates provenance, not lineage.
- Tombstone preserves immutable snapshot/history. Migrations `001`–`009` are applied history and must never be edited.
- Playground uses the user's own Gemini API key; PearlHub must not store it.

## First implementation slice: Version dependency and compatibility UI

The backend already exposes read-only endpoints:

- `GET /api/v1/artifacts/{artifactId}/versions/{version}/dependencies`
- `GET /api/v1/artifacts/{artifactId}/versions/{version}/compatibility`

Use the exact current contract from `openapi.yaml` and Hono runtime schemas. Required semantics:

- Dependency `resolutionState`: `none | available | redacted`.
- A dependency contains its declared SemVer range and a `resolutions` array of resolved SemVer plus `resolvedAt`.
- `none` means no resolution history exists.
- `available` means history is currently readable.
- `redacted` means history exists but is withheld; this is not the same as `none`.
- Compatibility `availability`: `available | redacted`.
- A redacted compatibility report has a null target Version ID, synthetic `unavailable` status and empty report object. Do not display hidden target Version IDs or target-derived report details. Do not mistake redaction for a persisted `unavailable` status.
- Compatibility reports are community evidence for the exact source Artifact Version, not a platform guarantee.
- These GET endpoints do not trigger dependency resolution. Do not invent a POST resolver endpoint.

Implement in small steps:

1. Add strict typed API clients and runtime response validation in the existing frontend API module.
2. Add Version-level dependency history and compatibility report views to the existing published Version page.
3. Handle loading, empty, API error, unauthorized and redacted states explicitly.
4. Show declared range separately from resolved version(s); label redacted history without exposing hidden values.
5. Show compatibility details only when `availability === "available"`; when redacted, show a generic explanation only.
6. Add tests for valid, empty, malformed, redacted and error responses. Preserve all existing Fork/Clone/work-copy/tombstone behaviours.
7. Update `web/README.md` and `docs/DEVELOPMENT-PLAN.md` after the slice is implemented and verified.

## Following slices

### Firebase Authentication

- Verify Firebase project and enabled sign-in provider(s) before implementation.
- Frontend Firebase SDK obtains ID tokens and sends bearer tokens to the API.
- Backend Infrastructure adapter verifies Firebase ID tokens behind existing `Authenticator`.
- Map verified `(provider, subject)` to internal `users.id`.
- Never auto-link by email or infer a provider for legacy `users.external_subject` values.
- Keep development fake auth local-only and preserve production fail-closed guard until real auth is implemented and tested.
- Do not persist raw ID tokens in localStorage/sessionStorage or logs.

### Cloud Run + Cloud SQL

- Add/test a production OCI Dockerfile for the existing Hono backend.
- Verify GCP project, IAM, Cloud SQL, Artifact Registry and Cloud Run access before provisioning/deploying.
- Choose and document secure Cloud Run → Cloud SQL connectivity.
- Keep secrets in Secret Manager or deliberately selected IAM DB auth; never commit secrets.
- Bound DB pool size against Cloud Run concurrency/autoscaling and Cloud SQL limits.
- Run migrations as an explicit serialized release step, never concurrently at each app startup.
- Document backups, PITR and restore validation.

### Frontend hosting and end-to-end

- Inspect Next.js SSR/App Router requirements before selecting hosting; do not assume static export.
- Keep `NEXT_PUBLIC_*` limited to public configuration.
- Configure exact production CORS origins.
- Deploy only after access/resources are confirmed; run a browser → Firebase → API → Cloud Run → Cloud SQL smoke test.

## Guardrails

- Do not rewrite the backend or replace existing frontend journeys.
- Do not edit applied migrations.
- Do not invent routes, cloud resources, project IDs, regions, service accounts, URLs or credentials.
- Keep Domain/Application provider-neutral and free of Hono/Firebase/PostgreSQL/Cloud Run/Gemini SDK imports.
- Keep OpenAPI, runtime schemas, frontend types, tests and docs synchronized.
- Run backend and frontend checks relevant to every slice. If environment access prevents a check, state that clearly; do not claim it passed.
- Report changed files, exact tests run/results, remaining blockers and the next vertical slice.
