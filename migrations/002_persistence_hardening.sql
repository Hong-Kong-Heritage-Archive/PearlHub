BEGIN;

ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_tombstone_unlisted
  CHECK (status <> 'tombstone' OR visibility = 'unlisted');

CREATE FUNCTION reject_artifact_identity_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Artifact owner_id is immutable' USING ERRCODE = '55000', CONSTRAINT = 'artifacts_owner_id_immutable';
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    RAISE EXCEPTION 'Artifact name is immutable' USING ERRCODE = '55000', CONSTRAINT = 'artifacts_name_immutable';
  END IF;
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'Artifact slug is immutable' USING ERRCODE = '55000', CONSTRAINT = 'artifacts_slug_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER artifacts_identity_immutable
  BEFORE UPDATE OF owner_id, name, slug ON artifacts
  FOR EACH ROW EXECUTE FUNCTION reject_artifact_identity_mutation();

ALTER TABLE artifact_versions
  ADD CONSTRAINT artifact_versions_id_artifact_id_key UNIQUE (id, artifact_id);

ALTER TABLE dependencies
  ADD CONSTRAINT dependencies_id_target_artifact_id_key UNIQUE (id, target_artifact_id);

ALTER TABLE dependency_resolutions
  ADD COLUMN target_artifact_id UUID;

UPDATE dependency_resolutions AS resolutions
SET target_artifact_id = dependencies.target_artifact_id
FROM dependencies
WHERE dependencies.id = resolutions.dependency_id;

ALTER TABLE dependency_resolutions
  ALTER COLUMN target_artifact_id SET NOT NULL,
  ADD CONSTRAINT dependency_resolutions_dependency_target_fkey
    FOREIGN KEY (dependency_id, target_artifact_id)
    REFERENCES dependencies (id, target_artifact_id),
  ADD CONSTRAINT dependency_resolutions_version_target_fkey
    FOREIGN KEY (resolved_artifact_version_id, target_artifact_id)
    REFERENCES artifact_versions (id, artifact_id);

CREATE FUNCTION set_dependency_resolution_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT target_artifact_id
  INTO NEW.target_artifact_id
  FROM dependencies
  WHERE id = NEW.dependency_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dependency does not exist' USING ERRCODE = '23503', CONSTRAINT = 'dependency_resolutions_dependency_id_fkey';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dependency_resolutions_set_target
  BEFORE INSERT OR UPDATE OF dependency_id ON dependency_resolutions
  FOR EACH ROW EXECUTE FUNCTION set_dependency_resolution_target();

COMMIT;
