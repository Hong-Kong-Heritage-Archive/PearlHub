# PearlHub API Contract

**Status:** FROZEN through Section 2.3.6  
**API version:** v1  
**Base path:** `/api/v1`

This document records the human-readable API contract decisions for PearlHub
v0.1. The repository-root `openapi.yaml` is the canonical machine-readable
contract, and `/openapi.json` is the runtime-generated representation.

**Naming reconciliation:** Pearl is the product concept. Artifact is the
API/domain resource name, and canonical API resource paths use
`/api/v1/artifacts`. Ownership is derived from the authenticated principal;
clients cannot provide `ownerId` in a write body.

If implementation conflicts with a rule marked **FROZEN**, the implementation must be changed or the contract must be explicitly revised.

---

## 2.3.1 — API Contract Principles

**STATUS: FROZEN**

1. API is the public domain contract.
2. Resource-first, not database-first.
3. Immutable identity must be enforced by API.
4. Resource lifecycle must be observable.
5. Fork / Clone / Import have distinct semantics.
6. Artifact Versions are immutable.
7. Dependencies preserve declared range + resolved version.
8. Compatibility Reports target Artifact Versions.
9. Errors have stable machine-readable codes.
10. HTTP status and domain error code have separate responsibilities.
11. Write requests use strict schema validation.
12. Contract tests are executable enforcement of the API contract.

---

## 2.3.2 — Resource & Lifecycle Contract

**STATUS: FROZEN**

### Pearl identity

The following fields are immutable after Pearl creation:

- `name`
- `slug`
- `owner`

They cannot be changed through the API.

### Deletion

Deleting an active Pearl does not physically remove its historical identity.

Delete creates a **tombstone Pearl / Artifact**:

- `status = tombstone`
- `visibility = unlisted`
- complete immutable snapshot is retained
- lineage is retained
- normal user operations cannot restore a tombstone; an Admin may restore it through a privileged operation

A previously existing tombstoned resource returns to normal, non-admin requests:

- `410 Gone`

A resource that has never existed returns:

- `404 Not Found`

### Artifact Versions

Artifact Versions are immutable.

v0.1 does not provide:

- PATCH Version
- DELETE Version
- merge
- branch

### Dependencies

Dependency declarations use **SemVer ranges**.

Dependency resolution records both:

- declared range
- resolved version

Playground / Export may resolve the latest version satisfying the declared range.

### Compatibility

Compatibility Reports are separate resources and point to a specific Artifact Version.

### Fork / Clone / Import

These operations have deliberately different semantics:

| Operation | New Pearl | PearlHub lineage | Provenance |
|---|---:|---:|---:|
| Fork | Yes | Yes, permanent | Optional |
| Clone | Yes | No | Optional |
| GitHub Import | Yes | No | Yes, source metadata |

GitHub Import is provenance/source metadata. It is **not** a Fork.

### Pearl Skills

A Skill inside a Pearl follows the **Artifact Skill / Embedded Skill hybrid** model.

### Portability

Portability is a core PearlHub principle.

PearlHub is an open-source, forever-free, consumer/community-first platform.

### Playground API-key rule

For Playground testing:

- the user supplies their own Gemini API key
- PearlHub does not store the user's Gemini API key

---

## 2.3.3 — Core API Contract

**STATUS: FROZEN**

Base path:

`/api/v1`

### Artifact endpoints

Paths below are relative to `/api/v1`. Drafts are private to their owner.
First publication creates the Artifact identity and complete `0.1.0`
version atomically; direct Artifact creation is retired.

| Method | Endpoint | Purpose | Status |
|---|---|---|---|
| POST | `/drafts` | Create a private unpublished Draft | Implemented |
| GET | `/drafts` | List the caller's active Draft summaries | Implemented |
| GET | `/drafts/{draftId}` | Read an owner-authorized Draft | Implemented |
| PUT | `/drafts/{draftId}` | Update with revision-based concurrency | Implemented |
| DELETE | `/drafts/{draftId}?revision={revision}` | Discard an unpublished Draft | Implemented |
| POST | `/drafts/{draftId}/publish` | Atomically publish a Draft | Implemented |
| POST | `/artifacts/{artifactId}/versions/{version}/work-copy` | Create owner work-copy from selected version | Implemented |
| POST | `/artifacts` | Legacy direct creation; returns `410 ARTIFACT_CREATION_REQUIRES_DRAFT` | Retired |
| GET | `/artifacts` | List/search Artifacts | Implemented |
| GET | `/artifacts/{artifactId}` | Get Artifact | Planned |
| PATCH | `/artifacts/{artifactId}` | Update mutable metadata only | Planned |
| DELETE | `/artifacts/{artifactId}` | Create tombstone | Planned |

