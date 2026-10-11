# PearlHub — Chat 2.11.1 Post-Cleanup Verification

**Repository:** `Hong-Kong-Heritage-Archive/PearlHub`  
**Reviewed commit:** `aacc189c5cdbd7ca423eeb7e19ab608a066c7ec2` (`clean up`)  
**Previous persistence commit:** `ed8e2e618eeb696080d8b4c8ec9968a76f9b2f5e`  
**Review mode:** GitHub source inspection; no commands executed locally.

## 1. Changes verified in `main`

The latest commit includes the expected cleanup:
- API prose now distinguishes normal user tombstone behavior from privileged Admin restoration.
- Unlisted access requires authentication and the secret URL.
- The conflicting `additionalProperties: true` / reject-unknown-fields statements were removed.
- The 17-table generated SQL schema, standalone SQL assertions, and `/mnt/data`-dependent runner were deleted.
- The persistence schema document describes legacy identity rollout and external content-store retention.

Commit: https://github.com/Hong-Kong-Heritage-Archive/PearlHub/commit/aacc189c5cdbd7ca423eeb7e19ab608a066c7ec2

## 2. Remaining verification items

### P1 — Test results are not independently evidenced

GitHub returned an empty status list for the latest commit. This does not prove tests failed; it means this review cannot claim they passed.

Run and record:

```sh
npm run build
npm run test:unit
npm run test:integration
```

The integration suite should use `TEST_DATABASE_URL`, create a random schema, and apply migrations 001, 002, and 003 in order. If the database is unavailable, record integration tests as **SKIPPED**, not passed.

### P1 — Development setup instructions are stale

`docs/backend/DEV_ENVIRONMENT_SETUP.md` still says framework selection is deferred and documents initializing only `migrations/001_initial.sql`. This conflicts with `docs/backend/PearlHub_Chat_2.3-2.10_Frozen_Reference.md`, which freezes Hono, OpenAPI 3.1, and Cloud Run, and with the current persistence chain through migration 003.

Update the setup guide to distinguish the frozen decision to use Hono from whether the Hono server adapter has been implemented yet. Document a safe fresh-database path applying migrations 001 → 002 → 003, or clearly identify the existing integration suite as the authoritative disposable-schema bootstrap. Do not reapply migration 001 to an already initialized database.

### P2 — Persistence test coverage

Confirm integration coverage for:
- identity lookup and duplicate `(provider, subject)` rejection;
- complete metadata snapshot on tombstoning;
- snapshot immutability;
- Admin restore preserving identity and original visibility;
- retention of lineage, versions, dependencies, provenance, and compatibility reports;
- rollback behavior when tombstoning fails.

Do not add another migration runner or schema definition.

## 3. Frozen constraints

- Hono remains the selected HTTP framework.
- OpenAPI 3.1 remains the API contract.
- Cloud Run runs a standard portable OCI/Docker container.
- Firebase Authentication is an Infrastructure provider, not PearlHub's internal identity.
- Preserve internal `users.id`; do not infer a provider for legacy `external_subject`.
- Keep migrations 001 and 002 unchanged; migration 003 is forward-only.
- No ORM, wholesale code generation, or parallel schema/test path.
- Keep work Markdown-first; Copilot should implement only approved changes.

## 4. Acceptance gate

Chat 2.11.1 is accepted when:
- [ ] build result is recorded;
- [ ] unit-test result is recorded;
- [ ] integration-test result is recorded or explicitly skipped with reason;
- [ ] `DEV_ENVIRONMENT_SETUP.md` matches frozen architecture;
- [ ] fresh setup and migration order are documented accurately;
- [ ] tombstone/restore and identity tests cover the frozen invariants;
- [ ] no duplicate schema or migration runner is reintroduced.

Only then move to the next planned implementation phase.
