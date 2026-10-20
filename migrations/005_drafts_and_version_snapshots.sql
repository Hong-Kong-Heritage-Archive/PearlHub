BEGIN;

ALTER TABLE artifact_versions
  ADD COLUMN content_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT artifact_versions_content_snapshot_object
    CHECK (jsonb_typeof(content_snapshot) = 'object');

CREATE TABLE drafts (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id),
  artifact_id UUID REFERENCES artifacts(id),
  base_version_id UUID,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  visibility TEXT NOT NULL CHECK (visibility IN ('private','unlisted','public')),
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  state TEXT NOT NULL CHECK (state IN ('active','published','discarded')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (artifact_id IS NOT NULL OR base_version_id IS NULL),
  CONSTRAINT drafts_base_version_artifact_fkey
    FOREIGN KEY (base_version_id, artifact_id)
    REFERENCES artifact_versions(id, artifact_id)
);
CREATE INDEX drafts_owner_state_idx ON drafts(owner_id, state);
CREATE UNIQUE INDEX drafts_one_active_per_artifact_idx
  ON drafts(artifact_id) WHERE artifact_id IS NOT NULL AND state = 'active';

COMMIT;