Until the Artifact PATCH endpoint is implemented, an owner can change an
existing Artifact's visibility through the published-version workflow: create
a work-copy, update its Draft with the desired `visibility` and current
`revision`, then publish the updated revision. For example, setting
`visibility` to `public` and publishing makes a private or unlisted Artifact
public atomically with its next immutable Version. This requires owner
authorization; updating a Draft alone does not change the Artifact.

### Version endpoints

| Method | Endpoint | Purpose | Status |
|---|---|---|---|
| GET | `/artifacts/{artifactId}/versions` | List published versions | Implemented |
| GET | `/artifacts/{artifactId}/versions/{version}` | Get complete immutable Artifact Version | Implemented |
| POST | `/artifacts/{artifactId}/versions` | Create new immutable version | Planned |

There is no Version PATCH or DELETE endpoint in v0.1.

### Lineage / lifecycle endpoints

| Method | Endpoint | Purpose | Status |
|---|---|---|---|
| POST | `/artifacts/{artifactId}/fork` | Fork with permanent PearlHub lineage | Planned |
| POST | `/artifacts/{artifactId}/clone` | Clone without PearlHub lineage | Planned |
| GET | `/artifacts/{artifactId}/lineage` | Get lineage | Planned |

### Import

| Method | Endpoint | Purpose | Status |
|---|---|---|---|
| POST | `/imports/github` | Import from GitHub with provenance metadata | Planned |

### Dependencies / compatibility

| Method | Endpoint | Purpose | Status |
|---|---|---|---|
| GET | `/artifacts/{artifactId}/versions/{version}/dependencies` | Get dependencies | Planned |
| GET | `/artifacts/{artifactId}/versions/{version}/compatibility` | Get compatibility reports | Planned |

### Search

v0.1 search supports:

- keyword search
- tag search

Semantic search is Phase 2.

### API identity

API versioning is separate from Artifact SemVer.

- API version: `/api/v1`
- Artifact version: SemVer, e.g. `1.2.3`

### Content hash

`contentHash` is generated by the server.

Clients do not define the canonical content hash.

For Draft publication, canonical content is UTF-8 JSON with recursively
sorted object keys, normalized/sorted knowledge-file paths, and dependency
declarations sorted by target Artifact ID and declared range. The SHA-256
digest is returned as `sha256:<lowercase hex>` and covers instructions,
file paths and contents, and dependency declarations. Each knowledge file
also receives a server-generated content hash.

Draft revisions start at `1`; each successful update increments the revision.
Update and Publish requests must provide the revision they read. First
publication is exactly `0.1.0`; each work-copy publication increments the
latest SemVer patch component. Draft content and published snapshots are
stored in PostgreSQL. Migration `005_drafts_and_version_snapshots.sql` adds
the Draft table and immutable version content snapshot. Existing versions
predating this migration cannot be backfilled from the old in-memory store;
their metadata remains available, but full content read/work-copy returns a
documented `409 VERSION_CONTENT_UNAVAILABLE`.

---

## 2.3.4 — OpenAPI Contract

**STATUS: FROZEN**

PearlHub uses **OpenAPI 3.1**.

The canonical machine-readable API description is:

`openapi.yaml`

The runtime-generated representation remains available at `/openapi.json`.
The canonical OpenAPI document defines Draft lifecycle, publication,
published-version reads, the retired direct-create path, and discovery.

The OpenAPI definition uses:

- canonical resource path `/api/v1/artifacts`
- resource-first design
- domain/resource tags
- strict request schemas
- immutable fields marked `readOnly`
- cursor-based pagination for list operations

### Resource tags

- Pearls
- Versions
- Forks
- Imports
- Dependencies
- Compatibility
- Lineage

### Immutable Artifact fields

The Artifact response schema marks these JSON fields as `readOnly`:

- `id`
- `name`
- `slug`
- `ownerId`

### Visibility

Allowed values:

- `private`
- `unlisted`
- `public`

### Pearl status

Allowed values:

- `active`
- `tombstone`

### Pagination

List endpoints use cursor-based pagination.

- `limit`: integer, minimum `1`, maximum `100`
- `nextCursor`: nullable

### Version representation

A Version includes:

- `id`
- `version`
- `contentHash`
- `artifact`
- `dependencies`
- `createdAt`

### Create Version

Create Version accepts:

- `version`
- `artifact`
- `dependencies`

### Dependency representation

A dependency declaration contains a Pearl reference and SemVer range.

A resolved dependency contains:

- Pearl reference
- declared range
- resolved version

### Fork

Fork may specify:

- source version
- new name
- new slug

Fork response includes lineage reference.

### Clone

Clone creates a new Pearl with no PearlHub lineage.

### GitHub Import

GitHub import accepts:

- source URL
- visibility

Source provenance records:

- `type = github`
- URL
- repository
- ref

