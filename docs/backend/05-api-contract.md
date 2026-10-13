# 05 — REST API Contract

The REST resource contract is framework-neutral. The initial HTTP adapter uses
Hono; its OpenAPI 3.1 document is served at `/openapi.json`.

Base path:

`/api/v1`

## Artifacts

### POST /artifacts

Create an Artifact.

Request:

```json
{
  "name": "Example Pearl",
  "slug": "example-pearl",
  "visibility": "public"
}
```

The implemented `POST /api/v1/artifacts` operation requires bearer
authentication. The owner is taken only from the authenticated internal user
identity; the request body does not accept `ownerId`. It returns `201` with the
created Artifact, or `400`, `401`, `409`, or `500` using the standard API error
shape.

### GET /artifacts

List/search Artifacts.

The implementation may start with basic keyword/tag filtering only.

### GET /artifacts/:artifactId

Return Artifact metadata.

### PATCH /artifacts/:artifactId

Only mutable metadata may be changed.

Must reject attempts to change:

- name
- slug
- owner

### DELETE /artifacts/:artifactId

Converts the Artifact to a tombstone.

## Versions

### GET /artifacts/:artifactId/versions

List versions.

### POST /artifacts/:artifactId/versions

Publish a new immutable version.

### GET /artifacts/:artifactId/versions/:version

Return a specific version.

There is no PATCH endpoint for published versions.

## Fork and Clone

### POST /artifacts/:artifactId/fork

Creates a new Artifact and permanent fork lineage.

### POST /artifacts/:artifactId/clone

Creates a new Artifact without PearlHub lineage.

## GitHub Import

### POST /imports/github

Import a Pearl from a GitHub source URL.

The import creates provenance, not fork lineage.

## Dependencies

### GET /artifacts/:artifactId/dependencies

Return dependency information relevant to the Artifact.

### POST /dependencies/resolve

Resolve declared SemVer ranges and record resolved versions.

## Compatibility

### POST /compatibility/reports

Create a compatibility report.

### GET /artifacts/:artifactId/compatibility

List compatibility reports.

## Public identity URL

Human-facing Artifact URL:

`/@{owner}/{slug}`

The API should continue to use immutable Artifact UUIDs internally.

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
