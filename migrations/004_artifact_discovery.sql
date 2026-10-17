BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE TABLE artifact_discovery_index (
  artifact_id UUID NOT NULL,
  artifact_version_id UUID NOT NULL,
  tags TEXT[] NOT NULL,
  CONSTRAINT artifact_discovery_index_pkey PRIMARY KEY (artifact_id),
  CONSTRAINT artifact_discovery_index_artifact_id_fkey FOREIGN KEY (artifact_id)
    REFERENCES artifacts(id),
  CONSTRAINT artifact_discovery_index_artifact_version_id_artifact_id_fkey
    FOREIGN KEY (artifact_version_id, artifact_id)
    REFERENCES artifact_versions(id, artifact_id),
  CONSTRAINT artifact_discovery_index_tags_count_check CHECK (cardinality(tags) <= 10),
  CONSTRAINT artifact_discovery_index_tags_no_null_check CHECK (array_position(tags, NULL) IS NULL)
);
CREATE INDEX artifact_discovery_tags_gin_idx
  ON artifact_discovery_index USING GIN (tags);

CREATE TABLE artifact_discovery_index_state (
  singleton BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT artifact_discovery_index_state_pkey PRIMARY KEY (singleton),
  CONSTRAINT artifact_discovery_index_state_singleton_check CHECK (singleton),
  ready BOOLEAN NOT NULL DEFAULT FALSE
);
INSERT INTO artifact_discovery_index_state (singleton, ready) VALUES (TRUE, FALSE);

CREATE INDEX artifacts_discovery_name_trgm_idx
  ON artifacts USING GIN (lower(name) public.gin_trgm_ops)
  WHERE status = 'active';
CREATE INDEX artifacts_discovery_slug_trgm_idx
  ON artifacts USING GIN (lower(slug) public.gin_trgm_ops)
  WHERE status = 'active';
CREATE INDEX artifacts_discovery_created_idx
  ON artifacts (created_at DESC, id DESC)
  WHERE status = 'active';
CREATE INDEX artifacts_discovery_updated_idx
  ON artifacts (updated_at DESC, id DESC)
  WHERE status = 'active';
CREATE INDEX artifacts_discovery_name_idx
  ON artifacts (lower(name), id)
  WHERE status = 'active';

COMMIT;
