-- PearlHub v0.1 PostgreSQL integration tests.
-- Run only against a disposable test database after applying pearlHub schema:
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f pearlhub_v0_1_schema.sql
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f pearlhub_v0_1_schema_tests.sql
-- This script rolls back all fixture rows. It verifies database behavior, not application code.

BEGIN;
DO $$
DECLARE
    u1 uuid;
    u2 uuid;
    a1 uuid;
    a2 uuid;
    v1 uuid;
    v2 uuid;
    file_id uuid;
    dependency_id uuid;
    execution_id uuid;
    failed boolean;
BEGIN
    INSERT INTO users (handle, email) VALUES ('schema_test_owner', 'schema-owner@example.invalid') RETURNING id INTO u1;
    INSERT INTO users (handle, email) VALUES ('schema_test_other', 'schema-other@example.invalid') RETURNING id INTO u2;

    INSERT INTO artifacts (owner_id, name, slug, visibility)
    VALUES (u1, 'Schema Test Pearl', 'schema-test-pearl', 'public') RETURNING id INTO a1;
    INSERT INTO artifacts (owner_id, name, slug, visibility)
    VALUES (u2, 'Dependency Pearl', 'dependency-pearl', 'public') RETURNING id INTO a2;

    -- Build a version atomically: create unpublished, add snapshot rows, then publish.
    INSERT INTO artifact_versions
        (artifact_id, version_number, semver, canonical_snapshot, content_hash, created_by)
    VALUES (a1, 1, '1.2.3-rc.1+build.7', '{"format":"pearl/v1","skills":[]}'::jsonb,
            repeat('a', 64), u1)
    RETURNING id INTO v1;

    INSERT INTO artifact_version_files
        (artifact_id, artifact_version_id, path, kind, media_type, size_bytes, content_hash, text_content)
    VALUES (a1, v1, 'README.md', 'knowledge', 'text/markdown', 10, repeat('b', 64), '# Hello')
    RETURNING id INTO file_id;

    INSERT INTO artifact_version_skills
        (artifact_id, artifact_version_id, skill_key, name, skill_markdown)
    VALUES (a1, v1, 'main', 'Main Skill', '---\nname: main\n---\nDo the task.');

    INSERT INTO artifact_versions
        (artifact_id, version_number, semver, canonical_snapshot, content_hash, created_by)
    VALUES (a2, 1, '0.1.0', '{"format":"pearl/v1"}'::jsonb, repeat('c', 64), u2)
    RETURNING id INTO v2;
    UPDATE artifact_versions SET published_at = now() WHERE id = v2;

    INSERT INTO artifact_version_dependencies
        (artifact_id, artifact_version_id, dependency_artifact_id, declared_range, dependency_alias)
    VALUES (a1, v1, a2, '^0.1.0', 'dep') RETURNING id INTO dependency_id;

    UPDATE artifact_versions SET published_at = now() WHERE id = v1;
    UPDATE artifacts SET current_version_id = v1 WHERE id = a1;
    UPDATE artifacts SET current_version_id = v2 WHERE id = a2;

    -- Published version and child snapshot rows cannot be edited or deleted.
    failed := false;
    BEGIN
        UPDATE artifact_versions SET title = 'tampered' WHERE id = v1;
    EXCEPTION WHEN raise_exception THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'TEST FAILED: published version update was accepted'; END IF;

    failed := false;
    BEGIN
        DELETE FROM artifact_versions WHERE id = v1;
    EXCEPTION WHEN raise_exception THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'TEST FAILED: published version delete was accepted'; END IF;

    failed := false;
    BEGIN
        UPDATE artifact_version_files SET text_content = 'tampered' WHERE id = file_id;
    EXCEPTION WHEN raise_exception THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'TEST FAILED: published version file update was accepted'; END IF;

    failed := false;
    BEGIN
        INSERT INTO artifact_version_skills
            (artifact_id, artifact_version_id, skill_key, name, skill_markdown)
        VALUES (a1, v1, 'late-skill', 'Late Skill', 'must not be appended');
    EXCEPTION WHEN raise_exception THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'TEST FAILED: child row append after publication was accepted'; END IF;

    -- Artifact identity is immutable.
    failed := false;
    BEGIN
        UPDATE artifacts SET name = 'Renamed Pearl' WHERE id = a1;
    EXCEPTION WHEN raise_exception THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'TEST FAILED: artifact rename was accepted'; END IF;

    failed := false;
    BEGIN
        UPDATE artifacts SET owner_id = u2 WHERE id = a1;
    EXCEPTION WHEN raise_exception THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'TEST FAILED: artifact owner transfer was accepted'; END IF;

    -- current_version must belong to this artifact and be published.
    failed := false;
    BEGIN
        UPDATE artifacts SET current_version_id = v2 WHERE id = a1;
    EXCEPTION WHEN raise_exception OR foreign_key_violation THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'TEST FAILED: cross-artifact current_version was accepted'; END IF;

    -- Strict SemVer: valid prerelease/build metadata accepted; invalid leading-zero prerelease rejected.
    failed := false;
    BEGIN
        INSERT INTO artifact_versions
            (artifact_id, version_number, semver, canonical_snapshot, content_hash, created_by, published_at)
        VALUES (a1, 2, '1.2.3-01', '{}'::jsonb, repeat('d', 64), u1, now());
    EXCEPTION WHEN check_violation THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'TEST FAILED: invalid SemVer 1.2.3-01 was accepted'; END IF;

    -- Dependency resolution must match the declaration, its target, and the execution's version.
    INSERT INTO execution_records (record_kind, artifact_id, artifact_version_id, actor_user_id)
    VALUES ('playground', a1, v1, u1) RETURNING id INTO execution_id;

    INSERT INTO execution_dependency_resolutions
        (execution_record_id, dependency_id, declared_range, resolved_artifact_id,
         resolved_artifact_version_id, resolved_semver, resolved_content_hash)
    VALUES (execution_id, dependency_id, '^0.1.0', a2, v2, '0.1.0', repeat('c', 64));

    failed := false;
    BEGIN
        INSERT INTO execution_dependency_resolutions
            (execution_record_id, dependency_id, declared_range, resolved_artifact_id,
             resolved_artifact_version_id, resolved_semver, resolved_content_hash)
        VALUES (execution_id, dependency_id, '^9.0.0', a2, v2, '0.1.0', repeat('c', 64));
    EXCEPTION WHEN raise_exception THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'TEST FAILED: mismatched declared range was accepted'; END IF;

    -- Tombstoning is allowed only with an unlisted snapshot, then tombstone is immutable.
    UPDATE artifacts
       SET status = 'tombstone', visibility = 'unlisted', deleted_at = now(),
           tombstone_snapshot = jsonb_build_object('artifact_id', a1, 'name', 'Schema Test Pearl',
                                                   'slug', 'schema-test-pearl', 'owner_id', u1,
                                                   'current_version_id', v1)
     WHERE id = a1;

    failed := false;
    BEGIN
        UPDATE artifacts SET visibility = 'public' WHERE id = a1;
    EXCEPTION WHEN raise_exception THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'TEST FAILED: tombstone mutation was accepted'; END IF;

    -- DELETE on an Artifact must create a tombstone instead of physically deleting it.
    DELETE FROM artifacts WHERE id = a2;
    IF NOT EXISTS (SELECT 1 FROM artifacts WHERE id = a2 AND status = 'tombstone'
                   AND visibility = 'unlisted' AND tombstone_snapshot IS NOT NULL) THEN
        RAISE EXCEPTION 'TEST FAILED: Artifact DELETE did not create a tombstone';
    END IF;

    -- User hard-delete is prohibited; account deletion must use the service workflow
    -- (tombstone owned artifacts, then set users.is_active=false).
    failed := false;
    BEGIN
        DELETE FROM users WHERE id = u1;
    EXCEPTION WHEN raise_exception OR foreign_key_violation THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'TEST FAILED: user hard-delete was accepted'; END IF;

    RAISE NOTICE 'All PearlHub schema integration assertions passed.';
END;
$$;

-- Force deferred constraints (including the version publication invariant) to run now.
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
