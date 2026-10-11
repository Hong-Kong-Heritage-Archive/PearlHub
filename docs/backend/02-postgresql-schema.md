# 02 — PostgreSQL Schema

The persistence contract is implemented by `migrations/001_initial.sql`, `migrations/002_persistence_hardening.sql`, and `migrations/003_identity_mapping_and_tombstone_snapshots.sql`. Together they create ten application tables. The schema uses PostgreSQL constraints and triggers for database invariants; SemVer parsing and range evaluation remain domain/application responsibilities.

All primary keys are `UUID`. Timestamp columns are `TIMESTAMPTZ`; the initial migration supplies `now()` defaults where noted below. Foreign keys use PostgreSQL's default `NO ACTION` behavior, so referenced records are retained rather than cascaded away.

## Rollout note

Migration 003 leaves existing `users.external_subject` values unchanged and does not
infer a provider; map legacy accounts only through reviewed, authoritative
provider/subject-to-user mappings. Tombstone snapshots keep content hashes and locations,
not content bytes, so restoration assumes the external content store retains immutable
objects. PostgreSQL transactions cannot roll back that external store.

## Tables

### `users`

| Column | Type | Nullability / default |
| --- | --- | --- |
| `id` | `UUID` | primary key |
| `external_subject` | `TEXT` | nullable, unique; retained legacy value |
| `created_at` | `TIMESTAMPTZ` | not null, default `now()` |
| `updated_at` | `TIMESTAMPTZ` | not null, default `now()` |

### `user_identities`

| Column | Type | Nullability / default |
| --- | --- | --- |
| `id` | `UUID` | primary key |
| `user_id` | `UUID` | not null, FK to `users(id)` |
| `provider` | `TEXT` | not null; non-empty |
| `subject` | `TEXT` | not null; non-empty |
| `created_at` | `TIMESTAMPTZ` | not null, default `now()` |

`UNIQUE(provider, subject)` identifies an external identity without making it PearlHub's
user identity. `users.id` remains authoritative. Migration 003 does not infer a provider
or backfill existing `external_subject` values; production backfill requires explicit,
verified provider/subject mappings. Unmapped legacy values remain preserved in
`users.external_subject`.

#### Legacy identity rollout and backfill

An existing user without a `user_identities` row will not resolve through
`UserIdentityRepository.findUserId(provider, subject)` until a trusted mapping is
supplied. The user's internal ID and Artifact ownership remain unchanged, but sign-in
through the new provider/subject lookup cannot transparently identify that account.

Backfill is a separate, operator-controlled rollout:

1. Export provider and subject values from the authoritative identity provider. Do not
   infer that legacy subjects belong to Firebase.
2. Build and review an explicit mapping from each verified `(provider, subject)` pair
   to the existing internal `users.id`. Match using trusted identity records, not email
   equality or a guessed subject format.
3. Quarantine unmatched or ambiguous users for explicit account-linking resolution.
   Never merge users automatically; a duplicate `(provider, subject)` must be resolved
   before import.
4. Import reviewed rows into `user_identities` in a transaction, then reconcile counts,
   uniqueness, and sampled provider lookups before enabling the new lookup path.
5. Keep `users.external_subject` unchanged during rollout. Deprecate or remove it only
   in a later, separately reviewed migration after all required identities are mapped.

Do not import provider tokens, credentials, or API keys as part of this process.

### `artifacts`

| Column | Type | Nullability / default |
| --- | --- | --- |
| `id` | `UUID` | primary key |
| `owner_id` | `UUID` | not null, FK to `users(id)` |
| `name` | `TEXT` | not null; trimmed length 1–200 |
| `slug` | `TEXT` | not null; lowercase alphanumeric segments separated by single hyphens |
| `visibility` | `TEXT` | not null; `private`, `unlisted`, or `public` |
| `status` | `TEXT` | not null; `active` or `tombstone` |
| `created_at` | `TIMESTAMPTZ` | not null, default `now()` |
| `updated_at` | `TIMESTAMPTZ` | not null, default `now()` |

`UNIQUE(owner_id, slug)` scopes slugs to their owner. `artifacts_tombstone_unlisted` enforces that tombstones are unlisted. The name/slug format checks are database checks; full Artifact policy remains in the domain layer.

### `artifact_versions`

