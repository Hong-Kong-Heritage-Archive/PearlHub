# 07 — Test Plan

Generate tests before adding framework-specific API code.

## Domain tests

### Artifact

- create valid Artifact
- reject empty/invalid name
- reject invalid slug
- allow same slug for different owners
- reject duplicate slug for same owner
- reject name mutation
- reject slug mutation
- reject owner mutation

### SemVer

- accept valid SemVer 2.x
- reject `v1`
- reject `latest`
- reject date-style versions
- validate ranges such as `^2.1.0`
- verify `2.4.3` satisfies `^2.1.0`

### Tombstone

- delete converts active Artifact to tombstone
- tombstone becomes unlisted
- snapshot remains available
- lineage remains available
- no physical Artifact deletion operation

### Version

- create version
- reject duplicate version
- reject invalid SemVer
- reject modification of published version

### Fork

- fork creates new Artifact
- fork creates lineage
- source remains unchanged

### Clone

- clone creates new Artifact
- clone does not create lineage

### GitHub Import

- import creates provenance
- import does not create fork lineage

### Dependency

- store declared range
- resolve compatible version
- store resolved Artifact Version
- reject invalid ranges
- do not mutate source versions

### Compatibility

- report points to Artifact Version
- optional target points to Artifact Version

## Repository integration tests

Use a real PostgreSQL test database or ephemeral PostgreSQL environment.

Test:

- constraints
- foreign keys
- unique owner/slug
- unique artifact/version
- lineage integrity
- dependency relationships
- compatibility relationships

## Application service tests

Mock/fake repositories and content store.

Test:

- authorization boundaries
- transaction behavior
- invariant enforcement
- failure rollback semantics

## Acceptance criteria

Copilot should not claim completion until:

1. TypeScript compiles.
2. Unit tests pass.
3. Repository integration tests pass.
4. No HTTP framework dependency exists in domain/application packages.
5. Frozen architectural decisions remain unchanged.
