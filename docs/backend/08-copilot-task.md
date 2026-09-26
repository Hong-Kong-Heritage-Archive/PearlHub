# Copilot Task — Generate PearlHub Backend Skeleton

Implement the framework-neutral backend described by this directory.

## Phase 1 — Domain

Generate:

- value objects
- Artifact
- ArtifactVersion
- Dependency
- DependencyResolution
- Lineage
- Provenance
- CompatibilityReport
- domain errors
- SemVer validation

Write unit tests first.

## Phase 2 — Repository contracts

Generate TypeScript interfaces for:

- ArtifactRepository
- ArtifactVersionRepository
- LineageRepository
- ProvenanceRepository
- DependencyRepository
- CompatibilityReportRepository
- ArtifactContentStore

Do not implement HTTP framework code.

## Phase 3 — PostgreSQL

Generate:

- initial migration
- repository implementations
- integration tests

Use PostgreSQL constraints described in `02-postgresql-schema.md`.

## Phase 4 — Application services

Generate:

- CreateArtifactService
- PublishVersionService
- ForkArtifactService
- CloneArtifactService
- DeleteArtifactService
- ImportGitHubService
- ResolveDependencyService
- CreateCompatibilityReportService

Keep these framework-independent.

## Phase 5 — Contract tests

Generate request/response DTOs and contract-level tests from `05-api-contract.md`.

Do not implement routes yet.

## Important

Stop after Phase 5.

Do not select or add Hono, Fastify, NestJS, Express, or another HTTP framework.

At the end, report:

- files created
- tests created
- tests passed/failed
- unresolved design questions
- assumptions made

Do not silently invent new product requirements.
