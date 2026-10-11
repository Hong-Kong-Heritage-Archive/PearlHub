# PearlHub Chat 2.11 — PostgreSQL Persistence Mapping & Schema Plan

> **Purpose:** Implementation brief for GitHub Copilot. Use this document to inspect the existing repository, propose the smallest safe persistence changes, then implement and test them in the repository.
>
> **Status:** Proposed next-step plan. It does not itself authorize replacing existing migrations or rewriting the backend.
>
> **Source of truth:** Current checked-in code and `docs/backend/PearlHub_Chat_2.3-2.10_Frozen_Reference.md`. If this brief conflicts with the frozen reference, the frozen reference wins and the discrepancy must be reported before code changes.

## 1. Objective

Complete the next backend persistence step without re-generating the backend from scratch:

1. Audit current Domain objects, Repository Ports, PostgreSQL adapters, migrations, and integration tests.
2. Document how the frozen Domain contract maps to PostgreSQL.
3. Identify persistence invariants that are specified but not yet enforced or represented by the database.
4. Implement only confirmed gaps using forward-only migrations and the existing repository/test conventions.
5. Keep the code-generation work primarily in GitHub Copilot; do not create a parallel schema, migration runner, ORM, or alternate architecture.

## 2. Frozen architecture — do not reopen

- HTTP framework: **Hono**.
- API contract: **OpenAPI 3.1**.
- Runtime/deployment: **one standard OCI/Docker container on Google Cloud Run**; keep the application portable.
- Authentication prototype: **Firebase Authentication**, as one Identity Provider. Keep provider-specific token verification in Infrastructure / the Hono authentication adapter.
- Hono middleware authenticates requests and creates an abstract `AuthenticatedPrincipal`.
- Application owns authorization and use cases; Domain owns business invariants; Infrastructure owns PostgreSQL and external adapters.
- Domain/Application must not import Hono, Firebase SDK, PostgreSQL, Cloud Run, OpenAPI runtime code, or Gemini SDKs.
- Do not add an ORM or query builder. Use existing `pg` adapters, Repository Ports, and `TransactionManager` / `UnitOfWork` conventions.
- Never trust a client-supplied owner ID. The owner comes from the authenticated principal and persisted resource relationship.
- Artifact `id`, `name`, `slug`, and `ownerId` are immutable. Slug uniqueness is owner-scoped: `UNIQUE(owner_id, slug)`.
- Visibility values are `public`, `private`, `unlisted`; status values are `active`, `tombstone`. Tombstone is not a visibility value.
- Fork creates immutable lineage; Clone does not create lineage; GitHub import creates provenance and is not a Fork.
- Published Artifact Versions are immutable. SemVer 2.x parsing and range evaluation remain Domain/Application responsibilities, not SQL responsibilities.
- Deleting an Artifact means tombstoning it, setting visibility to `unlisted`, retaining its complete immutable snapshot and preserving lineage. Physical deletion is prohibited.
- Only Admin may read/restore a Tombstone. Restore returns the same Artifact identity to active state and must not rewrite history or lineage.

## 3. Current repository baseline

Inspect the current branch before editing. The expected baseline includes:

- `migrations/001_initial.sql`
- `migrations/002_persistence_hardening.sql`
- `docs/backend/01-domain-model.md`
- `docs/backend/02-postgresql-schema.md`
- `docs/backend/03-repository-interfaces.md`
- `docs/backend/04-application-services.md`
- `docs/backend/06-error-model.md`
- `docs/backend/07-test-plan.md`
- `docs/backend/PearlHub_Chat_2.3-2.10_Frozen_Reference.md`
- `src/domain/`
- `src/ports/`
- `src/adapters/postgres.ts`
- `tests/unit/`, `tests/application/`, and `tests/integration/postgres.test.ts`

The current schema contract documents eight tables: `users`, `artifacts`, `artifact_versions`, `artifact_lineage`, `provenances`, `dependencies`, `dependency_resolutions`, and `compatibility_reports`. Existing integration tests apply migrations in order to an isolated random PostgreSQL schema. Keep that strategy.

Do not assume that a path, table, or interface is unchanged from the above list. Verify the checked-in repository and report any baseline differences.

## 4. Identity persistence — design requirement

### Problem to investigate

The current `users.external_subject` is a single globally unique string. That does not explicitly represent which external Identity Provider issued the subject, while the frozen architecture permits Firebase Authentication as the prototype provider and future providers as alternatives.

### Required outcome

