# 05 — REST API Contract

The canonical machine-readable OpenAPI 3.1 contract is the repository-root
`openapi.yaml`; the Hono adapter serves its runtime-generated representation
at `/openapi.json`. Pearl is the product concept; Artifact is the API/domain
resource. All paths below are relative to `/api/v1`.

## Implemented workflow

An Artifact is created only by publishing its first Draft. Draft writes require
bearer authentication, derive ownership from the authenticated principal, and
use revision checks for updates and publication.

| Method | Path | Behavior |
|---|---|---|
| GET | `/artifacts` | Discover visible Artifacts |
| POST | `/artifacts` | Retired; returns `410 ARTIFACT_CREATION_REQUIRES_DRAFT` |
| POST | `/drafts` | Create a private Draft with initial content |
| GET | `/drafts` | List active Draft summaries owned by the caller |
| GET | `/drafts/{draftId}` | Read an owner-authorized Draft |
| PUT | `/drafts/{draftId}` | Replace Draft content using the current revision |
| DELETE | `/drafts/{draftId}?revision={revision}` | Discard an unpublished Draft |
| POST | `/drafts/{draftId}/publish` | Atomically create first Artifact and immutable `0.1.0` version |
| GET | `/artifacts/{artifactId}/versions` | List published versions |
| GET | `/artifacts/{artifactId}/versions/{version}` | Read a complete immutable version snapshot |
| POST | `/artifacts/{artifactId}/versions/{version}/work-copy` | Create the owner's editable Draft from a version |
| POST | `/artifacts/{artifactId}/clone` | Create an owner-bound Draft from an exact readable Version without lineage |

The first publish stores the Artifact, complete content snapshot, dependency
declarations, discovery projection, and consumed Draft in one PostgreSQL
transaction. Subsequent work-copy publication increments the latest SemVer
patch component; the source version must still be current when publishing.
Existing versions whose content was not persisted before migration 005 remain
readable as metadata but return `409 VERSION_CONTENT_UNAVAILABLE` for full
content reads and work-copy creation.

## Not implemented

Artifact metadata lookup/update and tombstoning; direct Version creation;
Fork, Import, dependency resolution, and compatibility reports remain outside
this slice. Published versions have no update or delete operation.

## API error shape

```json
{
  "error": {
    "code": "DRAFT_REVISION_CONFLICT",
    "message": "Draft revision is stale.",
    "details": {}
  }
}
```
