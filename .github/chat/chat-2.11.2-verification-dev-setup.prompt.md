# GitHub Copilot Prompt — PearlHub Chat 2.11.2 Verification & Dev Setup Alignment

Repository: `Hong-Kong-Heritage-Archive/PearlHub`

Review latest cleanup commit:
`aacc189c5cdbd7ca423eeb7e19ab608a066c7ec2`

## Read first
- `docs/backend/PearlHub_Chat_2.3-2.10_Frozen_Reference.md`
- `docs/backend/DEV_ENVIRONMENT_SETUP.md`
- `docs/backend/02-postgresql-schema.md`
- `docs/backend/CHAT-2.11-POSTGRESQL-PERSISTENCE-MAPPING-AND-SCHEMA-PLAN.md`
- `migrations/001_initial.sql`
- `migrations/002_persistence_hardening.sql`
- `migrations/003_identity_mapping_and_tombstone_snapshots.sql`
- `tests/integration/postgres.test.ts`
- `package.json`

## Primary goal
Close remaining Chat 2.11.1 acceptance gaps with Markdown-first, minimal changes. Do not start Hono/API implementation in this task.

## Frozen decisions — do not change
- Hono is the selected HTTP framework.
- API contract is OpenAPI 3.1.
- Host is Google Cloud Run using a standard OCI/Docker container.
- Firebase Authentication is one Infrastructure auth provider; internal PearlHub `users.id` remains authoritative.
- Preserve provider-neutral `(provider, subject)` identity mapping. Never guess a provider for legacy `external_subject`.
- Keep layering: Hono → Application → Domain → Repository Ports → Infrastructure.
- Do not add an ORM, a second schema, a second migration runner, or regenerate the backend.
- Never rewrite migrations 001 or 002. Migration 003 is additive and forward-only.
- Main PostgreSQL integration path is the existing Vitest suite with a disposable random schema applying migrations 001 → 002 → 003.
- Prefer Markdown specification and evidence over generated code.

## Phase A — inspection only, then stop
Do not edit files or run destructive commands yet.

1. Inspect the latest commit and confirm the API contract and generated-schema cleanup.
2. Identify exact stale statements in `docs/backend/DEV_ENVIRONMENT_SETUP.md`, especially the claim that framework selection is deferred and the initialization instructions that apply only migration 001.
3. Verify the actual test bootstrap and whether migrations 001, 002, and 003 are applied in order.
4. Inspect tests for identity mapping, tombstone snapshot coverage/immutability, Admin restore, lineage preservation, and transaction rollback.
5. Determine whether CI exists and whether actual results for `npm run build`, `npm run test:unit`, and `npm run test:integration` are available. Do not infer a pass from missing status checks.
6. Return a concise matrix: Finding | Severity | File/line evidence | Minimal change | Verification needed.

Then STOP and wait for approval before modifying files.

## Phase B — after approval
Make only the minimum approved changes:
- Correct `DEV_ENVIRONMENT_SETUP.md` to match frozen architecture while accurately distinguishing a frozen framework choice from whether the Hono adapter has already been implemented.
- Document safe fresh-database initialization/migration order for 001 → 002 → 003, without recommending reapplication of old migrations to an initialized database.
- Add or adjust tests only where the existing integration suite lacks essential coverage for the frozen persistence contract.
- Do not change product semantics, public API behavior, domain rules, or schema decisions without explicitly raising the decision.
- Do not reintroduce the deleted 17-table SQL schema or `/mnt/data` runner.
- Do not implement Hono routes, Firebase token verification, OpenAPI runtime validation, or Cloud Run deployment here.

## Required checks
Run and report exact results for:

```sh
npm run build
npm run test:unit
npm run test:integration
```

If `TEST_DATABASE_URL` is unavailable, mark integration tests **SKIPPED** and state why. Never claim tests passed unless they actually ran.

## Final response format
- Changed files and why
- Exact test commands and observed results
- Migration history preserved?
- Remaining blockers / decisions
- Explicit acceptance status: PASS, FAIL, or BLOCKED

Do not begin the next implementation phase until this acceptance gate is satisfied.
