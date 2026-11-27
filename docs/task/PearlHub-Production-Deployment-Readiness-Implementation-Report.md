# PearlHub Production Deployment Readiness — Implementation Report

**Date:** 2026-11-22
**Starting branch/base:** `main` fast-forwarded to `53cef1fcd3e985c76da28a245fc3d6cd72627b96`
**Implementation branch:** `production-deployment-readiness`
**Cloud resources changed:** None

## Implemented

- Added a multi-stage `Dockerfile` using Node 22, `npm ci`, compiled `dist`, production dependencies, migrations and the non-root `node` user.
- Added `.dockerignore` to exclude source-control metadata, environment files, dependencies, tests, frontend sources and build output.
- Added `/healthz` liveness and `/readyz` PostgreSQL readiness routes.
- Bound the Hono Node server to `0.0.0.0` and the runtime `PORT`.
- Added focused health route tests.
- Documented explicit migration and container startup behavior.

## Readiness matrix

| Item | Required evidence | Status | Owner action / blocker |
|---|---|---|---|
| GCP project ID/project access | Confirmed project ID and access test | Not verified | Owner provides project access |
| Billing | Enabled billing confirmation | Not verified | Owner confirms billing status |
| APIs | Cloud Run, Cloud SQL Admin, Artifact Registry, Secret Manager and required Firebase APIs | Not verified | Owner lists/enables only required APIs |
| Runtime service account/IAM | Confirmed runtime identity and least-privilege roles | Not verified | Owner provides service identity and access review |
| Firebase project/Web app/providers | Project ID, Web app config and Google/Email-Password enablement | Not verified | Owner supplies public Web config and console confirmation |
| Firebase production ADC | Runtime credential strategy and revocation-check service access | Not verified | Owner chooses/authorizes ADC service identity |
| Cloud SQL | Instance, region, PostgreSQL version, database/user and connection method | Not verified | Owner supplies confirmed resource facts |
| Cloud Run | Region, scaling, concurrency and connection limit | Not verified | Owner supplies deployment settings |
| Artifact Registry | Repository name and push/read access | Not verified | Owner supplies repository and IAM confirmation |
| Secret Manager | Secret names and runtime access policy | Not verified | Owner supplies names and policy; never values |
| Migration release identity | Authorized migration identity and serialized procedure | Not verified | Owner confirms runner identity and release process |
| Frontend hosting | App Router/SSR-compatible hosting choice and exact origin | Not verified | Owner decides provider and origin |
| Backup/PITR/restore | Backup, PITR and restore-test requirements | Not verified | Owner confirms RPO/RTO and restore ownership |

## Container verification

Passed:

```sh
docker build --tag pearlhub-backend:production-readiness .
docker compose up -d postgres
DATABASE_URL=postgresql://pearlhub:pearlhub_dev_only@localhost:54329/pearlhub_dev npm run db:migrate
```

The image ran locally against PostgreSQL with development fake auth. The container:

- returned `200` for `/healthz`;
- returned `200` for `/readyz`;
- returned public discovery data from `/api/v1/artifacts`;
- returned `401` for protected `/api/v1/me`;
- ran as image user `node`;
- contained no `.env`, service-account JSON or PEM files;
- stopped cleanly with `docker stop`.

Production boundary smoke tests passed:

- development fake auth in `NODE_ENV=production` exits with `Development fake authentication is not allowed in production.`;
- invalid Firebase project ID exits with `FIREBASE_PROJECT_ID must be a valid Firebase project ID.`;
- missing `DATABASE_URL` exits with `DATABASE_URL is required to start PearlHub or run migrations.`;
- valid Firebase mode without ADC exits with `Firebase Admin could not obtain Application Default Credentials.`;

Docker logged npm engine warnings for transitive Firebase packages requiring Node >=24.12 while the repository-selected Node 22 runtime is used. This is a risk to assess before Cloud Run; no dependency or runtime version was changed without a separate decision.

## Test results

- `npm ci && npm run build && npm run test:unit`: 24 files, 196 tests passed.
- PostgreSQL integration: 57 tests passed using separate `pearlhub_test` and `pearlhub_dev` databases.
- Frontend: lint, typecheck, 14 files/67 tests and Next.js production build passed.
- Docker build: passed.
- `git diff --check`: pass after close-out edits.

## Authentication boundary

The existing unit tests and container smoke checks confirm explicit Firebase production mode and rejection of development fake auth. Live Firebase ID-token verification, provider enablement and end-to-end sign-in remain pending owner/configuration verification.

## Content persistence

- `MemoryArtifactContentStore` is process-local and lost across Cloud Run restarts/instances.
- New complete Draft snapshots are stored in PostgreSQL `drafts.content`.
- New complete published-Version snapshots are stored in PostgreSQL `artifact_versions.content_snapshot`.
- Legacy Version records may only have `content_location` and no usable snapshot; such content may be unavailable.
- Discovery reindexing and tag projection can read complete snapshots or fall back to `ArtifactContentStore` for legacy locations.
- No GCS/S3/object-store implementation was added. Durable external content should require a separate approved ADR and exact affected-flow assessment.

## Documentation

Updated or reconciled:

- `docs/DEVELOPMENT-PLAN.md`
- `docs/EXISTING-ARCHITECTURE-DESIGN.md`
- `docs/HANDOFF-FRONTEND-DEPLOYMENT-CATCH-UP.md`
- `.github/copilot-instructions.md`
- `docs/backend/DEV_ENVIRONMENT_SETUP.md`
- `docs/task/PearlHub-Production-Deployment-Readiness-Implementation-Report.md`

## Risks and next slice

1. No GCP or Firebase project facts are confirmed.
2. Live Firebase ADC/sign-in smoke testing remains blocked.
3. Cloud SQL connectivity and migration ownership remain to be designed with account access.
4. Legacy content availability needs a dedicated data assessment.
5. Frontend hosting origin and Next.js SSR requirements remain unchosen.

Next slice: confirm GCP/Firebase/Cloud SQL access and owners, then deploy the image to Cloud Run, run a serialized migration release and perform live Firebase/API/Cloud SQL smoke tests. Do not deploy or provision resources without confirmation.
