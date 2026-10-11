# GitHub Copilot Prompt — PearlHub Chat 2.11

You are implementing the next persistence task in `Hong-Kong-Heritage-Archive/PearlHub`.

## Mandatory reading

Before editing code, read:

- `docs/backend/PearlHub_Chat_2.3-2.10_Frozen_Reference.md`
- `docs/backend/01-domain-model.md`
- `docs/backend/02-postgresql-schema.md`
- `docs/backend/03-repository-interfaces.md`
- `docs/backend/04-application-services.md`
- `docs/backend/06-error-model.md`
- `docs/backend/07-test-plan.md`
- `docs/backend/CHAT-2.11-POSTGRESQL-PERSISTENCE-MAPPING-AND-SCHEMA-PLAN.md` (or the supplied equivalent plan if it has not yet been added to the repository)

## Frozen architecture — do not change

- Hono HTTP adapter; OpenAPI 3.1 contract.
- One portable OCI/Docker container on Google Cloud Run.
- Firebase Authentication is the prototype Identity Provider, not the permanent user identity model. Keep provider-specific authentication in Infrastructure/Hono middleware and pass `AuthenticatedPrincipal` to Application.
- Layering remains HTTP/Hono → Application → Domain → Repository Ports → Infrastructure.
- No ORM, query builder, parallel migration runner, or wholesale backend regeneration.
- Internal PearlHub `UserId` is authoritative; never trust a client-supplied owner ID.
- Artifact ID/name/slug/owner are immutable; slug uniqueness remains `UNIQUE(owner_id, slug)`.
- Tombstone is `status=tombstone`, `visibility=unlisted`; physical Artifact deletion remains prohibited.
- Published versions are immutable. Fork creates lineage; Clone does not; GitHub import creates provenance, not lineage.
- Preserve the current `pg` repositories, `TransactionManager`/`UnitOfWork`, SQLSTATE/constraint error mapping, and random-schema PostgreSQL integration test strategy.

## Phase A: inspection only — do not code yet

Inspect the actual current repository, not just documentation. Review migrations, user/identity mapping, Domain entities, ports, PostgreSQL adapters, application services, and tests.

Return a concise matrix with these columns:

- Contract / invariant
- Already implemented
- Missing or implemented differently
- Evidence (exact file and symbol/table/constraint)
- Proposed minimal change
- Migration/backfill risk

Focus on two confirmed investigation areas:

1. **External identity mapping:** current persistence uses `users.external_subject`. Determine how to support an explicit provider + subject mapping while retaining stable internal `UserId`. Explain deterministic migration/backfill for existing rows; do not guess a provider for existing production identities.
2. **Tombstone snapshots:** trace `DeleteArtifact` and any `RestoreArtifact` implementation. Determine whether the full pre-delete Artifact state, all immutable version/content references, dependency declarations/resolutions, provenance, compatibility reports, and lineage can be reconstructed. Recommend the smallest persistence design that truly satisfies the frozen snapshot contract.

Do not assume a JSONB snapshot table is automatically correct. Account for immutable external content references and the fact that a PostgreSQL transaction cannot roll back an already completed object/content-store write.

At the end of Phase A, list exact files that would need changes and stop. Do not edit code or SQL until the gap matrix and proposed migration/backfill behavior are internally consistent with the frozen reference.

## Phase B: implementation — only after Phase A is complete

- Add forward-only migration(s); never rewrite already-applied migrations.
- Do not copy an earlier generated full schema over current migrations.
- Do not introduce global slug uniqueness or make `published_at` nullable just to stage a version.
- Keep changes minimal and traceable to the approved gap matrix.
- Update actual schema documentation and existing PostgreSQL integration tests together.
- Add tests for provider+subject uniqueness, same subject across different providers, deterministic migration behavior, snapshot completeness/immutability, repeated deletion, transaction rollback, lineage/history preservation, and Admin restoration of the same Artifact identity.
- Retain existing tests for owner-scoped slugs, immutable identity/versions, dependency target integrity, Fork/Clone/import semantics, and transaction reliability.
- Do not implement Hono routes or Firebase token verification as part of this database task unless an existing checked-in task explicitly requires it.

## Required checks

Run and report exact outcomes:

```sh
npm run build
npm run test:unit
npm run test:integration
```

If integration tests are skipped because `TEST_DATABASE_URL` is unset, report **SKIPPED**, not passed. Do not claim tests were run unless you actually ran them.

## Final response requirements

Report:

1. Files changed and why.
2. New migration name and existing-data/backfill behavior.
3. Tests actually run and their exact results.
4. Any unresolved contract conflict or risk.
5. Confirmation that frozen architecture and existing migration history were preserved.

If any required behavior conflicts with the frozen reference, stop and ask for a decision rather than guessing.
