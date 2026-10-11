# PearlHub Chat 2.11 — Post-Implementation Review

**Reviewed commit:** [`ed8e2e618eeb696080d8b4c8ec9968a76f9b2f5e`](https://github.com/Hong-Kong-Heritage-Archive/PearlHub/commit/ed8e2e618eeb696080d8b4c8ec9968a76f9b2f5e)  
**Branch reviewed:** `main`  
**Review date:** 2026-10-11  
**Outcome:** **Not yet accepted; perform a small Chat 2.11.1 close-out before moving to the next implementation phase.**

This was a source review of the checked-in commit and relevant frozen reference files. It was not a local test run. GitHub returned no commit status checks for this SHA, so this review does not claim `npm run build`, `npm run test:unit`, or `npm run test:integration` passed.

## 1. What looks directionally correct

- `migrations/003_identity_mapping_and_tombstone_snapshots.sql` is forward-only and leaves migrations 001/002 intact.
- `user_identities` uses `(provider, subject)` uniqueness while retaining stable internal `users.id`.
- Migration 003 deliberately does not guess a provider for existing `users.external_subject` values; the legacy value remains preserved.
- Tombstoning is performed through one PostgreSQL function call, which builds the snapshot and changes Artifact status/visibility in the same database statement/transaction boundary.
- Snapshot rows are protected against UPDATE, DELETE, and TRUNCATE.
- Snapshot contents include the Artifact row, its versions/content references, dependency declarations and resolutions, provenance, compatibility reports, and related lineage.
- Admin restoration keeps the same Artifact ID and leaves historical versions/lineage in place.
- The new source-version reference on Fork lineage is nullable, avoiding fabricated history for old rows.
- The frozen architecture is largely preserved: no ORM, no framework, no replacement of the original migrations.

## 2. Acceptance blockers / cleanup required

### P0 — Resolve contradictions in the newly added API contract

File: `docs/api/API-CONTRACT.md`

This document was added in the persistence commit and conflicts with `docs/backend/PearlHub_Chat_2.3-2.10_Frozen_Reference.md`:

1. The frozen reference says Unlisted reads require an authenticated user with the secret URL. The new API contract's visibility table says Anonymous access to Unlisted is allowed.
2. The frozen reference says Admin can restore a Tombstone. The new API contract says a tombstone “cannot be reactivated through the API” without distinguishing normal users from Admin restoration.
3. The new contract says write schemas use `additionalProperties: true` while also saying unknown request fields are rejected. These statements contradict each other.
4. It names `openapi.yaml` as canonical, but this commit does not add or update that file.

Do not silently choose new semantics in a persistence task. Either remove the accidental API contract from this change or revise it so it agrees with the frozen reference. If the user intends to change the frozen API behavior, that must be a separate explicit contract-change task, including OpenAPI and contract tests.

### P1 — Remove or quarantine the unrelated second schema/test runner

Files:

- `test/db/pearlhub_v0_1_schema.sql`
- `test/db/pearlhub_v0_1_schema_tests.sql`
- `test/scripts/run_pearlhub_schema_tests.sh`

These files introduce a second, 17-table schema plus a separate SQL test runner. The checked-in backend uses migrations 001–003 and the existing Vitest integration suite. The new runner defaults to absolute `/mnt/data/...` paths and does not apply the repository's migration chain. This contradicts the Chat 2.11 requirement not to add a parallel schema/migration/test path and will confuse future Copilot work.

Remove these files from the active repository scope, or move them to a clearly labelled non-executable archival/reference location only if there is a documented reason to retain them. They must not be presented as the application's current schema or test entry point.

### P1 — Make the review reproducible

The GitHub commit-status endpoint returned an empty status list for this SHA. Run and record the exact output of:

```sh
npm run build
npm run test:unit
npm run test:integration
```

The integration suite must use the repository's existing `TEST_DATABASE_URL` random-schema strategy and apply migrations 001, 002, then 003. If the database URL is unavailable, record integration tests as **SKIPPED**, not passed.

### P2 — Document legacy identity rollout explicitly

The migration intentionally leaves legacy `external_subject` values unmapped. That is the safe choice, but it means these users will not resolve through `UserIdentityRepository.findUserId(provider, subject)` until a trusted mapping is supplied. Document this operational consequence and a separate, explicit backfill procedure; do not infer that all legacy subjects belong to Firebase.

## 3. Targeted code-review notes

- The `tombstone_artifact` function snapshots only PostgreSQL metadata and content hashes/locations, not external content-store bytes. The documentation correctly acknowledges that the content store must retain referenced immutable objects. Keep this limitation explicit in the contract and operational retention policy.
- `RestoreArtifactService` checks Admin authorization in the Application layer; the DB function validates the persisted lifecycle state and original visibility. Keep both checks. Do not make the database function an authorization substitute.
- Ensure migration 003 is included in every migration path and integration-test bootstrap. Do not create another migration ledger/runner.
- Existing `users.external_subject` remains unique but nullable. That is acceptable for a transition, provided the legacy field's future deprecation policy is documented.

## 4. Acceptance checklist

- [ ] API contract contradictions are removed or corrected against the frozen reference.
- [ ] The unrelated 17-table schema and `/mnt/data` runner are removed from active repository scope.
- [ ] `npm run build` result is recorded.
- [ ] `npm run test:unit` result is recorded.
- [ ] `npm run test:integration` result is recorded, or explicitly marked SKIPPED with reason.
- [ ] Identity backfill/rollout limitations are documented without guessing providers.
- [ ] Migrations 001 and 002 remain unchanged; migration 003 remains the only additive persistence migration for this task.
- [ ] No Hono, Firebase token-verification, OpenAPI implementation, or Cloud Run work is pulled into this persistence close-out.

## 5. Next step after acceptance

Once the close-out checklist is green, proceed to **Chat 2.12 — Persistence Contract & Repository Integration Close-out** only if any mapping/transaction issues remain. Otherwise begin the next planned layer from the frozen project sequence; do not jump directly into Hono/API implementation without checking the current roadmap and contract artifacts first.
