#!/usr/bin/env bash
set -euo pipefail

: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to a disposable PostgreSQL database URL}"
SCHEMA_FILE="${SCHEMA_FILE:-/mnt/data/pearlhub_v0_1_schema.sql}"
TEST_FILE="${TEST_FILE:-/mnt/data/pearlhub_v0_1_schema_tests.sql}"

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is required. Install PostgreSQL client tools and retry." >&2
  exit 127
fi

printf '%s\n' 'Applying PearlHub v0.1 schema to TEST_DATABASE_URL...'
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$SCHEMA_FILE"
printf '%s\n' 'Running PearlHub v0.1 integration assertions...'
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TEST_FILE"
printf '%s\n' 'Schema integration tests passed.'
