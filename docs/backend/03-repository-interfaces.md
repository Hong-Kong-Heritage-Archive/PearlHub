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
