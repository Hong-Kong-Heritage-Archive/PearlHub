BEGIN;

CREATE TABLE users (
  id UUID PRIMARY KEY,
  external_subject TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE artifacts (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  visibility TEXT NOT NULL CHECK (visibility IN ('private','unlisted','public')),
  status TEXT NOT NULL CHECK (status IN ('active','tombstone')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, slug)
);
CREATE INDEX artifacts_owner_idx ON artifacts(owner_id);
CREATE INDEX artifacts_visibility_status_idx ON artifacts(visibility, status);

CREATE TABLE artifact_versions (
  id UUID PRIMARY KEY,
  artifact_id UUID NOT NULL REFERENCES artifacts(id),
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_location TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NOT NULL,
  UNIQUE (artifact_id, version),
  UNIQUE (artifact_id, content_hash)
);
CREATE INDEX artifact_versions_artifact_idx ON artifact_versions(artifact_id);

CREATE FUNCTION reject_artifact_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'published Artifact Versions are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER artifact_versions_immutable
  BEFORE UPDATE OR DELETE ON artifact_versions
  FOR EACH ROW EXECUTE FUNCTION reject_artifact_version_mutation();

CREATE FUNCTION reject_artifact_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Artifacts must be tombstoned, not physically deleted' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER artifacts_no_physical_delete
  BEFORE DELETE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION reject_artifact_deletion();

CREATE TABLE artifact_lineage (
  id UUID PRIMARY KEY,
  parent_artifact_id UUID NOT NULL REFERENCES artifacts(id),
  child_artifact_id UUID NOT NULL REFERENCES artifacts(id),
  relationship_type TEXT NOT NULL CHECK (relationship_type = 'fork'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (parent_artifact_id <> child_artifact_id),
  UNIQUE (parent_artifact_id, child_artifact_id, relationship_type)
);
CREATE INDEX artifact_lineage_parent_idx ON artifact_lineage(parent_artifact_id);
CREATE INDEX artifact_lineage_child_idx ON artifact_lineage(child_artifact_id);

CREATE TABLE provenances (
  id UUID PRIMARY KEY,
  artifact_version_id UUID NOT NULL REFERENCES artifact_versions(id),
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX provenances_version_idx ON provenances(artifact_version_id);

CREATE TABLE dependencies (
  id UUID PRIMARY KEY,
  artifact_version_id UUID NOT NULL REFERENCES artifact_versions(id),
  target_artifact_id UUID NOT NULL REFERENCES artifacts(id),
  declared_range TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dependencies_source_idx ON dependencies(artifact_version_id);
CREATE INDEX dependencies_target_idx ON dependencies(target_artifact_id);

CREATE TABLE dependency_resolutions (
  id UUID PRIMARY KEY,
  dependency_id UUID NOT NULL REFERENCES dependencies(id),
  resolved_artifact_version_id UUID NOT NULL REFERENCES artifact_versions(id),
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dependency_resolutions_dependency_idx ON dependency_resolutions(dependency_id);

CREATE TABLE compatibility_reports (
  id UUID PRIMARY KEY,
  artifact_version_id UUID NOT NULL REFERENCES artifact_versions(id),
  target_artifact_version_id UUID REFERENCES artifact_versions(id),
  status TEXT NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX compatibility_reports_source_idx ON compatibility_reports(artifact_version_id);
CREATE INDEX compatibility_reports_target_idx ON compatibility_reports(target_artifact_version_id);

COMMIT;