| Column | Type | Nullability / default |
| --- | --- | --- |
| `id` | `UUID` | primary key |
| `artifact_id` | `UUID` | not null, FK to `artifacts(id)` |
| `version` | `TEXT` | not null |
| `content_hash` | `TEXT` | not null |
| `content_location` | `TEXT` | not null |
| `created_at` | `TIMESTAMPTZ` | not null, default `now()` |
| `published_at` | `TIMESTAMPTZ` | not null |

Unique constraints are `UNIQUE(artifact_id, version)` and `UNIQUE(artifact_id, content_hash)`. The additional unique key `(id, artifact_id)` supports dependency-resolution integrity. SemVer validity is not checked in SQL.

### `artifact_lineage`

| Column | Type | Nullability / default |
| --- | --- | --- |
| `id` | `UUID` | primary key |
| `parent_artifact_id` | `UUID` | not null, FK to `artifacts(id)` |
| `child_artifact_id` | `UUID` | not null, FK to `artifacts(id)` |
| `source_version_id` | `UUID` | nullable composite FK to `(artifact_versions.id, artifact_id)` using the parent Artifact ID |
| `relationship_type` | `TEXT` | not null; must be `fork` |
| `created_at` | `TIMESTAMPTZ` | not null, default `now()` |

The parent and child must differ, and `(parent_artifact_id, child_artifact_id, relationship_type)` is unique. Fork records are permanent. Clone creates no lineage; GitHub import is provenance, not lineage. There are no Merge or Branch relationships.

New Forks record their selected source version. Existing rows remain NULL because the
previous schema did not store this value and migration 003 does not guess it.

### `provenances`

| Column | Type | Nullability / default |
| --- | --- | --- |
| `id` | `UUID` | primary key |
| `artifact_version_id` | `UUID` | not null, FK to `artifact_versions(id)` |
| `source_type` | `TEXT` | not null |
| `source_url` | `TEXT` | not null |
| `source_ref` | `TEXT` | not null |
| `imported_at` | `TIMESTAMPTZ` | not null, default `now()` |

GitHub import is represented as source/provenance metadata and does not create Fork lineage.

### `dependencies`

| Column | Type | Nullability / default |
| --- | --- | --- |
| `id` | `UUID` | primary key |
| `artifact_version_id` | `UUID` | not null, FK to `artifact_versions(id)` |
| `target_artifact_id` | `UUID` | not null, FK to `artifacts(id)` |
| `declared_range` | `TEXT` | not null; declared SemVer range, not parsed by PostgreSQL |
| `created_at` | `TIMESTAMPTZ` | not null, default `now()` |

### `dependency_resolutions`

| Column | Type | Nullability / default |
| --- | --- | --- |
| `id` | `UUID` | primary key |
| `dependency_id` | `UUID` | not null, FK to `dependencies(id)` |
| `resolved_artifact_version_id` | `UUID` | not null, FK to `artifact_versions(id)` |
| `resolved_at` | `TIMESTAMPTZ` | not null, default `now()` |
| `target_artifact_id` | `UUID` | not null; internal integrity helper, set by trigger |

`target_artifact_id` is a PostgreSQL persistence detail, not part of the public dependency-resolution model. Composite foreign keys link `(dependency_id, target_artifact_id)` to the dependency and `(resolved_artifact_version_id, target_artifact_id)` to the version, so the resolved version must belong to the declared target Artifact.

### `compatibility_reports`

| Column | Type | Nullability / default |
| --- | --- | --- |
| `id` | `UUID` | primary key |
| `artifact_version_id` | `UUID` | not null, FK to `artifact_versions(id)` |
| `target_artifact_version_id` | `UUID` | nullable, FK to `artifact_versions(id)` |
| `status` | `TEXT` | not null |
| `report` | `JSONB` | not null |
| `created_at` | `TIMESTAMPTZ` | not null, default `now()` |

Compatibility is a separate record attached to an Artifact Version, with an optional target Artifact Version.

### `tombstone_snapshots`

| Column | Type | Nullability / default |
| --- | --- | --- |
| `id` | `UUID` | primary key |
| `artifact_id` | `UUID` | not null, FK to `artifacts(id)` |
| `snapshot_number` | `INTEGER` | not null, > 0 |
| `snapshot` | `JSONB` | not null; format version 1 |
| `created_at` | `TIMESTAMPTZ` | not null |

