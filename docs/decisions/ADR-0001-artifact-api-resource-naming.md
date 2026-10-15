# ADR-0001: Artifact API Resource Naming

- Status: Accepted
- Date: 2026-10-16

## Context

The product contract uses Pearl terminology, while the domain and implemented
API use Artifact. Phase A aligns the published API path and documentation with
the runtime without adding unimplemented operations or relaxing security rules.

## Decision

- Use `/api/v1/artifacts` as the canonical API resource path. Pearl remains the
  product term; Artifact is the API/domain resource name.
- Keep repository-root `openapi.yaml` as the canonical OpenAPI 3.1 document and
  `/openapi.json` as the runtime-generated representation.
- Derive ownership from the authenticated principal. `ownerId` is response-only
  and is never client-authoritative in a write body.
- Phase A does not add list, search, detail, or other runtime operations.
- Keep `phase-a/contract-reconciliation` based on `main`, unmerged, and subject
  to review through a pull request.

## Consequences

Human-readable route plans use Artifact paths and label unimplemented
operations as planned. Contract tests compare the canonical create operation
with the runtime-generated OpenAPI document.
