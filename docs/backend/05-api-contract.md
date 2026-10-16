# 05 — REST API Contract

The REST resource contract is framework-neutral. The canonical machine-readable
OpenAPI 3.1 contract is the repository-root `openapi.yaml`; the Hono adapter
serves its runtime-generated representation at `/openapi.json`.

Pearl is the product concept; Artifact is the API/domain resource. Only the
create operation below is implemented and included in OpenAPI. Other operations
described here are planned and are not runtime routes.

Base path:

`/api/v1`

## Artifacts

### POST /artifacts — implemented

Create an Artifact.

Request:

```json
{
  "name": "Example Pearl",
  "slug": "example-pearl",
  "visibility": "public"
}
```

The request body is strict and accepts exactly `name`, `slug`, and `visibility`;
unknown properties, including `ownerId`, are rejected. The operation requires
HTTP bearer authentication. Ownership is derived from the verified,
provider-neutral authenticated principal and is returned as `ownerId`.

It returns `201` with an Artifact containing `id`, `ownerId`, `name`, `slug`,
`visibility`, `status`, `createdAt`, and `updatedAt`. `id`, `name`, `slug`, and
`ownerId` are immutable. Errors use `{ "error": { "code", "message", "details" } }`
with actual response statuses `400`, `401`, `409`, or `500`.

### GET /artifacts — planned

List/search Artifacts.

The implementation may start with basic keyword/tag filtering only.

### GET /artifacts/:artifactId — planned

Return Artifact metadata.

### PATCH /artifacts/:artifactId — planned

Only mutable metadata may be changed.

Must reject attempts to change:

- name
- slug
- owner

### DELETE /artifacts/:artifactId — planned

Converts the Artifact to a tombstone.

## Versions

### GET /artifacts/:artifactId/versions — planned

List versions.

### POST /artifacts/:artifactId/versions — planned

Publish a new immutable version.

### GET /artifacts/:artifactId/versions/:version — planned

Return a specific version.

There is no PATCH endpoint for published versions.

## Fork and Clone

### POST /artifacts/:artifactId/fork — planned

Creates a new Artifact and permanent fork lineage.

### POST /artifacts/:artifactId/clone — planned

Creates a new Artifact without PearlHub lineage.

## GitHub Import

### POST /imports/github — planned

Import a Pearl from a GitHub source URL.

The import creates provenance, not fork lineage.

## Dependencies

### GET /artifacts/:artifactId/dependencies — planned

Return dependency information relevant to the Artifact.

### POST /dependencies/resolve — planned

Resolve declared SemVer ranges and record resolved versions.

## Compatibility

### POST /compatibility/reports — planned

Create a compatibility report.

### GET /artifacts/:artifactId/compatibility — planned

List compatibility reports.

## Public identity URL

Human-facing Artifact URL:

`/@{owner}/{slug}`

The API should continue to use immutable Artifact UUIDs internally.

No slug-based lookup operation is currently implemented or described in
OpenAPI.

## API error shape

```json
{
  "error": {
    "code": "ARTIFACT_NAME_IMMUTABLE",
    "message": "Artifact name cannot be changed.",
    "details": {}
  }
}
```
