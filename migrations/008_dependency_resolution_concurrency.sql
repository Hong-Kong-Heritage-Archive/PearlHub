BEGIN;

CREATE OR REPLACE FUNCTION reject_dependency_changes_after_resolution_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_version_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    PERFORM id
    FROM artifact_versions
    WHERE id IN (OLD.artifact_version_id, NEW.artifact_version_id)
    ORDER BY id
    FOR UPDATE;

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
  PERFORM id
  FROM artifact_versions
  WHERE id = source_version_id
  FOR UPDATE;

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

CREATE FUNCTION lock_dependency_resolution_run_source_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id
  FROM artifact_versions
  WHERE id = NEW.source_artifact_version_id
  FOR UPDATE;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dependency_resolution_runs_lock_source
  BEFORE INSERT ON dependency_resolution_runs
  FOR EACH ROW EXECUTE FUNCTION lock_dependency_resolution_run_source_version();

COMMIT;
