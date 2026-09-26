# PearlHub Backend — GitHub Copilot Instructions

## Purpose

Implement and test the PearlHub backend from the framework-neutral contract in `docs/backend/`.

Do NOT choose or introduce an HTTP framework yet. The framework decision is intentionally deferred.

## Frozen architectural decisions

- Artifact `name` is immutable.
- Artifact `slug` is immutable.
- Artifact `owner` is immutable.
- Artifact slug is owner-scoped: `UNIQUE(owner_id, slug)`.
- Artifact deletion creates a Tombstone:
  - status = `tombstone`
  - visibility = `unlisted`
  - preserve the complete immutable snapshot
  - preserve lineage
- Version format is SemVer 2.x.
- Published Artifact Versions are immutable.
- Dependency declarations use SemVer ranges.
- Dependency resolution records both the declared range and the resolved Artifact Version.
- GitHub Import is provenance/source metadata, NOT a Fork.
- Fork creates permanent PearlHub lineage.
- Clone creates no PearlHub lineage.
- Compatibility reports point to Artifact Version, not merely Artifact.
- MVP has no Merge, Branch, or Scripts.
- Portability is a core principle.
- Pearl content should not depend on the eventual HTTP framework.
- Playground uses the user's Gemini API key; PearlHub must not store that key.

## Implementation rules

1. Keep domain logic framework-independent.
2. Keep repository interfaces independent of PostgreSQL implementation.
3. Keep content storage independent of S3/MinIO/local filesystem.
4. Use explicit application services/use cases.
5. Do not silently change frozen decisions.
6. Do not add features that are outside the current contract.
7. Prefer small, testable modules.
8. Add unit tests for domain invariants and application services.
9. Add integration tests for PostgreSQL repositories.
10. Add API/adapter tests only after the framework is selected.
11. Never add a second source of truth for domain rules.
12. Do not implement physical deletion for Artifacts.

## Current task

Generate the framework-neutral backend skeleton, domain model, repository interfaces, application services, PostgreSQL migration, and tests described in `docs/backend/`.

The generated code must compile and tests must pass before proposing additional architecture.
