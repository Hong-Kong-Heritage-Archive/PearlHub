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

## Accepted read-path authorization baseline

The following follow-up work is accepted:

| Item | Status |
|---|---|
| P2E-B.1.1 — Artifact Locking / Resolver Lock-order Hardening | Accepted |
| P2EB-AUD-02 — Read-path Authorization Hardening | Accepted |
| P2EB-AUD-02.1 — API Contract & Test Hardening | Accepted |
| `/api/v1` response-shape breaking change | Explicitly approved |

The [P2EB-AUD-02.1 read-only implementation audit](../audit/p2eb-aud-02-1-read-only-implementation-audit.md)
is the single source of truth for audit evidence and findings. Its final verdict
is PASS, with no outstanding findings from this acceptance.

Accepted baseline:

- Keep dependency declarations, `targetArtifactId`, and `declaredRange`
  visible to callers authorized to read the source Artifact. Evaluate historical
  resolution details using the caller's current access and the target's current
  visibility and lifecycle; do not preserve access merely because resolution
  was previously allowed.
- Redact historical resolution details for inaccessible targets, including
  tombstones for all callers. Preserve the `none`, `available`, and `redacted`
  dependency states. Apply the same current-target policy to compatibility
  reports and redact inaccessible target Version IDs and report payloads.
- Preserve source Artifact authorization. Do not add a blanket service-level
  access exemption or another authorization bypass.
- Perform read-path authorization and history reads in read-only PostgreSQL
  `REPEATABLE READ` transactions using the same transaction connection. These
  reads do not acquire resolver write locks. Preserve the resolver's
  `FOR NO KEY UPDATE` Artifact locking and existing source-Version locking.
- The required `resolutionState` and compatibility `availability` fields are
  part of the accepted API contract. The `/api/v1` response-shape breaking
  change is explicitly approved; strict clients of the previous schema must
  update. Keep the existing API path and do not claim backward compatibility
  for strict clients that reject the new fields.
