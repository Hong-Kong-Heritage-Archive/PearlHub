BEGIN;

ALTER TABLE drafts
  ADD COLUMN fork_source_artifact_id UUID,
  ADD COLUMN fork_source_version_id UUID,
  ADD COLUMN provenance JSONB,
  ADD CONSTRAINT drafts_fork_source_pair
    CHECK ((fork_source_artifact_id IS NULL) = (fork_source_version_id IS NULL)),
  ADD CONSTRAINT drafts_fork_source_version_fkey
    FOREIGN KEY (fork_source_version_id, fork_source_artifact_id)
    REFERENCES artifact_versions (id, artifact_id),
  ADD CONSTRAINT drafts_provenance_object
    CHECK (provenance IS NULL OR jsonb_typeof(provenance) = 'object');

COMMIT;
