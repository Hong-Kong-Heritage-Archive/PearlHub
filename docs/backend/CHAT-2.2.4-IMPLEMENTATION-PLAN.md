# Chat 2.2.4 — PostgreSQL Integration & Transaction Reliability

## Baseline

Source of truth: `Hong-Kong-Heritage-Archive/PearlHub`, current `main` at commit `6ca7cce9549b59abc73087d11a42f51bcfb4efa6` (`check-in for postgresql-repository`, 2026-09-30).

Frozen architecture:

```text
HTTP/API
  ↓
Application
  ↓
Domain
  ↓
Infrastructure
```

Chat 2.2.4 does not introduce HTTP/API framework work.

## Objective

Verify and, only where demonstrated necessary, harden PostgreSQL transaction reliability and repository integration without changing the frozen schema or domain model.

## Current state observed

- `TransactionManager` remains framework-independent: `run<T>(work)`.
- `PostgresTransactionManager` uses `AsyncLocalStorage<PoolClient>` so repository queries inside `run()` share one checked-out client.
- Nested transactions are explicitly unsupported and rejected before checkout.
- Repository adapters accept a narrow `Queryable`; PostgreSQL details remain in infrastructure.
- Constraint translation maps PostgreSQL SQLSTATE/constraint metadata into domain errors.
- Real PostgreSQL integration tests already cover rollback, commit/reuse, concurrent slug insertion, duplicate versions, dependency target integrity, JSONB compatibility reports, and deterministic reads.
- `TEST_DATABASE_URL` uses an isolated random schema and the integration suite applies the two frozen migrations to that schema.
- Existing review documentation reports `npm run build`, `npm run test:unit`, and `npm run test:integration` passing on the checked-in 2.2.3 state.

## Reliability gaps to verify

### 1. Transaction lifecycle failure paths

Explicitly test:

- `BEGIN` succeeds → work succeeds → `COMMIT` succeeds.
- `BEGIN` succeeds → work fails → `ROLLBACK` succeeds → original error escapes.
- Repository work uses the same physical client throughout one transaction.
- A transaction client is released after success.
- A transaction client is released after work failure.
- A subsequent transaction can obtain and use a healthy client.
- Nested `run()` rejects without acquiring another pool client.
- `BEGIN` failure does not leak a client.
- `COMMIT` failure does not leak a client.
- `ROLLBACK` failure does not leak a client.
- If rollback itself fails, define and test the error-preservation policy rather than accidentally masking the original failure.
- If commit fails, define the transaction-outcome/diagnostic policy explicitly; do not pretend the commit outcome is known when PostgreSQL/connection failure makes it ambiguous.

Prefer a small injectable pool/client seam only if required to test these failure paths. Do not expose that seam through domain/application ports.

### 2. Application transaction boundaries

Verify that multi-write use cases are atomic when a transaction manager is supplied:

- PublishVersion: version + dependency declarations.
- ForkArtifact: new Artifact + copied Version + copied dependencies + lineage.
- CloneArtifact: new Artifact + copied Version + copied dependencies, without lineage.
- ImportGitHub: Artifact + Version + provenance.
- ResolveDependencies: all resolution records for one operation.

Single-write lifecycle operations do not require artificial transactions merely for consistency:

- CreateArtifact: database uniqueness is authoritative.
- DeleteArtifact: one tombstone update.

The database constraint must remain the concurrency authority; do not introduce SELECT-then-INSERT locking as a substitute.

### 3. Repository round-trip integrity

For every repository:

- create → read-back equality;
- not-found/empty collection behavior;
- deterministic ordering;
- nullable fields;
- UUID identity preservation;
- timestamp preservation;
- cross-artifact filtering;
- parameterized SQL;
- constraint/error translation.

### 4. Dependency resolution integrity

Verify both application and database layers:

- declared SemVer range is preserved;
- resolved version is concrete;
- resolved version belongs to the dependency target Artifact;
- wrong-target version is rejected by PostgreSQL;
- resolution records round-trip unchanged;
- multiple resolutions remain deterministically ordered;
- resolver selects a compatible SemVer version without mutating published Versions.

Do not change the frozen schema or public dependency model.

### 5. Compatibility JSONB

Verify:

- null target;
- concrete target;
- nested objects;
- arrays;
- booleans;
- numbers;
- strings;
- JSONB round-trip equality;
- deterministic record ordering;
- invalid source/target foreign keys.

Do not add JSON schema validation to PostgreSQL.

### 6. Concurrency

Keep the database unique constraint authoritative.

Test at minimum:

- two concurrent inserts for the same `(owner_id, slug)`: exactly one succeeds;
- same slug under different owners: both succeed;
- concurrent duplicate `(artifact_id, version)`: exactly one succeeds;
- no partially persisted aggregate is visible after a failed transactional operation.

Avoid timing-based sleeps. Use `Promise.allSettled` and independent database operations.

## Expected implementation scope

Likely files:

- `src/adapters/postgres.ts` — only if transaction failure semantics require a real fix.
- `tests/integration/postgres.test.ts` — transaction lifecycle, repository/application round-trip, and concurrency coverage.
- `tests/application/services.test.ts` — transaction-boundary assertions where useful.
- `docs/backend/2.2.4-postgresql-integration-transaction-reliability.md` — this specification.
- `docs/backend/2.2.4-review-checklist.md` — acceptance checklist.
- `.github/copilot-instructions.md` — only if task-specific Copilot guidance is intentionally added.
- `.github/prompts/chat-2.2.4-postgresql-integration.prompt.md` — implementation prompt package.

Do not modify:

- `migrations/001_initial.sql`
- `migrations/002_persistence_hardening.sql`

unless a reproducible database defect is demonstrated and separately documented.

## Error translation policy

Keep the existing precedence:

1. SQLSTATE;
2. named constraint;
3. secondary metadata only where unavoidable.

Do not use PostgreSQL human-readable messages as the primary classifier.

Unexpected PostgreSQL errors must remain diagnosable and must not be silently converted into an unrelated domain error.

## Integration-test infrastructure

The current isolated-schema strategy should remain the default:

1. connect using `TEST_DATABASE_URL`;
2. create a random schema;
3. create PostgreSQL pools using that schema as `search_path`;
4. apply `001_initial.sql` then `002_persistence_hardening.sql`;
5. seed only test users;
6. drop only the temporary schema at teardown.

Improve cleanup/reliability only if tests demonstrate a real problem.

Potential hardening:

- ensure pools are always closed in teardown;
- avoid parallel tests mutating shared fixture IDs;
- keep all test data scoped to the generated schema;
- make test failures actionable when PostgreSQL is unavailable;
- do not silently connect integration tests to a production/shared database.

## Acceptance criteria

All must hold:

- `npm run build` passes.
- `npm run test:unit` passes.
- `npm run test:integration` passes against real PostgreSQL.
- transaction success/rollback/release behavior is proven.
- no connection/client leak is demonstrated.
- nested transaction behavior is explicit and tested.
- multi-write application operations are atomic where transaction support is provided.
- repository round-trips are correct.
- duplicate slug/version behavior remains database-authoritative.
- dependency resolution target integrity remains enforced.
- compatibility JSONB round-trip is proven.
- concurrency tests are stable.
- frozen migrations are unchanged unless a real defect is demonstrated.
- no ORM/query builder/framework is introduced.
- no domain model redesign.
- no HTTP/API/frontend/Playground/search/object-storage work.
- final report records exact commands and results.

## Stop condition

After Chat 2.2.4 implementation and verification, stop. Do not begin HTTP framework/API selection or later feature work.
