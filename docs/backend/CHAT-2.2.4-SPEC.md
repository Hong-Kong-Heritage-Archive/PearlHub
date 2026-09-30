# Chat 2.2.4 — PostgreSQL Integration & Transaction Reliability Specification

## 1. Transaction contract

`TransactionManager.run()` is the only transaction abstraction visible above infrastructure.

The PostgreSQL adapter owns:

- connection checkout;
- `BEGIN`;
- `COMMIT`;
- rollback on work failure;
- client release;
- transaction-local query routing.

Repositories must continue to receive only a `Queryable` abstraction.

### Required invariants

1. Queries executed inside one `run()` use the same `PoolClient`.
2. Queries outside `run()` use the pool normally.
3. Nested `run()` is rejected because nested transaction semantics are not part of the frozen contract.
4. A checked-out client is always released.
5. A work failure causes rollback before the original work error is propagated, subject to the explicitly documented rollback-failure policy.
6. Commit success means the transaction is complete before the client is released.
7. Commit/rollback/connection failures must never leak the client.
8. The adapter must not claim certainty about commit outcome after an ambiguous connection-level failure.

## 2. Transaction failure policy

Implement the smallest reliable policy supported by `pg`:

- Work error: attempt `ROLLBACK`; if rollback succeeds, rethrow the original error.
- Work error + rollback error: preserve the original work error and retain rollback failure as secondary diagnostic information where practical.
- Commit error: do not report success. Ensure the client is released; if a rollback is safe/possible, attempt it, but do not mask the commit error with an unrelated rollback failure.
- BEGIN error: release the client and propagate the BEGIN error.
- Any failure during cleanup must not cause a client leak.

Do not introduce a custom transaction type into the domain.

## 3. Application atomicity

A transaction should surround all persistence writes belonging to one use case:

| Use case | Transactional writes |
|---|---|
| PublishVersion | Version + dependency declarations |
| ForkArtifact | Artifact + Version + dependency copies + lineage |
| CloneArtifact | Artifact + Version + dependency copies |
| ImportGitHub | Artifact + Version + provenance |
| ResolveDependencies | all resolution records produced by one call |
| DeleteArtifact | single tombstone update; transaction optional |
| CreateArtifact | single insert; database UNIQUE is authoritative |

Content storage is an external port. The transaction can roll back database state, but cannot magically undo an external content-store write. This limitation must be documented rather than hidden.

## 4. Repository contract

Repositories must remain:

- framework-independent;
- ORM-free;
- query-builder-free;
- parameterized;
- explicit-column based;
- deterministic in collection ordering.

`findLatest()` remains application-side SemVer ordering.

## 5. Constraint translation

Expected mappings remain stable:

- owner-scoped slug unique violation → `ARTIFACT_SLUG_CONFLICT`;
- duplicate Artifact Version → `VERSION_ALREADY_EXISTS`;
- immutable owner/name/slug → corresponding immutable domain errors;
- immutable published Version → `VERSION_IMMUTABLE`;
- invalid lineage → `LINEAGE_INVALID`;
- other known persistence constraint failures → stable `INVALID_REQUEST` where the existing error model requires it;
- unknown DB errors → rethrow unchanged.

Tests must assert SQLSTATE and constraint metadata where stable.

## 6. Dependency resolution

Persistence must preserve:

```text
Dependency.targetArtifactId
Dependency.declaredRange
DependencyResolution.resolvedArtifactVersionId
DependencyResolution.resolvedAt
```

The frozen PostgreSQL composite foreign keys remain the authoritative protection against resolving to a Version belonging to another Artifact.

## 7. Compatibility reports

`compatibility_reports.report` remains PostgreSQL `JSONB`.

The repository must round-trip structured JSON without stringification artifacts.

Required cases:

```json
{}
```

```json
{
  "summary": "ok",
  "checks": [
    { "name": "schema", "passed": true }
  ]
}
```

and a report containing nested objects, arrays, booleans, numbers, and strings.

## 8. Concurrency

Do not implement:

```text
SELECT existing
IF none
  INSERT
```

as the source of uniqueness correctness.

Application pre-checks may remain for user-friendly errors, but PostgreSQL `UNIQUE(owner_id, slug)` and `UNIQUE(artifact_id, version)` remain authoritative.

Concurrent tests must prove that exactly one duplicate insert succeeds.

## 9. Integration-test isolation

Use the existing generated schema approach.

Never:

- drop the development database;
- truncate unrelated schemas;
- assume fixed UUIDs shared across tests;
- depend on test execution order.

The test database must be disposable and isolated.

## 10. Schema freeze

No migration changes are part of normal Chat 2.2.4 work.

A schema change is allowed only if a reproducible defect is demonstrated and the smallest correction is separately reviewed.
