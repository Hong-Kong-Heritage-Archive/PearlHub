# 05 — REST API Contract

The canonical machine-readable OpenAPI 3.1 contract is the repository-root
`openapi.yaml`; the Hono adapter serves its runtime-generated representation
at `/openapi.json`. Pearl is the product concept; Artifact is the API/domain
resource. All paths below are relative to `/api/v1`.

## Implemented workflow

An Artifact is created only by publishing its first Draft. Draft writes require
bearer authentication, derive ownership from the authenticated principal, and
use revision checks for updates and publication.

`GET /me` also requires bearer authentication and returns only
`{ "userId": "<authenticated principal ID>" }`. It does not expose tokens,
profile data, or user lookup capabilities. The development-only fake
authenticator remains a local testing convenience, not a production login
system.

| Method | Path | Behavior |
|---|---|---|
| GET | `/artifacts` | Discover visible Artifacts |
| GET | `/me` | Read the authenticated caller's stable user ID |
| POST | `/artifacts` | Retired; returns `410 ARTIFACT_CREATION_REQUIRES_DRAFT` |
| POST | `/drafts` | Create a private Draft with initial content |
| GET | `/drafts` | List active Draft summaries owned by the caller |
| GET | `/drafts/{draftId}` | Read an owner-authorized Draft |
| PUT | `/drafts/{draftId}` | Replace Draft content using the current revision |
| DELETE | `/drafts/{draftId}?revision={revision}` | Discard an unpublished Draft |
| POST | `/drafts/{draftId}/publish` | Atomically create first Artifact and immutable `0.1.0` version |
| GET | `/artifacts/{artifactId}/versions` | List published versions |
| GET | `/artifacts/{artifactId}/versions/{version}` | Read a complete immutable version snapshot |
| GET | `/artifacts/{artifactId}/versions/{version}/dependencies` | Read declarations and persisted resolution history for the exact version |
| GET | `/artifacts/{artifactId}/versions/{version}/compatibility` | Read persisted compatibility reports for the exact version |
| PATCH | `/artifacts/{artifactId}` | Owner-only partial metadata update; currently visibility only |
| POST | `/artifacts/{artifactId}/versions/{version}/work-copy` | Create the owner's editable Draft from a version |
| POST | `/artifacts/{artifactId}/clone` | Create an owner-bound Draft from an exact readable Version without lineage |

The first publish stores the Artifact, complete content snapshot, dependency
declarations, discovery projection, and consumed Draft in one PostgreSQL
transaction. Subsequent work-copy publication increments the latest SemVer
patch component; the source version must still be current when publishing.
Existing versions whose content was not persisted before migration 005 remain
readable as metadata but return `409 VERSION_CONTENT_UNAVAILABLE` for full
content reads and work-copy creation.

## Implemented Phase 6 behavior

`PATCH /artifacts/{artifactId}` requires bearer authentication and Artifact
ownership. Its strict partial request currently accepts only `visibility` with
the values `private`, `unlisted`, and `public`; empty requests and unknown or
immutable properties are rejected. It returns the updated canonical Artifact
without creating a Draft or Version. Visibility changes are reflected by
discovery and subsequent access checks. Tombstoned Artifacts remain immutable.

`GET /artifacts/{artifactId}/versions/{version}/dependencies` returns the
declarations persisted for the exact path Version, with target Artifact ID and
declared SemVer range. Its required `resolutionState` is `none` when no
resolution was stored, `available` when all persisted history is currently
readable, or `redacted` when history exists but the target Artifact is not
currently readable. `resolutions` is empty for `none` and `redacted`; otherwise
it contains the persisted history (`version` SemVer and `resolvedAt`). An empty
`resolutions` array with `redacted` does not mean that no resolution occurred.
Declarations remain visible to an authorized source reader in all three states.

Resolution history is associated through the dependency row and its source
Version. The GET does not resolve ranges, select a newer Version, recompute
compatibility, or write data; it does not expose target Artifact metadata.
Historical resolution is returned only while the target Artifact is active and
readable by the caller. Tombstoned targets are always redacted, including for
their owner.

`GET /artifacts/{artifactId}/versions/{version}/compatibility` returns reports
associated with the exact source Version. Each report has `availability` of
`available` or `redacted`. Redacted reports retain report identity and source
association, but return a null `targetArtifactVersionId`, status `unavailable`,
and an empty `report` object; this also applies to reports without a target
Version ID. For available reports, `status` and `report` are persisted; for a
redacted report, `unavailable` is synthesized and `availability` distinguishes
that redaction from a persisted status with the same value. This response shape
prevents target-derived report data from remaining visible after access is
revoked.

Both read paths evaluate source and target authorization in a read-only
REPEATABLE READ transaction. The required `resolutionState` and `availability`
fields are supported parts of the response contract. Their addition is an
explicitly approved breaking change under the existing `/api/v1` path; strict
clients validating the previous response schemas must update. The API path
remains `/api/v1` by approval.

## Not implemented

Direct Version creation; Fork, Import, dependency resolution, and compatibility
report creation remain outside this slice. Compatibility-report reads return
stored report data only when its target is currently readable; otherwise they
return the documented redacted representation. They do not recalculate
compatibility or write data.
Published versions have no update or delete operation.

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