`UNIQUE(artifact_id, snapshot_number)` sequences successful active-to-tombstone
transitions. The JSONB snapshot captures pre-transition Artifact state, versions,
content hashes/locations, dependencies and resolutions, provenance, compatibility
reports, and lineage. Update, delete, and truncate are rejected by triggers. Repeated
deletion while tombstoned does not append or replace a snapshot; after restoration,
a later deletion appends a new snapshot.

Content bytes are not copied into PostgreSQL. Snapshot completeness for content depends
on the external content store preserving the immutable objects at the referenced
locations; PostgreSQL transactions cannot roll back or guarantee external-store writes.

## Constraints and triggers

Every table has a UUID primary key. Foreign keys are the relationships listed above; there are no cascading deletes. Unique constraints include `users.external_subject`, `user_identities(provider, subject)`, `artifacts(owner_id, slug)`, `artifact_versions(artifact_id, version)`, `artifact_versions(artifact_id, content_hash)`, `artifact_versions(id, artifact_id)`, `dependencies(id, target_artifact_id)`, the lineage triple, and `tombstone_snapshots(artifact_id, snapshot_number)`. The composite unique keys support resolution and lineage foreign keys.

Checks enforce Artifact name length, slug format, visibility values, status values, tombstone-implies-unlisted, Fork-only lineage, and non-self lineage. PostgreSQL does not parse SemVer versions or ranges.

| Trigger | Effect |
| --- | --- |
| `artifacts_identity_immutable` | Rejects changes to `owner_id`, `name`, or `slug`; lifecycle fields including `visibility`, `status`, and `updated_at` remain updateable. |
| `artifacts_no_physical_delete` | Rejects physical Artifact deletion. Deletion is a tombstone update; versions, provenance, dependencies, and lineage remain. |
| `artifact_versions_immutable` | Rejects every update or delete of a published Artifact Version. |
| `dependency_resolutions_set_target` | Copies the target Artifact ID from the selected dependency before insert or dependency reassignment; composite foreign keys enforce consistency. |
| `tombstone_snapshots_no_update_or_delete` | Rejects updates and deletes of tombstone snapshots. |
| `tombstone_snapshots_no_truncate` | Rejects truncating the snapshot table. |

`tombstone_artifact()` captures the snapshot and changes Artifact status/visibility in
one PostgreSQL statement. `restore_artifact()` restores the same Artifact identity and
visibility recorded in the latest snapshot without deleting snapshot or history.

The migrations are forward-only. `001_initial.sql` establishes the original tables and
indexes; `002_persistence_hardening.sql` adds the tombstone check, Artifact identity
trigger, and composite keys/foreign keys for dependency-resolution target integrity;
`003_identity_mapping_and_tombstone_snapshots.sql` adds provider identity mappings,
source-version lineage references, and immutable lifecycle snapshots.

## Indexes

The primary-key and unique constraints create their own indexes. The initial migration also creates these named lookup indexes, corresponding to repository lookups or lineage traversal:

| Index | Query/use case |
| --- | --- |
| `artifacts_owner_idx` | Artifacts by owner; the owner prefix of `UNIQUE(owner_id, slug)` also supports this lookup. |
| `artifacts_visibility_status_idx` | Artifact filtering by visibility and lifecycle status. |
| `artifact_versions_artifact_idx` | Versions by Artifact; unique `(artifact_id, version)` also has this leading key. |
| `artifact_lineage_parent_idx` | Children of a parent Artifact. |
| `artifact_lineage_child_idx` | Parents of a child Artifact. |
| `provenances_version_idx` | Provenance records by Artifact Version. |
| `dependencies_source_idx` | Dependencies declared by an Artifact Version. |
| `dependencies_target_idx` | Dependencies that target an Artifact. |
| `dependency_resolutions_dependency_idx` | Resolutions for a dependency. |
| `compatibility_reports_source_idx` | Compatibility reports for a source Artifact Version. |
| `compatibility_reports_target_idx` | Reports targeting an Artifact Version. |
| `user_identities_user_idx` | External identities associated with an internal User. |
| `tombstone_snapshots_artifact_idx` | Snapshot history for an Artifact. |

No additional index is introduced by the schema freeze. The owner and version lookup indexes overlap the leading columns of unique indexes but are retained as present in the initial migration; any future index change should be based on measured query plans and handled by a new migration.