Design a provider-neutral identity mapping while preserving a stable internal PearlHub `UserId`.

- An internal PearlHub user must not be identified solely by a Firebase UID.
- External identity must be unambiguous by the pair `(provider, subject)` (or an equivalent explicit composite identity).
- Firebase-specific token claims and SDK objects must not leak into Domain or Application.
- `AuthenticatedPrincipal.userId` is the internal PearlHub user ID, not a client-supplied value.
- Existing local/test users and current integration fixtures must continue to work after a deliberate migration/fixture update.
- Never merge accounts from different providers merely because their email addresses match. Account linking is a separate authenticated use case and is out of scope unless already specified elsewhere.

### Copilot tasks

1. Inspect the current user Domain model, auth-related ports/adapters, and all references to `external_subject`.
2. Propose the smallest schema and mapping change that supports provider + subject while preserving internal `UserId`.
3. Document migration/backfill behavior for existing `external_subject` values. Do not silently infer an unknown provider for production data.
4. Update the schema docs and tests to match the approved mapping.
5. Do not implement Firebase token verification as part of this database task unless a checked-in task explicitly requires it.

## 5. Tombstone snapshot persistence — design requirement

### Contract

The frozen reference requires a complete immutable snapshot when an Artifact is tombstoned. The snapshot must preserve enough data to reconstruct the pre-deletion state for administrative inspection and restoration without rewriting historical versions or lineage.

At minimum, investigate preservation of:

- Artifact identity and metadata (`id`, owner, name, slug, pre-delete visibility/status, timestamps);
- every Artifact Version and its immutable identity/content metadata;
- instructions and knowledge-file content or immutable content references, plus their hashes;
- declared dependencies and relevant dependency resolution history, according to the frozen aggregate contract;
- provenance records;
- compatibility reports associated with the Artifact Versions;
- lineage/fork relationships and source-version references.

Do not copy secret credentials, authentication tokens, or user API keys into a snapshot. The database must never persist a user's Gemini API key.

### Design constraint

Do not assume a new JSONB snapshot table is automatically correct. First compare these options against current persistence and content-store semantics:

1. an immutable serialized snapshot record;
2. relational snapshot tables/rows;
3. immutable version/content references plus an immutable Artifact lifecycle snapshot.

Recommend the smallest option that genuinely preserves the frozen contract and can be tested. Explain how it interacts with external content storage: a PostgreSQL transaction cannot roll back a content-store write that has already completed. Do not claim cross-system atomicity where none exists.

### Required invariants

- The tombstone transition, snapshot creation, and visibility/status change must succeed or fail atomically within PostgreSQL.
- Repeated delete requests must not overwrite or mutate the original snapshot.
- The snapshot is append-only/immutable after creation.
- Lineage and historical versions remain unchanged.
- Restore must preserve Artifact ID, owner ID, name, slug, historical versions, and lineage.
- Restore must not delete the snapshot or rewrite it. If the model permits a later re-tombstone, define whether each lifecycle event gets its own immutable snapshot and document the rule before implementation.
- The existing `BEFORE DELETE` protection remains; do not introduce physical Artifact deletion as a shortcut.

### Copilot tasks

1. Trace `DeleteArtifactService`, `RestoreArtifact` (if implemented), Domain lifecycle methods, Repository Ports, `UnitOfWork`, and transaction tests.
2. Identify exactly which parts of the required snapshot are already recoverable from immutable records/content references and which are not.
3. Propose a persistence contract and migration plan before generating SQL.
4. Add integration tests that prove snapshot completeness/immutability, atomic rollback, lineage preservation, and restore semantics.
5. Do not add speculative snapshot fields unsupported by the frozen Domain contract.

## 6. Generated schema from the earlier ChatGPT share — how to reuse it

Treat the previously generated schema and migration bundle as a **reference for gap discovery only**, not as a replacement baseline.

- Do not copy its complete SQL file over `migrations/001_initial.sql` or `002_persistence_hardening.sql`.
- Do not introduce a second migration runner or a competing migration naming convention.
- Reuse useful constraints/triggers only after comparing them with existing migrations and tests.
- Reject global slug uniqueness; the frozen rule is owner-scoped uniqueness.
- Do not change `published_at` to nullable merely to stage a version within a transaction. Current persistence and the frozen immutable-published-version model require a deliberate lifecycle design, not an unreviewed schema change.
- Evaluate generated tags, clone-event records, extra version-child tables, and compatibility additions individually. Include only items required by the current v0.1 contract.
- Preserve the existing SQLSTATE/constraint-based error mapping and integration-test isolated-schema setup.

