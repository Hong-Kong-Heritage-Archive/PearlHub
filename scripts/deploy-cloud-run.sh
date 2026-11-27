#!/usr/bin/env sh
set -eu

if [ "${1:-}" = "--build-only" ]; then
  docker buildx build \
    --platform linux/amd64 \
    --load \
    --tag pearlhub-backend:local \
    .
  printf '%s\n' "pearlhub-backend:local"
  exit 0
fi

GCP_PROJECT_ID="${GCP_PROJECT_ID:-}"
GCP_REGION="${GCP_REGION:-}"
ARTIFACT_REGISTRY_REPOSITORY="${ARTIFACT_REGISTRY_REPOSITORY:-}"
ARTIFACT_REGISTRY_IMAGE="${ARTIFACT_REGISTRY_IMAGE:-pearlhub-backend}"

if [ -z "$GCP_PROJECT_ID" ] || [ -z "$GCP_REGION" ] || [ -z "$ARTIFACT_REGISTRY_REPOSITORY" ]; then
  echo "Missing GCP_PROJECT_ID, GCP_REGION, or ARTIFACT_REGISTRY_REPOSITORY." >&2
  exit 2
fi

CLOUD_RUN_SERVICE="${CLOUD_RUN_SERVICE:-pearlhub-backend}"
CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT="${CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT:-}"
CLOUD_SQL_INSTANCE="${CLOUD_SQL_INSTANCE:-}"
CLOUD_SQL_DATABASE_URL_SECRET="${CLOUD_SQL_DATABASE_URL_SECRET:-}"
FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-dllm-libray}"

if [ -z "$CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT" ] || [ -z "$CLOUD_SQL_INSTANCE" ] || [ -z "$CLOUD_SQL_DATABASE_URL_SECRET" ]; then
  echo "Missing CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT, CLOUD_SQL_INSTANCE, or CLOUD_SQL_DATABASE_URL_SECRET." >&2
  exit 4
fi

case "$CLOUD_SQL_DATABASE_URL_SECRET" in
  postgres:*|postgresql:*)
    echo "CLOUD_SQL_DATABASE_URL_SECRET must be a Secret Manager secret name, not a PostgreSQL URL." >&2
    echo "Create a secret whose value is the encoded DATABASE_URL, then set this variable to that secret name." >&2
    exit 5
    ;;
  *[!A-Za-z0-9_-]*)
    echo "CLOUD_SQL_DATABASE_URL_SECRET must contain only letters, numbers, underscores, or hyphens." >&2
    exit 5
    ;;
esac

if ! gcloud secrets describe "$CLOUD_SQL_DATABASE_URL_SECRET" --project "$GCP_PROJECT_ID" >/dev/null 2>&1; then
  echo "Secret Manager secret '$CLOUD_SQL_DATABASE_URL_SECRET' was not found in project '$GCP_PROJECT_ID'." >&2
  exit 5
fi

if ! gcloud secrets versions access latest \
  --secret "$CLOUD_SQL_DATABASE_URL_SECRET" \
  --project "$GCP_PROJECT_ID" \
  | node -e 'let value = ""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => { try { const raw = value.trim(); const normalized = raw.replace(/^(postgres(?:ql)?:\/\/[^/?#]*)@\/(?=[^?]*(?:\?|$))/, "$1@localhost/"); const url = new URL(normalized); const socket = url.searchParams.get("host"); if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.pathname.slice(1) || !socket?.startsWith("/cloudsql/")) process.exit(1); } catch { process.exit(1); } });'; then
  echo "The latest '$CLOUD_SQL_DATABASE_URL_SECRET' value is not a valid Cloud SQL socket URL." >&2
  echo "Ensure credentials are URL-encoded and the host query is /cloudsql/PROJECT:REGION:INSTANCE." >&2
  exit 5
fi

IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${ARTIFACT_REGISTRY_REPOSITORY}/${ARTIFACT_REGISTRY_IMAGE}:$(git rev-parse HEAD)"

gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" --quiet
docker buildx build \
  --platform linux/amd64 \
  --tag "$IMAGE" \
  --push \
  .

if [ "${CONFIRM_CLOUD_RUN_DEPLOY:-0}" != "1" ]; then
  echo "Image pushed. Set CONFIRM_CLOUD_RUN_DEPLOY=1 to deploy to Cloud Run." >&2
  exit 3
fi

gcloud run deploy "$CLOUD_RUN_SERVICE" \
  --project "$GCP_PROJECT_ID" \
  --region "$GCP_REGION" \
  --image "$IMAGE" \
  --platform managed \
  --service-account "$CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT" \
  --set-env-vars "NODE_ENV=production,PEARLHUB_AUTH_MODE=firebase,FIREBASE_PROJECT_ID=$FIREBASE_PROJECT_ID,PG_POOL_MAX=${PG_POOL_MAX:-10},PG_IDLE_TIMEOUT_MS=${PG_IDLE_TIMEOUT_MS:-30000},PG_CONNECTION_TIMEOUT_MS=${PG_CONNECTION_TIMEOUT_MS:-10000}" \
  --set-secrets "DATABASE_URL=$CLOUD_SQL_DATABASE_URL_SECRET:latest" \
  --add-cloudsql-instances "$CLOUD_SQL_INSTANCE" \
  --port 8080