### Compatibility Report

A Compatibility Report identifies:

- source Artifact Version
- target Pearl
- target version
- compatibility result
- checked time

### Standard HTTP responses

The API contract defines standard error responses for:

- `400 Bad Request`
- `401 Unauthorized`
- `403 Forbidden`
- `404 Not Found`
- `409 Conflict`
- `410 Gone`
- `422 Unprocessable Entity`
- `500 Internal Server Error`

---

## 2.3.5 — Error Contract

**STATUS: FROZEN**

### Canonical error envelope

All API errors use the following shape:

```json
{
  "error": {
    "code": "PEARL_SLUG_IMMUTABLE",
    "message": "Pearl slug cannot be changed.",
    "details": {}
  }
}
```

### Error field semantics

#### `error.code`

- machine-readable
- stable
- contract-level
- `UPPER_SNAKE_CASE`
- once public, the code must remain stable

#### `error.message`

- human-readable
- not a machine contract
- may change without requiring clients to change

#### `error.details`

Optional structured context.

Validation errors may include field-level information:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "details": {
      "fields": {
        "version": [
          "Must be a valid SemVer version."
        ]
      }
    }
  }
}
```

### HTTP status responsibilities

HTTP status represents transport-level semantics.

`error.code` represents PearlHub domain semantics.

They are intentionally separate.

### Status semantics

| HTTP | Meaning |
|---|---|
| 400 | Malformed/invalid request |
| 401 | Missing or invalid authentication |
| 403 | Authenticated but not authorized |
| 404 | Resource does not exist |
| 409 | Request conflicts with immutable/resource state |
| 410 | Resource previously existed but is now tombstoned |
| 422 | Request is structurally valid but fails domain validation |
| 500 | Unexpected internal server error |

### Canonical examples

- `409 + PEARL_SLUG_IMMUTABLE`
- `409 + PEARL_SLUG_ALREADY_EXISTS`
- `404 + PEARL_NOT_FOUND`
- `410 + PEARL_TOMBSTONED`
- `422 + VALIDATION_ERROR`
- `500 + INTERNAL_ERROR`

### Security

Internal implementation details and sensitive diagnostics must never be exposed through API errors.

A request identifier should preferably be carried through the:

`X-Request-ID`

HTTP header rather than placed in `error.details`.

---

## 2.3.6 — Authentication + Authorization + Visibility Contract

**STATUS: FROZEN**

The canonical create operation uses the `BearerAuth` HTTP bearer scheme. Its
identity provider remains provider-neutral.

### 1. Authentication

Protected write operations require Bearer authentication.

Implemented protected operations include Draft creation, read, update,
discard, and publish; creating a work-copy; and owner-scoped access to private
Artifacts and Drafts. Direct `POST /artifacts` is retired and returns
`410 ARTIFACT_CREATION_REQUIRES_DRAFT`. Metadata mutation, deletion, Fork,
Clone, and GitHub Import remain planned.

OpenAPI security scheme:

```yaml
securitySchemes:
  BearerAuth:
    type: http
    scheme: bearer
