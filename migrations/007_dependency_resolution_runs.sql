BEGIN;

ALTER TABLE dependencies
  ADD CONSTRAINT dependencies_id_artifact_version_key UNIQUE (id, artifact_version_id);

CREATE TABLE dependency_resolution_runs (
  id UUID PRIMARY KEY,
  source_artifact_version_id UUID NOT NULL REFERENCES artifact_versions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dependency_resolution_runs_id_source_version_key
    UNIQUE (id, source_artifact_version_id)
);
CREATE INDEX dependency_resolution_runs_source_created_idx
  ON dependency_resolution_runs(source_artifact_version_id, created_at, id);

ALTER TABLE dependency_resolutions
  ADD COLUMN run_id UUID,
  ADD COLUMN source_artifact_version_id UUID;

UPDATE dependency_resolutions AS resolutions
SET source_artifact_version_id = dependencies.artifact_version_id
FROM dependencies
WHERE dependencies.id = resolutions.dependency_id;

ALTER TABLE dependency_resolutions
  ALTER COLUMN source_artifact_version_id SET NOT NULL,
  ADD CONSTRAINT dependency_resolutions_dependency_source_fkey
    FOREIGN KEY (dependency_id, source_artifact_version_id)
    REFERENCES dependencies (id, artifact_version_id),
  ADD CONSTRAINT dependency_resolutions_run_source_fkey
    FOREIGN KEY (run_id, source_artifact_version_id)
    REFERENCES dependency_resolution_runs (id, source_artifact_version_id),
  ADD CONSTRAINT dependency_resolutions_run_dependency_key
    UNIQUE (run_id, dependency_id);

CREATE INDEX dependency_resolutions_run_idx
  ON dependency_resolutions(run_id, resolved_at, id)
  WHERE run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION set_dependency_resolution_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT target_artifact_id, artifact_version_id
  INTO NEW.target_artifact_id, NEW.source_artifact_version_id
  FROM dependencies
  WHERE id = NEW.dependency_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dependency does not exist' USING ERRCODE = '23503', CONSTRAINT = 'dependency_resolutions_dependency_id_fkey';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_dependency_resolution_run_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Dependency resolution runs are immutable' USING ERRCODE = '55000', CONSTRAINT = 'dependency_resolution_runs_immutable';
END;
$$;

CREATE TRIGGER dependency_resolution_runs_no_update_or_delete
  BEFORE UPDATE OR DELETE ON dependency_resolution_runs
  FOR EACH ROW EXECUTE FUNCTION reject_dependency_resolution_run_mutation();
CREATE TRIGGER dependency_resolution_runs_no_truncate
  BEFORE TRUNCATE ON dependency_resolution_runs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_dependency_resolution_run_mutation();

CREATE FUNCTION reject_dependency_resolution_item_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Dependency resolution history is immutable' USING ERRCODE = '55000', CONSTRAINT = 'dependency_resolutions_immutable';
END;
$$;

CREATE TRIGGER dependency_resolutions_no_update_or_delete
  BEFORE UPDATE OR DELETE ON dependency_resolutions
  FOR EACH ROW EXECUTE FUNCTION reject_dependency_resolution_item_mutation();
CREATE TRIGGER dependency_resolutions_no_truncate
  BEFORE TRUNCATE ON dependency_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_dependency_resolution_item_mutation();

CREATE FUNCTION reject_dependency_changes_after_resolution_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_version_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (
      SELECT 1 FROM dependency_resolution_runs
      WHERE source_artifact_version_id = OLD.artifact_version_id
         OR source_artifact_version_id = NEW.artifact_version_id
    ) THEN
      RAISE EXCEPTION 'Dependencies referenced by a resolution run are immutable' USING ERRCODE = '55000', CONSTRAINT = 'dependencies_resolution_runs_immutable';
    END IF;
    RETURN NEW;
  END IF;

  source_version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.artifact_version_id ELSE NEW.artifact_version_id END;
  IF EXISTS (
    SELECT 1 FROM dependency_resolution_runs
    WHERE source_artifact_version_id = source_version_id
  ) THEN
    RAISE EXCEPTION 'Dependencies referenced by a resolution run are immutable' USING ERRCODE = '55000', CONSTRAINT = 'dependencies_resolution_runs_immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dependencies_resolution_runs_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON dependencies
  FOR EACH ROW EXECUTE FUNCTION reject_dependency_changes_after_resolution_run();

CREATE FUNCTION assert_dependency_resolution_run_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  resolution_run_id UUID;
  source_version_id UUID;
  dependency_count BIGINT;
  resolution_count BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'dependency_resolution_runs' THEN
    resolution_run_id := (to_jsonb(NEW)->>'id')::UUID;
  ELSE
    resolution_run_id := (to_jsonb(NEW)->>'run_id')::UUID;
  END IF;

  SELECT source_artifact_version_id INTO source_version_id
  FROM dependency_resolution_runs
  WHERE id = resolution_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dependency resolution run does not exist' USING ERRCODE = '23503', CONSTRAINT = 'dependency_resolutions_run_source_fkey';
  END IF;

  SELECT count(*) INTO dependency_count
  FROM dependencies
  WHERE artifact_version_id = source_version_id;
  SELECT count(*) INTO resolution_count
  FROM dependency_resolutions
  WHERE run_id = resolution_run_id;

  IF dependency_count <> resolution_count THEN
    RAISE EXCEPTION 'A dependency resolution run must contain every source dependency exactly once' USING ERRCODE = '23514', CONSTRAINT = 'dependency_resolution_runs_complete';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER dependency_resolution_runs_complete
  AFTER INSERT ON dependency_resolution_runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_dependency_resolution_run_complete();

CREATE CONSTRAINT TRIGGER dependency_resolution_items_complete
  AFTER INSERT ON dependency_resolutions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.run_id IS NOT NULL)
  EXECUTE FUNCTION assert_dependency_resolution_run_complete();

CREATE OR REPLACE FUNCTION tombstone_artifact(p_artifact_id UUID, p_snapshot_id UUID, p_updated_at TIMESTAMPTZ)
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
    'format_version', 2,
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
    'dependency_resolution_runs', COALESCE((
      SELECT jsonb_agg(
        to_jsonb(run) || jsonb_build_object(
          'items', COALESCE((
            SELECT jsonb_agg(to_jsonb(item) ORDER BY item.resolved_at, item.id)
            FROM dependency_resolutions item
            WHERE item.run_id = run.id
          ), '[]'::jsonb)
        )
        ORDER BY run.created_at, run.id
      )
      FROM dependency_resolution_runs run
      JOIN artifact_versions v ON v.id = run.source_artifact_version_id
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

COMMIT;
