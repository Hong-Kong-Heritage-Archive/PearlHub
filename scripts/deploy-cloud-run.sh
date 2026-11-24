#!/usr/bin/env sh
set -eu

if [ "${1:-}" = "--build-only" ]; then
  BUILD_ONLY=1
else
  BUILD_ONLY=0
fi

GCP_PROJECT_ID="${GCP_PROJECT_ID:-}"
GCP_REGION="${GCP_REGION:-}"
ARTIFACT_REGISTRY_REPOSITORY="${ARTIFACT_REGISTRY_REPOSITORY:-}"
ARTIFACT_REGISTRY_IMAGE="${ARTIFACT_REGISTRY_IMAGE:-pearlhub-backend}"

if [ -z "$GCP_PROJECT_ID" ] || [ -z "$GCP_REGION" ] || [ -z "$ARTIFACT_REGISTRY_REPOSITORY" ]; then
  echo "Missing GCP_PROJECT_ID, GCP_REGION, or ARTIFACT_REGISTRY_REPOSITORY." >&2
  exit 2
fi

IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${ARTIFACT_REGISTRY_REPOSITORY}/${ARTIFACT_REGISTRY_IMAGE}:$(git rev-parse HEAD)"

docker build --tag "$IMAGE" .
gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" --quiet
docker push "$IMAGE"

if [ "$BUILD_ONLY" = "1" ]; then
  printf '%s\n' "$IMAGE"
  exit 0
fi

if [ "${CONFIRM_CLOUD_RUN_DEPLOY:-0}" != "1" ]; then
  echo "Image pushed. Set CONFIRM_CLOUD_RUN_DEPLOY=1 to deploy to Cloud Run." >&2
  exit 3
fi

echo "Deployment is not applied by this script; resolve deploy/cloud-run-service.yaml.template first." >&2
exit 4