## 7. Migration policy

- Existing migrations are forward-only and must not be edited to retrofit a change that has already been applied.
- Add a new sequential migration only after the persistence contract and data migration behavior are documented.
- Migration must be safe for a fresh database and have an explicit strategy for an existing database.
- Never silently drop data, constraints, history, lineage, or identity mappings.
- Update `docs/backend/02-postgresql-schema.md` to match the actual final SQL, including tables, columns, indexes, constraints, triggers, and important invariants.
- Update integration fixtures to apply all migrations in order; do not hard-code a second schema definition in tests.

## 8. Required testing

Use the existing test commands and real PostgreSQL integration setup. Do not replace PostgreSQL integration tests with mocks.

At minimum, verify:

### Identity mapping
- one internal user can have an external identity for a provider;
- duplicate `(provider, subject)` is rejected;
- the same subject string from two different providers does not collide;
- existing fixture/migration behavior is explicit and deterministic;
- account identity cannot be selected by an unauthenticated client payload.

### Tombstone snapshot
- deletion creates exactly the expected immutable snapshot;
- tombstone status implies `unlisted` visibility;
- second delete does not overwrite the original snapshot;
- historical versions and lineage are retained;
- snapshot creation + tombstone update roll back together on failure;
- Admin restore returns the same Artifact identity and does not mutate history;
- physical Artifact deletion remains rejected.

### Existing regressions
- owner-scoped slug uniqueness;
- immutable Artifact identity;
- immutable published versions;
- dependency resolution cannot point to a version from the wrong target Artifact;
- Fork creates lineage, Clone does not, GitHub import creates provenance but not lineage;
- transaction manager semantics and current repository round-trips remain passing.

Run and report:

```sh
npm run build
npm run test:unit
npm run test:integration
```

If the integration suite is skipped because `TEST_DATABASE_URL` is absent, report it as skipped, not passed.

## 9. Scope boundaries

In scope:

- persistence contract documentation;
- minimal forward-only migration(s) for approved gaps;
- PostgreSQL mapping/adapters only where needed;
- Domain/Application changes only if the current checked-in contract lacks a necessary operation and the frozen reference supports it;
- unit/application/integration tests;
- accurate schema documentation and review checklist.

Out of scope:

- replacing the backend or reformatting unrelated files;
- changing Hono, OpenAPI 3.1, Cloud Run, Firebase-as-one-provider, or the layered architecture;
- implementing HTTP routes or Firebase middleware in this task;
- ORM/query builder;
- Playground, semantic search, frontend, or production deployment;
- storing Gemini API keys;
- merge/branch functionality;
- broad schema expansion based only on the generated reference SQL.

## 10. Required workflow for GitHub Copilot

### Phase A — inspect and report before coding

1. Read the frozen reference and current backend docs.
2. Inspect actual migrations, Domain model, ports, adapters, application services, and tests.
3. Produce a short gap matrix: `already implemented`, `missing`, `implemented differently`, `decision required`.
4. Recommend the smallest identity-mapping and snapshot persistence contract.
5. List exact files to change and migration/backfill risks.
6. Do not write SQL or application code during Phase A.

### Phase B — implement only after Phase A is internally consistent

1. Add the next forward-only migration(s), not edits to old migrations.
2. Update persistence mapping and application transaction boundaries only where necessary.
3. Add/adjust tests before declaring completion.
4. Update schema and implementation docs to match actual behavior.
5. Run all required checks and report exact outcomes.
6. Review the diff for accidental architecture changes or unrelated edits.

If a requirement cannot be satisfied without contradicting the frozen reference, stop and report the conflict rather than guessing.

## 11. Definition of done

- [ ] Current repository state was inspected; no generated schema was blindly copied.
- [ ] Identity mapping is provider-neutral and retains internal `UserId`.
- [ ] Tombstone snapshot contract is explicit and tested for completeness, immutability, atomicity, and restoration.
- [ ] Migrations are forward-only and existing data migration behavior is documented.
- [ ] Schema documentation matches the real SQL.
- [ ] Existing architectural decisions remain unchanged.
- [ ] `npm run build` passes.
- [ ] `npm run test:unit` passes.
- [ ] `npm run test:integration` passes against PostgreSQL, or is explicitly reported as skipped with reason.
- [ ] Copilot provides a concise summary of files changed, migration behavior, tests run, and unresolved decisions.
