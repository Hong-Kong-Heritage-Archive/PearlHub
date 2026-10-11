BEGIN;

ALTER TABLE users
  ALTER COLUMN external_subject DROP NOT NULL;

CREATE TABLE user_identities (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  subject TEXT NOT NULL CHECK (length(btrim(subject)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
CREATE INDEX user_identities_user_idx ON user_identities(user_id);

ALTER TABLE artifact_lineage
  ADD COLUMN source_version_id UUID;

ALTER TABLE artifact_lineage
  ADD CONSTRAINT artifact_lineage_source_version_parent_fkey
    FOREIGN KEY (source_version_id, parent_artifact_id)
    REFERENCES artifact_versions (id, artifact_id);

CREATE TABLE tombstone_snapshots (
  id UUID PRIMARY KEY,
  artifact_id UUID NOT NULL REFERENCES artifacts(id),
  snapshot_number INTEGER NOT NULL CHECK (snapshot_number > 0),
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (artifact_id, snapshot_number)
);
CREATE INDEX tombstone_snapshots_artifact_idx ON tombstone_snapshots(artifact_id, snapshot_number);

CREATE FUNCTION reject_tombstone_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Tombstone snapshots are immutable' USING ERRCODE = '55000', CONSTRAINT = 'tombstone_snapshots_immutable';
END;
$$;

CREATE TRIGGER tombstone_snapshots_no_update_or_delete
  BEFORE UPDATE OR DELETE ON tombstone_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_tombstone_snapshot_mutation();

CREATE TRIGGER tombstone_snapshots_no_truncate
  BEFORE TRUNCATE ON tombstone_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION reject_tombstone_snapshot_mutation();

CREATE FUNCTION tombstone_artifact(p_artifact_id UUID, p_snapshot_id UUID, p_updated_at TIMESTAMPTZ)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  artifact_row artifacts%ROWTYPE;
  next_snapshot_number INTEGER;
  snapshot_document JSONB;
BEGIN
  SELECT * INTO artifact_row
  FROM artifacts
  WHERE id = p_artifact_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Artifact does not exist' USING ERRCODE = '23503', CONSTRAINT = 'tombstone_snapshots_artifact_id_fkey';
  END IF;

  IF artifact_row.status = 'tombstone' THEN
    RETURN;
  END IF;

  SELECT COALESCE(MAX(ts.snapshot_number), 0) + 1 INTO next_snapshot_number
  FROM tombstone_snapshots ts
  WHERE ts.artifact_id = p_artifact_id;

  SELECT jsonb_build_object(
    'format_version', 1,
    'artifact', to_jsonb(artifact_row),
    'versions', COALESCE((
      SELECT jsonb_agg(to_jsonb(v) ORDER BY v.created_at, v.id)
      FROM artifact_versions v
      WHERE v.artifact_id = p_artifact_id
    ), '[]'::jsonb),
    'dependencies', COALESCE((
      SELECT jsonb_agg(
        to_jsonb(d) || jsonb_build_object(
          'resolutions', COALESCE((
            SELECT jsonb_agg(to_jsonb(r) ORDER BY r.resolved_at, r.id)
            FROM dependency_resolutions r
            WHERE r.dependency_id = d.id
          ), '[]'::jsonb)
        )
        ORDER BY d.created_at, d.id
      )
      FROM dependencies d
      JOIN artifact_versions v ON v.id = d.artifact_version_id
      WHERE v.artifact_id = p_artifact_id
    ), '[]'::jsonb),
    'provenances', COALESCE((
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.imported_at, p.id)
      FROM provenances p
      JOIN artifact_versions v ON v.id = p.artifact_version_id
      WHERE v.artifact_id = p_artifact_id
    ), '[]'::jsonb),
    'compatibility_reports', COALESCE((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at, c.id)
      FROM compatibility_reports c
      JOIN artifact_versions v ON v.id = c.artifact_version_id
      WHERE v.artifact_id = p_artifact_id
    ), '[]'::jsonb),
    'lineage', COALESCE((
      SELECT jsonb_agg(to_jsonb(l) ORDER BY l.created_at, l.id)
      FROM artifact_lineage l
      WHERE l.parent_artifact_id = p_artifact_id OR l.child_artifact_id = p_artifact_id
    ), '[]'::jsonb)
  ) INTO snapshot_document;

  INSERT INTO tombstone_snapshots (id, artifact_id, snapshot_number, snapshot, created_at)
  VALUES (p_snapshot_id, p_artifact_id, next_snapshot_number, snapshot_document, p_updated_at);

  UPDATE artifacts
  SET status = 'tombstone', visibility = 'unlisted', updated_at = p_updated_at
  WHERE id = p_artifact_id;
END;
$$;

CREATE FUNCTION restore_artifact(p_artifact_id UUID, p_visibility TEXT, p_updated_at TIMESTAMPTZ)
RETURNS SETOF artifacts LANGUAGE plpgsql AS $$
DECLARE
  artifact_row artifacts%ROWTYPE;
  original_visibility TEXT;
BEGIN
  SELECT * INTO artifact_row
  FROM artifacts
  WHERE id = p_artifact_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT snapshot->'artifact'->>'visibility' INTO original_visibility
  FROM tombstone_snapshots
  WHERE artifact_id = p_artifact_id
  ORDER BY snapshot_number DESC
  LIMIT 1;

  IF artifact_row.status <> 'tombstone' OR original_visibility IS NULL OR p_visibility <> original_visibility THEN
    RAISE EXCEPTION 'Artifact cannot be restored from the supplied state' USING ERRCODE = '55000', CONSTRAINT = 'artifacts_restore_state';
  END IF;

  RETURN QUERY
  UPDATE artifacts
  SET status = 'active', visibility = original_visibility, updated_at = p_updated_at
  WHERE id = p_artifact_id
  RETURNING *;
END;
$$;

COMMIT;
