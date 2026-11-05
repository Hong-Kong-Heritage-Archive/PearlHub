BEGIN;

ALTER TABLE dependency_resolution_runs
  ADD COLUMN initiator_user_id UUID REFERENCES users(id),
  ADD COLUMN manifest_version SMALLINT,
  ADD COLUMN policy_version TEXT,
  ADD COLUMN manifest_hash TEXT,
  ADD CONSTRAINT dependency_resolution_runs_manifest_metadata_check CHECK (
    (
      initiator_user_id IS NULL
      AND manifest_version IS NULL
      AND policy_version IS NULL
      AND manifest_hash IS NULL
    )
    OR (
      initiator_user_id IS NOT NULL
      AND manifest_version IS NOT NULL
      AND manifest_version > 0
      AND policy_version IS NOT NULL
      AND length(btrim(policy_version)) > 0
      AND manifest_hash IS NOT NULL
      AND manifest_hash ~ '^sha256:[0-9a-f]{64}$'
    )
  );

COMMIT;
