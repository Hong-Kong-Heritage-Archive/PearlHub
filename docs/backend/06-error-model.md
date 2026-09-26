# 06 — Error Model

Use stable machine-readable error codes.

## Resource errors

- `ARTIFACT_NOT_FOUND`
- `VERSION_NOT_FOUND`
- `DEPENDENCY_NOT_FOUND`

## Immutable-field errors

- `ARTIFACT_NAME_IMMUTABLE`
- `ARTIFACT_SLUG_IMMUTABLE`
- `ARTIFACT_OWNER_IMMUTABLE`
- `VERSION_IMMUTABLE`

## Validation

- `INVALID_SEMVER`
- `INVALID_SEMVER_RANGE`
- `INVALID_REQUEST`
- `IMPORT_INVALID_FORMAT`

## Domain/conflict

- `VERSION_ALREADY_EXISTS`
- `LINEAGE_INVALID`
- `DEPENDENCY_RESOLUTION_FAILED`

## Authorization

- `UNAUTHENTICATED`
- `FORBIDDEN`

## HTTP mapping

- 400 — invalid request
- 401 — unauthenticated
- 403 — forbidden
- 404 — not found
- 409 — immutable/conflict conditions
- 422 — semantic validation errors
- 429 — rate limited
- 500 — unexpected internal error

Do not expose database errors directly through the API.
