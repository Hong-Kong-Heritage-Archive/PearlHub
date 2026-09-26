# 05 — REST API Contract

The HTTP framework is intentionally unspecified.

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
