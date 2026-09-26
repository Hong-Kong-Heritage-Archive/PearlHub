# 02 — PostgreSQL Schema

Use PostgreSQL for persistence.

Do not encode full SemVer parsing in PostgreSQL. SemVer validation belongs to the domain layer.

## Tables

### users

- `id UUID PK`
- `external_subject TEXT UNIQUE NOT NULL`
- `created_at TIMESTAMPTZ`
- `updated_at TIMESTAMPTZ`

### artifacts

- `id UUID PK`
- `owner_id UUID FK users`
- `name TEXT NOT NULL`
- `slug TEXT NOT NULL`
- `visibility TEXT NOT NULL`
- `status TEXT NOT NULL`
- `created_at TIMESTAMPTZ`
- `updated_at TIMESTAMPTZ`
- `UNIQUE(owner_id, slug)`

### artifact_versions

- `id UUID PK`
- `artifact_id UUID FK artifacts`
- `version TEXT NOT NULL`
- `content_hash TEXT NOT NULL`
- `content_location TEXT NOT NULL`
- `created_at TIMESTAMPTZ`
- `published_at TIMESTAMPTZ`
- `UNIQUE(artifact_id, version)`
- `UNIQUE(artifact_id, content_hash)`

### artifact_lineage

- `id UUID PK`
- `parent_artifact_id UUID FK artifacts`
- `child_artifact_id UUID FK artifacts`
- `relationship_type TEXT`
- `created_at TIMESTAMPTZ`
- unique parent/child/type
- parent and child must differ

### provenances

- `id UUID PK`
- `artifact_version_id UUID FK artifact_versions`
- `source_type TEXT`
- `source_url TEXT`
- `source_ref TEXT`
- `imported_at TIMESTAMPTZ`

### dependencies

- `id UUID PK`
- `artifact_version_id UUID FK artifact_versions`
- `target_artifact_id UUID FK artifacts`
- `declared_range TEXT`
- `created_at TIMESTAMPTZ`

### dependency_resolutions

- `id UUID PK`
- `dependency_id UUID FK dependencies`
- `resolved_artifact_version_id UUID FK artifact_versions`
- `resolved_at TIMESTAMPTZ`

### compatibility_reports

- `id UUID PK`
- `artifact_version_id UUID FK artifact_versions`
- `target_artifact_version_id UUID NULL FK artifact_versions`
- `status TEXT`
- `report JSONB`
- `created_at TIMESTAMPTZ`

## Migration requirements

Generate a forward-only initial migration.

Add useful indexes for:

- artifact owner
- artifact visibility/status
- versions by artifact
- lineage parent/child
- provenance by version
- dependencies by source/target
- compatibility by source/target

Do not add provider-specific tables yet.