```

### 2. Authenticated identity

Authenticated identity is derived from the access token.

The client must not be trusted to provide ownership in the request body.

On Artifact creation:

- `ownerId` is assigned from the authenticated principal
- `ownerId` is immutable

### 3. Authentication vs Authorization

These have separate meanings:

- `401 Unauthorized` = authentication is missing or invalid
- `403 Forbidden` = authentication succeeded, but authorization is insufficient

### 4. Visibility vs Authorization

Visibility and authorization are separate concepts.

Visibility values are:

- `public`
- `unlisted`
- `private`

The visibility of a Pearl does not by itself define every operation the caller can perform.

### 5. Visibility semantics

| State | Anonymous | Authenticated non-owner | Owner | Admin |
|---|---:|---:|---:|---:|
| `public` | Yes | Yes | Yes | Yes |
| `unlisted` | No | Yes, with secret URL | Yes | Yes |
| `private` | No | No | Yes | Yes |
| `tombstone` | No | No | No | Admin inspection only |

#### Public

Public Pearls may be discovered and read by anyone.

#### Unlisted

Unlisted Pearls:

- require authentication and the secret URL for direct access
- are not included in normal discovery/list/search results
- are not equivalent to private Pearls
- cannot be read anonymously, even when the slug is known

#### Private

Private Pearls are accessible only by their owner.

### 6. `GET /api/v1/artifacts` visibility filtering

Discovery is an anonymously accessible API surface, but it is not a public
dataset.

Anonymous caller:

- receives active `public` Pearls

Authenticated caller:

- receives active `public` Pearls
- may also receive their own active `private` Pearls
- receives their own `unlisted` Pearls only when explicitly filtering for
  `visibility=unlisted`

A caller must never receive another user's private Pearl.

Unlisted Pearls are excluded from normal discovery. A visibility filter only
narrows the set already authorized for that caller: `visibility=private` and
`visibility=unlisted` return only the authenticated owner's matching Pearls.
Anonymous callers receive no private or unlisted Pearls, regardless of the
filter. Tombstones are always excluded.

### 7. Query parameters cannot bypass authorization

A query such as:

`GET /artifacts?visibility=private`

does not grant access to other users' private Pearls.

The server must apply authorization and visibility filtering based on the authenticated principal.

### 7.1 Discovery query, pagination, and response

`GET /api/v1/artifacts` supports:

| Parameter | Semantics |
|---|---|
| `q` | Optional, trimmed, 1–100 characters; case-insensitive literal substring search over Artifact name or slug. `%`, `_`, and backslash are treated literally. |
| `tag` | Repeatable, at most 10 tags; values are trimmed and lowercased, duplicates after normalization are rejected, and all supplied tags must match. |
| `limit` | Integer 1–100; defaults to 20. |
| `cursor` | Opaque, filter-bound cursor for the next page. |
| `sort` | `createdAt` (default), `updatedAt`, or case-insensitive `name`. |
| `order` | `desc` (default) or `asc`. |
| `visibility` | Optional `public`, `private`, or `unlisted` narrowing filter. |

Results use `{ "items": [...], "nextCursor": "..." }`. `nextCursor` is `null`
when there is no next page. The API does not return totals. Pages use keyset
pagination with `id` as a same-direction tie-breaker for every sort.

Search tags are optional top-level fields in Draft content and are retained in
the immutable published Version content; they are not accepted in the retired
strict Artifact-create request. Tags are trimmed, lowercased, limited to 10 per
Pearl and 50 characters each, and must match lowercase kebab syntax
(`[a-z0-9]+(-[a-z0-9]+)*`). Empty, malformed, and duplicate tags are rejected.
Matching is exact and case-insensitive after normalization. Publishing projects
the selected Version's normalized tags into Artifact discovery; creating a
work-copy carries those tags forward.

Discovery is not enabled until a provider-neutral application reindex has
projected tags from each Artifact's latest SemVer version through the configured
content-store port. If content is unavailable or invalid, the index remains
not ready and discovery fails closed.

### 8. Direct lookup vs discovery

These are separate concepts:

- `GET /artifacts/{artifactId}` = direct resource lookup
- `GET /artifacts` = discovery/listing

An unlisted Pearl may be retrieved by an authenticated caller who has its secret URL,
while remaining absent from ordinary discovery.

### 9. Tombstones

A tombstoned Pearl:

- remains immutable
- retains its snapshot
- retains lineage
- has `status = tombstone`
- has `visibility = unlisted`
- is unreadable to normal users; non-admin reads return `410 Gone`
- may only be restored by a privileged Admin operation; no restore endpoint is
  implemented
- cannot be restored by normal user operations

### 10. Fork / Clone ownership

Fork (planned):

- requires authentication
- creates a new Pearl
- authenticated user becomes owner
- establishes permanent PearlHub lineage

Clone (planned):

- requires authentication
- creates a new Pearl
- authenticated user becomes owner
- establishes no PearlHub lineage

Anonymous users cannot Fork or Clone.

### 11. Identity provider

The specific OIDC / JWT identity provider is an implementation detail.

The public API contract only requires:

`Bearer access token -> authenticated principal`

The provider is not frozen as part of the public API contract.

---

## Contract Change Rule

Any change to a section marked **FROZEN** is a contract change. Until `openapi.yaml`
is checked in, a prose-only update does not constitute an implemented OpenAPI contract.

A contract change must:

1. update this document;
2. update `openapi.yaml` where applicable;
3. update affected contract tests;
4. document the change in the relevant development record.

Implementation must not silently diverge from this document.

---

## Contract-Test Principle

Contract tests are executable enforcement of this document.

At minimum, tests must verify:

- immutable identity
- lifecycle / tombstone behavior
- visibility filtering
- authentication
- authorization
- Fork / Clone / Import semantics
- immutable Versions
- dependency range + resolved version
- Compatibility Report targeting
- stable error envelope
- stable error codes
- strict request validation
- HTTP status semantics

---

## Freeze Record

| Section | Status |
|---|---|
| 2.3.1 API Contract Principles | FROZEN |
| 2.3.2 Resource & Lifecycle Contract | FROZEN |
| 2.3.3 Core API Contract | FROZEN |
| 2.3.4 OpenAPI Contract | FROZEN |
| 2.3.5 Error Contract | FROZEN |
| 2.3.6 Authentication + Authorization + Visibility Contract | FROZEN |

**PearlHub API Contract v0.1 — Frozen through 2.3.6**
