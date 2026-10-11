# GitHub Copilot Prompt — PearlHub Chat 2.11.1 Review & Close-out

You are reviewing the checked-in Chat 2.11 persistence work in `Hong-Kong-Heritage-Archive/PearlHub`.

Primary baseline commit: `ed8e2e618eeb696080d8b4c8ec9968a76f9b2f5e`.

Read first:
- `docs/backend/PearlHub_Chat_2.3-2.10_Frozen_Reference.md`
- `docs/backend/CHAT-2.11-POSTGRESQL-PERSISTENCE-MAPPING-AND-SCHEMA-PLAN.md`
- `docs/backend/02-postgresql-schema.md`
- `docs/api/API-CONTRACT.md`
- `migrations/001_initial.sql`
- `migrations/002_persistence_hardening.sql`
- `migrations/003_identity_mapping_and_tombstone_snapshots.sql`
- existing integration-test setup and `package.json`

## Frozen constraints

- Hono remains the HTTP adapter; OpenAPI 3.1 remains the API contract; Cloud Run remains the portable container host.
- Firebase Authentication is one Infrastructure auth provider, not the internal user identity.
- Keep stable internal `UserId`; do not infer providers for legacy `external_subject` values.
- Keep layering: Hono → Application → Domain → Repository Ports → Infrastructure.
- Do not use an ORM/query builder, replace existing migrations, add another migration runner, or regenerate the backend wholesale.
- Keep owner-scoped slug uniqueness, immutable Artifact identity/versions, SemVer version identity, Fork lineage vs Clone semantics, and GitHub provenance semantics.
- Main persistence test path is the existing Vitest suite with `TEST_DATABASE_URL` and a random schema applying migrations 001 → 002 → 003.
- Primary deliverables are Markdown and reproducible evidence; minimize direct code generation.

## Phase A — inspection only

Do not edit files yet. Report findings with exact file/line evidence for these items:

1. Compare `docs/api/API-CONTRACT.md` with the frozen reference. Specifically verify Unlisted access, Admin Tombstone restoration, and the `additionalProperties` rule. Identify any contradictions; do not decide a contract change on your own.
2. Review `test/db/pearlhub_v0_1_schema.sql`, `test/db/pearlhub_v0_1_schema_tests.sql`, and `test/scripts/run_pearlhub_schema_tests.sh`. Explain why these are a separate 17-table schema/test path, and verify whether any checked-in package script or CI job uses them.
3. Verify that migration 003 is applied by the existing integration suite and that migration 001/002 are unchanged from the base commit.
4. Inspect tombstone snapshot transaction atomicity, immutability, snapshot coverage, restore behavior, and external content-store limitations.
5. Inspect identity migration/backfill behavior. Explicitly preserve unmapped legacy values; do not assume Firebase.
6. Inspect available CI status and the latest actual build/unit/integration test results. Do not report a test as passed unless it ran.

Return a concise matrix: Finding | Severity | Evidence | Minimal fix | Test/evidence required. Then STOP for approval before making changes.

## Phase B — minimal cleanup only after Phase A

After the findings are internally consistent, implement only the following safe cleanup:

- Remove the API contract contradictions by aligning the document to the frozen reference, or propose removing `docs/api/API-CONTRACT.md` from this commit if it is unrelated. Do not silently change frozen semantics. If resolving the contradiction requires a product decision, stop and ask instead of guessing.
- Remove the unrelated 17-table generated schema, SQL test file, and `/mnt/data`-dependent runner from active repository scope unless the maintainer explicitly wants a documented archive. Do not copy their schema into migrations.
- Add a short Markdown note describing the legacy identity mapping rollout and external content-store retention assumption.
- Keep migration 003 unless a reproducible defect is found. Never rewrite migrations 001 or 002.
- Update documentation/tests only where needed to match the approved behavior.

## Required checks

Run and report exact output for:

```sh
npm run build
npm run test:unit
npm run test:integration
```

If `TEST_DATABASE_URL` is missing, mark integration tests **SKIPPED** with the reason. Do not claim they passed.

## Final response

Report changed files, reason for each change, tests actually run, migration-history preservation, and any unresolved decisions. Do not start Hono/API implementation as part of this task.
