# PearlHub Development Plan

**Plan version:** 0.2  
**Last reviewed:** 2026-11-08  
**Repository:** [Hong-Kong-Heritage-Archive/PearlHub](https://github.com/Hong-Kong-Heritage-Archive/PearlHub)  
**Planning approach:** Incremental / vertical-slice development

> This is the working development roadmap. Update it as features are implemented and verified. The checked-in code, migrations, OpenAPI contract, accepted ADRs, and explicit project decisions remain the sources of truth for implementation details.

---

## 1. Direction change: incremental development

The original plan separated development into sequential stages:

1. Backend
2. Frontend
3. Playground
4. Deployment

This is no longer the development strategy.

PearlHub will use **incremental, end-to-end feature delivery**. Whenever a backend capability is added or changed, the corresponding frontend experience, deployment/configuration impact, tests, API documentation, and operational requirements must be considered in the same development increment.

A feature is not complete merely because its backend endpoint or database change exists.

### Required feature loop

For each feature or coherent feature group:

1. **Define** — agree on user behaviour, domain rules, API contract, security and acceptance criteria.
2. **Backend** — implement Domain/Application/Repository/HTTP changes and forward-only database migrations where required.
3. **Frontend** — expose the capability through the Next.js UI, including loading, empty, error, permission and redaction states.
4. **Deployment** — update container/runtime configuration, GCP configuration, secrets, database connectivity, migration procedure, CI/CD or monitoring where relevant.
5. **Verify** — run backend build/unit/integration tests and frontend lint/typecheck/tests/build; verify the deployed slice where applicable.
6. **Document** — update OpenAPI, relevant docs, this plan and the chat hand-off notes.

**Backend, Frontend and Deployment move together.** Playground is another product capability delivered through the same loop; it is not a separate phase that starts only after all other development is finished.

---

## 2. Product and architecture baseline

The following decisions are frozen unless an explicit Architecture Decision Record (ADR) changes them.

### Product principles

- Use the term **Pearl** throughout the product, code-facing documentation and UI. Do not use the former product term.
- PearlHub is an open, portable, community hub for discovering, sharing, versioning and reusing Pearls, Skills, Prompts and Knowledge.
- Open-source and intended to remain free for the community.
- Portability is a core principle. Avoid unnecessary platform lock-in.
- A Pearl can contain both referenced PearlHub Skill Artifacts and Embedded Skills (hybrid model).
- A referenced Skill Artifact has its own identity, versions and lineage. An Embedded Skill belongs to the containing Pearl Version snapshot.
- Artifact `id`, `name`, `slug` and `ownerId` are immutable. Slug uniqueness is owner-scoped.
- Published Artifact Versions are immutable.
- Fork creates permanent lineage; Clone does not create PearlHub lineage.
- GitHub raw URL import records provenance; it is not a Fork.
- Deleting an Artifact means creating an unlisted Tombstone with a complete immutable snapshot. It is not physical deletion.
- Dependencies use SemVer 2.x ranges. Dependency resolution records both the declared range and the exact resolved Artifact Version.
- Compatibility reports are independent records associated with an Artifact Version; they are community test evidence, not a platform guarantee.
- MVP excludes Merge, Branch and executable scripts.
- Playground uses the user's own Gemini API key. PearlHub must not store that key or persist it in its backend.

### Technology and deployment decisions

| Area | Decision |
|---|---|
| Backend | TypeScript + Hono |
| API contract | OpenAPI 3.1 |
| Backend architecture | Hono HTTP adapter → Application → Domain → Repository Ports → Infrastructure |
| Persistence | PostgreSQL |
| Database provider | Google Cloud SQL for PostgreSQL |
| Backend hosting | Google Cloud Run using a standard OCI/Docker container |
| Authentication | Firebase Authentication as an Infrastructure identity provider; provider-neutral internal PearlHub user identity |
| Frontend | Next.js 16 App Router + TypeScript |
| Local development | Docker Compose for PostgreSQL; backend and frontend run as separate local processes |
| CI | GitHub Actions |

The GCP platform direction is confirmed: **Firebase Authentication + Cloud SQL for PostgreSQL**, with Cloud Run as the backend runtime. The repository does not currently prove that production GCP resources, IAM permissions, Firebase configuration or Cloud SQL connectivity have been provisioned. Verify these as part of deployment catch-up; never commit credentials or service-account keys.

---

## 3. Repository progress snapshot

Snapshot reviewed against `main` on **2026-11-08**.

Latest reviewed commit: [`3d1fae68`](https://github.com/Hong-Kong-Heritage-Archive/PearlHub/commit/3d1fae68d2cdaa00e706149e67313e39e368580a) — `revised after breaking change`.

### 3.1 Backend — substantial MVP foundation exists

The current repository includes:

- TypeScript + Hono HTTP application and OpenAPI 3.1 contract.
- Domain, Application, Ports and PostgreSQL Infrastructure separation.
- PostgreSQL migrations `001` through `009`.
- Draft creation, editing and publication workflow.
- Immutable published Artifact Version reads.
- Artifact metadata visibility update.
- Fork and Clone workflows.
- GitHub raw URL import with provenance.
- Artifact lineage reads.
- Artifact tombstoning and retained snapshots.
- Keyword/tag discovery with cursor pagination and discovery index.
- Dependency declarations using SemVer ranges.
- Dependency resolution runs and immutable resolution manifests, including exact resolved version and content hash.
- Artifact Version dependency and compatibility-report read paths, with current-access-aware redaction.
- PostgreSQL transaction and concurrency hardening.
- Backend unit/application/contract/HTTP tests and PostgreSQL integration tests.

Current API routes include:

- `GET /api/v1/artifacts`
- `GET /api/v1/artifacts/{artifactId}`
- `GET /api/v1/me`
- `GET /api/v1/artifacts/{artifactId}/lineage`
- `POST /api/v1/artifacts/{artifactId}/fork`
- `POST /api/v1/artifacts/{artifactId}/clone`
- `POST /api/v1/imports/github`
- `GET/POST /api/v1/drafts`
- `GET/PUT /api/v1/drafts/{draftId}`
- `POST /api/v1/drafts/{draftId}/publish`
- `GET /api/v1/artifacts/{artifactId}/versions`
- `GET /api/v1/artifacts/{artifactId}/versions/{version}`
- `GET /api/v1/artifacts/{artifactId}/versions/{version}/dependencies`
- `GET /api/v1/artifacts/{artifactId}/versions/{version}/compatibility`
- `POST /api/v1/artifacts/{artifactId}/versions/{version}/work-copy`

**Important boundary:** the dependency resolver exists in the backend application/runtime, but the current HTTP route list does not expose a dedicated user-triggered resolution endpoint. Do not assume that a complete Playground dependency workflow is already available.

### 3.2 Frontend — an existing Thin UI, not a blank project

The `web/` directory contains a Next.js 16 App Router + TypeScript application with:

- Artifact discovery, keyword search, tag filters, sorting and pagination.
- Draft creation, editing, private preview and publication.
- Knowledge-file and dependency editing in Drafts.
- Published Version lists and immutable Version detail views.
- Version-level dependency resolution history and compatibility reports, including explicit empty, error, authorization, and redaction states.
- Fork and Clone actions.
- Pasted Markdown/Skill and GitHub raw URL import.
- GitHub provenance display in Draft editor.
- Owner visibility editing.
- My Drafts and owner work-copy creation.
- Artifact tombstone action.
- Loading, empty, validation, API error and retry states.
- Frontend tests for implemented screens and workflows.

Current limitations documented in `web/README.md`:

- Authentication is a temporary development-only bearer-token input, not a production login flow.
- Firebase Authentication is not integrated into the UI.
- Production deployment and target-environment smoke testing are not evidenced; GCP project and resource access remain to be verified.
- No complete user-facing Playground is documented as implemented.

### 3.3 Deployment and operations — local/CI foundations only

Already present:

- Root `compose.yaml` for local PostgreSQL 16.
- `.env.example` and local environment setup script.
- Ordered PostgreSQL migration runner.
- GitHub Actions workflows for backend build/unit tests, PostgreSQL integration tests and frontend checks.

Not yet evidenced in the repository:

- Backend production Dockerfile / OCI image build definition.
- Production Cloud Run service configuration and deployment workflow.
- Cloud SQL instance provisioning, connectivity configuration and operational migration job.
- Firebase project/client configuration and production token-verification adapter.
- Secret Manager integration and production secret/IAM setup.
- Production frontend hosting/deployment decision and pipeline.
- Deployed environment smoke tests, monitoring, alerting and backup/restore runbook.

Do not describe local Docker Compose or GitHub CI as production deployment.

### 3.4 Latest CI evidence

GitHub Actions run [`42477472878`](https://github.com/Hong-Kong-Heritage-Archive/PearlHub/actions/runs/42477472878), for commit `3d1fae68`, completed successfully on 2026-11-08:

- Backend build and unit/application/contract tests — **success**
- PostgreSQL integration tests — **success**
- Frontend lint, typecheck, tests and production build — **success**

This is CI evidence for the checked-in commit. It is not evidence that GCP production deployment or live Firebase/Cloud SQL integration has been completed.

---

## 4. Immediate objective: Frontend and Deployment catch up

The next development increment is a coordinated catch-up against the Backend capabilities already present.

### Workstream A — Frontend catch-up

**Goal:** Bring the existing Thin UI into alignment with the current Backend API and make the product usable without developer-only bearer-token entry.

#### A1. API contract and UI gap audit

- Read the current `openapi.yaml` and runtime-generated OpenAPI contract.
- Compare every currently implemented UI operation with the latest request/response schemas.
- Explicitly review the approved dependency/compatibility response-shape change.
- Confirm handling of `resolutionState: none | available | redacted`.
- Confirm handling of compatibility report `availability: available | redacted`.
- Ensure redacted target Version IDs and report payloads are never shown as if available.
- Check private/unlisted/tombstone access behaviour against the backend contract.
- Produce a small UI gap matrix before changing components.

**Acceptance:**
- Frontend API client/types agree with the current OpenAPI contract.
- No stale assumptions about the old dependency/compatibility response shape remain.
- Permission, redaction, loading, empty and error states are tested.

#### A2. Dependency and compatibility views

- Add or complete Version-level dependency information on the Artifact/Version UI.
- Display the declared SemVer range separately from each resolved exact Version.
- Show the resolution state clearly: not resolved, available, or redacted.
- Display compatibility reports as community evidence attached to the exact Artifact Version.
- Show report availability/redaction without leaking inaccessible target details.
- Do not imply that a community report is a formal compatibility guarantee.

**Acceptance:**
- A user can inspect a Version's dependency declarations and available resolution history.
- A user can inspect compatibility evidence for that exact Version.
- UI behaviour matches the API's current authorization and redaction policy.

#### A3. Production sign-in experience

- Replace the developer-only bearer-token entry as the normal user experience with Firebase Authentication.
- Support the agreed Firebase sign-in provider(s); do not assume a provider list beyond the project decision.
- Keep the Firebase client SDK in the frontend boundary.
- Send Firebase ID tokens as bearer tokens to the PearlHub API.
- Keep internal PearlHub `users.id` as the authoritative owner identity.
- Do not use email as an automatic account-linking key.
- Preserve the provider-neutral `(provider, subject)` identity mapping.
- Retain the development fake authenticator only for explicitly local development; it must never be a production fallback.

**Acceptance:**
- Sign-in, sign-out, token refresh/expiry and unauthenticated UI states work.
- The API identifies the same internal PearlHub user across requests.
- Owner-only Draft, publish, fork, visibility and tombstone actions continue to use backend authorization.
- No Firebase credentials, private keys or ID tokens are persisted in application source or logs.

### Workstream B — GCP deployment catch-up

**Goal:** Establish a repeatable, secure GCP deployment path for the current backend and frontend.

#### B1. Verify GCP access and target resources

- Confirm the target GCP project and required project-level IAM access.
- Confirm Firebase project access and Authentication configuration access.
- Confirm Cloud SQL administration/connectivity access.
- Confirm Cloud Run deployment permissions and Artifact Registry access.
- Record which resources already exist and which need provisioning.
- Use least-privilege IAM. Do not request Owner permissions if narrower roles are sufficient.
- Keep all credentials and sensitive configuration outside Git.

**Acceptance:**
- A documented access/resource matrix identifies project, resource, owner, required role and status.
- No assumption is made that a resource exists merely because the platform choice is confirmed.

#### B2. Backend container and Cloud Run

- Add a production Dockerfile for the Hono backend.
- Build a standard OCI image; keep application code portable and avoid Cloud Run-specific dependencies in Domain/Application.
- Define Cloud Run service configuration, runtime service account and environment variables.
- Add startup/readiness/liveness behaviour appropriate to the current server.
- Configure structured logs and safe error reporting.
- Verify graceful shutdown and PostgreSQL pool lifecycle.
- Build and test the container locally before deploying.

**Acceptance:**
- The same OCI image can run locally and on Cloud Run.
- Cloud Run starts the backend with production authentication only.
- No development fake-auth mode can be enabled in production.
- Health checks and logs do not expose credentials or connection strings.

#### B3. Cloud SQL for PostgreSQL

- Provision or confirm Cloud SQL for PostgreSQL in the selected GCP project.
- Choose and document the Cloud Run-to-Cloud SQL connection method (prefer the supported Cloud SQL connector/integration rather than embedding static database credentials).
- Configure network, IAM database authentication or password-based authentication as deliberately selected for the deployment.
- Store any required database credential in Secret Manager.
- Define connection pool limits suitable for Cloud Run autoscaling and Cloud SQL capacity.
- Define a controlled migration job/release step using the existing migration runner.
- Never run schema migrations independently from multiple application instances at startup.
- Configure automated backups and point-in-time recovery according to the environment's needs.
- Test restore/recovery procedures before relying on the database for production data.

**Acceptance:**
- Cloud Run can connect to Cloud SQL securely.
- Migration execution is explicit, observable and repeatable.
- Application instances do not race to apply migrations.
- Backup and restore responsibilities are documented.

#### B4. Firebase Authentication backend adapter

- Implement Firebase ID-token verification in the Infrastructure / Hono authentication adapter.
- Convert a verified Firebase identity into the provider-neutral `AuthenticatedPrincipal`.
- Resolve or create the internal user mapping through `user_identities(provider, subject)`.
- Use the Firebase UID as the provider subject; do not treat email as a stable identity key.
- Preserve existing internal user IDs and do not guess a provider for legacy `external_subject` records.
- Keep authorization in Application/Domain policy, not in Firebase-specific code.
- Add tests for invalid/expired tokens, unknown identity, existing identity, duplicate mapping and provider isolation.

**Acceptance:**
- A valid Firebase ID token resolves to the correct internal PearlHub user.
- Invalid tokens are rejected with 401.
- Firebase SDK/types do not leak into Domain/Application.
- The development fake authenticator remains isolated from production configuration.

#### B5. Frontend hosting and end-to-end environment

- Decide and document the production hosting arrangement for the Next.js app. Evaluate it against the existing App Router/SSR requirements and API-origin/CORS model; do not assume static hosting if server rendering is required.
- Configure the public API base URL per environment.
- Configure Firebase public client configuration using appropriate public environment variables; no server secrets belong in `NEXT_PUBLIC_*`.
- Configure production CORS for exact frontend origins.
- Add frontend build/deploy automation.
- Verify browser sign-in → API request → Cloud Run → Cloud SQL end to end.

**Acceptance:**
- Production frontend uses the correct API origin and Firebase project.
- Browser requests succeed only from approved origins.
- Authenticated owner workflows work end to end in the deployed environment.

### Workstream C — Close-out and operational baseline

- Update `web/README.md`, backend setup docs and deployment docs to reflect actual production/local behaviour.
- Add a deployment runbook covering deploy, rollback, migration, secrets rotation and incident response.
- Add a smoke-test checklist for public discovery, sign-in, Draft, Publish, Version reads, Fork/Clone, import, dependency/compatibility reads and tombstone behaviour.
- Confirm CI gates are required before deployment.
- Keep the latest successful CI run linked from this plan until a newer run supersedes it.

---

## 5. Subsequent incremental feature roadmap

These are product capabilities, not a return to sequential development phases.

| Priority | Feature slice | Backend | Frontend | Deployment / operations |
|---|---|---|---|---|
| P0 | Current API/UI contract catch-up | Audit latest API and response contracts | Dependency + compatibility UI | Deploy the same API contract and verify smoke tests |
| P0 | Production authentication | Firebase token verification and identity mapping | Firebase sign-in/session handling | Firebase project, IAM, secrets and Cloud Run config |
| P0 | Production persistence/runtime | Cloud SQL-compatible runtime configuration | Connect UI to deployed API | Cloud Run + Cloud SQL + migration and backup runbooks |
| P1 | Playground MVP | Safe dependency resolution/read APIs and any missing execution-support contract | BYOK Gemini Playground; key remains client-side | CSP/CORS, browser-side provider access, no key persistence |
| P1 | Export / portability | Deterministic export and resolved dependency manifest | Download/export flow | Verify portable export independent of hosting provider |
| P1 | Usage and community metrics | Event recording and aggregate read APIs | Downloads/uses/forks/stars display | Retention, abuse controls and cost monitoring |
| P1 | Community compatibility reporting | Create/list/report controls tied to Artifact Version | Submit and view test evidence | Rate limiting, moderation/abuse handling |
| P2 | Semantic discovery | Search/index extension | Semantic search UX | Evaluate hosting and index cost before adopting a vector service |
| Later | Additional providers and enhancements | Provider-neutral extensions | Corresponding UI | Keep infrastructure replaceable |

Before implementing a roadmap item, define the smallest useful vertical slice and its acceptance criteria.

---

## 6. Incremental delivery rules

Every new backend feature or API change must include a review of the following.

### Backend
- Domain invariants and authorization.
- Repository/transaction behaviour.
- Forward-only migration, if needed.
- OpenAPI 3.1 contract and error model.
- Unit, application, HTTP and PostgreSQL integration tests.

### Frontend
- API client and response types.
- User-visible flow and navigation.
- Loading, empty, validation, error, permission and redaction states.
- Responsive and accessible interaction.
- Component/UI tests and production build.

### Deployment
- Environment variables and secret changes.
- Container/runtime changes.
- Database migration or connection changes.
- GCP IAM/network/resource changes.
- CI/CD, smoke tests, logs, metrics, alerts and rollback implications.

### Documentation
- Update relevant API, backend, frontend and deployment docs.
- Update this roadmap's status and next action.
- Record decisions in an ADR when they alter a frozen architectural decision.

### Definition of Done

A vertical slice is **Done** only when:

- [ ] Backend implementation is complete.
- [ ] API/OpenAPI contract is current.
- [ ] Frontend user journey is implemented.
- [ ] Deployment/configuration impact is handled or explicitly marked not applicable.
- [ ] Backend build and relevant tests pass.
- [ ] Frontend lint, typecheck, tests and build pass.
- [ ] PostgreSQL integration tests pass for persistence changes.
- [ ] CI is green.
- [ ] Security/privacy implications are reviewed.
- [ ] Documentation and this plan are updated.
- [ ] The feature is smoke-tested in the target environment when deployment is available.

---

## 7. Chat/workstream organization

Keep separate chats for focused work, but use this shared roadmap as the cross-chat source of current priorities. The five chat areas remain:

1. **Architecture & Schema** — domain model, canonical format, PostgreSQL and architectural decisions.
2. **Backend Development** — Domain/Application/Ports/Infrastructure, Hono, API and migrations.
3. **Frontend Development** — Next.js screens, API integration and user journeys.
4. **Playground Development** — client-side Gemini BYOK, dependency loading and export/test experience.
5. **Deployment & Open Source** — GCP, Firebase, Cloud SQL, Cloud Run, CI/CD, operations and community release.

These are collaboration boundaries, **not sequential project phases**. A feature may require coordinated work in several chats. The owner of each feature should link the relevant chat decisions and update this plan when the slice is accepted.

### Chat hand-off minimum

Every hand-off should state:

- Current repository commit SHA.
- Feature and user-visible outcome.
- Relevant API/OpenAPI endpoints.
- Backend implementation and test status.
- Frontend implementation and test status.
- Deployment/configuration status.
- Open questions or blockers.
- Exact next task and acceptance criteria.

---

## 8. Current status and next action

### Overall status

**Backend:** Core content-management and discovery foundation is implemented; dependency resolution and compatibility read paths are now present. Continue with small, reviewed increments rather than restarting or regenerating the backend.

**Frontend:** Existing Thin UI now includes read-only Version dependency history and compatibility views aligned with the latest redaction contract. Firebase Authentication has not been integrated; the developer-only bearer-token experience remains.

**Deployment:** Local PostgreSQL and CI are in place. Production GCP deployment is not yet evidenced. GCP + Firebase Authentication + Cloud SQL for PostgreSQL is the confirmed direction; resource access and provisioning must be verified.

**Playground:** Not yet a complete user-facing capability. Implement after the current frontend/auth/deployment catch-up, using the same incremental feature loop.

### Next increment — Authentication and deployment readiness

The initial dependency/compatibility UI slice is complete and locally verified. Continue with the remaining catch-up work:

1. Verify GCP project, Firebase and Cloud SQL access; record resource/IAM status and enabled sign-in providers.
2. Implement Firebase Authentication end to end (frontend token acquisition + backend verification + internal identity mapping), preserving the production fail-closed guard until verified.
3. Containerize and deploy the backend to Cloud Run with Cloud SQL connectivity after resource access is confirmed.
4. Deploy the frontend to the selected GCP hosting arrangement and configure API origin/CORS.
5. Run end-to-end smoke tests and update this plan with actual deployed URLs/resource references (never secrets).

The ordering above is a practical dependency order for the catch-up work, not a return to backend-first development. UI/API contract work and deployment preparation should proceed in parallel wherever their interfaces are clear.

### Progress log

| Date | Commit / reference | Update |
|---|---|---|
| 2026-11-08 | `3d1fae68` | Backend dependency/compatibility read-path hardening accepted in code; CI build/unit, PostgreSQL integration and frontend checks all green. |
| 2026-11-08 | This plan | Development strategy changed to incremental vertical slices; immediate priority is Frontend + Deployment catch-up. GCP + Firebase Auth + Cloud SQL direction confirmed; actual resource access/provisioning remains to be verified. |
| 2026-11-10 | Working tree | Added Version-level dependency history and compatibility views with strict response validation and redaction handling. Frontend tests, lint, typecheck, production build, backend build, and focused OpenAPI/HTTP tests passed; production deployment remains unverified. |

Update this log after each accepted vertical slice. Do not mark a task complete based only on code being present; record the relevant test and deployment evidence.
