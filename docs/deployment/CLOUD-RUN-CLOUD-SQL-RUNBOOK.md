# Cloud Run and Cloud SQL Release Runbook

## Scope

This runbook prepares a repeatable release. It does not provision resources or deploy until the GCP readiness gate is approved.

## Connection decision

Use the Cloud SQL Unix socket integration with Cloud Run:

```text
postgresql://<DATABASE_USER>:<DATABASE_PASSWORD>@/<DATABASE_NAME>?host=/cloudsql/<CONNECTION_NAME>
```

Store the complete URL in Secret Manager. Attach it to `DATABASE_URL` on Cloud Run. Do not use public database networking or downloaded service-account keys unless a separately approved alternative is required.

Runtime and migration identities must be separate where practical.

## Pool budget

The initial application settings are:

- Pool maximum per instance: `10`
- Idle timeout: `30` seconds
- Connection timeout: `10` seconds
- Cloud Run container concurrency: `20`
- Maximum instances: template default `10`

Worst-case direct application pool connections:

```text
10 instances * 10 connections = 100
```

The owner must confirm database tier capacity and reserve headroom for migrations and other services before accepting autoscaling limits.

## Build

```sh
docker buildx build --platform linux/amd64 --load --tag pearlhub-backend:local .
docker run --rm -e NODE_ENV=production \
  -e PEARLHUB_AUTH_MODE=firebase \
  -e FIREBASE_PROJECT_ID=dllm-libray \
  -e DATABASE_URL='<LOCAL_OR_APPROVED_DATABASE_URL>' \
  -p 8080:8080 pearlhub-backend:local
```

The container does not contain `.env` or credentials.

## Migration release

Migrations are not run by application startup or by every Cloud Run instance.

Before routing traffic to a new revision, run exactly one serialized migration operation using the approved migration identity:

```sh
node dist/src/migrate.js
```

The process must use the same checked-in image and migration set, fail on checksum/history mismatch, and finish before deployment proceeds.

## Cloud Run deploy

After owner approval, resolve `deploy/cloud-run-service.yaml.template`. Do not deploy the unresolved template.

The service must use:

- `NODE_ENV=production`
- `PEARLHUB_AUTH_MODE=firebase`
- `FIREBASE_PROJECT_ID=dllm-libray`
- `DATABASE_URL` from Secret Manager
- `/healthz` liveness
- `/readyz` PostgreSQL readiness
- the dedicated runtime service account

The first failing revision is diagnosed from its logs if Node exits before opening the HTTP port. A container that logs
`PEARLHUB_AUTH_MODE must be firebase or development-fake` is missing the authentication environment variable:

```sh
NODE_ENV=production
PEARLHUB_AUTH_MODE=firebase
FIREBASE_PROJECT_ID=dllm-libray
```

The deployment must also supply `DATABASE_URL` from Secret Manager. The service is otherwise not considered
healthy because startup exits before the port listens.

For `CLOUD_SQL_DATABASE_URL_SECRET`, provide the secret's name only:

```sh
export CLOUD_SQL_DATABASE_URL_SECRET=pearlhub-database-url
```

Do not set it to a `postgresql://` URL. A literal URL is passed by `gcloud` as
part of `--set-secrets` and fails with `Invalid secret spec`. Store the complete,
URL-encoded database connection string in that secret first.

## Rollback

Roll back traffic to the previous known-good Cloud Run revision. Application rollback does not reverse forward-only database migrations or data changes.

If a migration is incompatible with the previous revision, stop traffic, assess the migration/data state, and perform an approved forward fix or isolated restore. Do not drop tables or edit migrations `001`–`009`.

## Smoke checks

```sh
curl -i https://<APPROVED_CLOUD_RUN_URL>/health
curl -i https://<APPROVED_CLOUD_RUN_URL>/readyz
curl -i https://<APPROVED_CLOUD_RUN_URL>/api/v1/artifacts
curl -i https://<APPROVED_CLOUD_RUN_URL>/api/v1/me
```

`/api/v1/me` must return `401` without a bearer token. No response or log may include a database URL or bearer token.
