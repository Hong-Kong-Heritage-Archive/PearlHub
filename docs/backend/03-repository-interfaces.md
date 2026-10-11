# 03 — Repository Interfaces

Repository interfaces are framework-independent.

They must not import:

- Hono
- Fastify
- NestJS
- Express
- HTTP request/response types

## ArtifactRepository

Required operations:

- `findById(id)`
- `findByOwnerAndSlug(ownerId, slug)`
- `create(artifact)`
- `save(artifact)`
- `tombstone(artifact)` — atomically persist the tombstone snapshot and lifecycle transition
- `restore(artifact)` — restore the existing Artifact identity from a tombstone
- `findTombstoneSnapshotArtifact(id)` — retrieve the Artifact state captured before deletion

## ArtifactVersionRepository

Required operations:

- `findById(id)`
- `findByArtifactAndVersion(artifactId, version)`
- `findLatest(artifactId)`
- `create(version)`

## LineageRepository

Required operations:

- `createFork(parentArtifactId, childArtifactId)`
- `getParents(artifactId)`
- `getChildren(artifactId)`

Fork creation also records the selected source Artifact Version when available.

## UserIdentityRepository

- `findUserId(provider, subject)`
- `create(identity)`

`UserId` remains the internal PearlHub identity. External identities are unique by
`(provider, subject)`; provider-specific token verification stays in Infrastructure.
Legacy `users.external_subject` values are not assigned a provider by migration.

## ProvenanceRepository

Required operations:

- `create(provenance)`
- `findForVersion(versionId)`

## DependencyRepository

Required operations:

- `findForVersion(versionId)`
- `create(dependency)`
- `createResolution(resolution)`
- `findResolutions(dependencyId)`

## CompatibilityReportRepository

Required operations:

- `create(report)`
- `findForArtifactVersion(versionId)`

## ArtifactContentStore

Required operations:

- `put(content, contentHash)`
- `get(location)`
- `exists(contentHash)`

The content store must not expose S3/MinIO-specific concepts to the domain.
