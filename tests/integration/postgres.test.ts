import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloneArtifactService, DeleteArtifactService, ForkArtifactService } from "../../src/application/services.js";
import { PostgresArtifactRepository, PostgresArtifactVersionRepository, PostgresDependencyRepository, PostgresLineageRepository, PostgresTransactionManager } from "../../src/adapters/postgres.js";
import { Artifact } from "../../src/domain/artifact.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import { Dependency } from "../../src/domain/dependency.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
const schema = `pearlhub_test_${randomUUID().replaceAll("-", "")}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` }) : undefined;

integration("PostgreSQL persistence hardening", () => {
  const owners = [randomUUID(), randomUUID(), randomUUID()];

  beforeAll(async () => {
    await adminPool!.query(`CREATE SCHEMA ${schema}`);
    for (const migrationFile of ["001_initial.sql", "002_persistence_hardening.sql"]) {
      const migration = await readFile(resolve(process.cwd(), "migrations", migrationFile), "utf8");
      await pool!.query(migration);
    }
    await pool!.query("INSERT INTO users (id, external_subject) VALUES ($1,$2),($3,$4),($5,$6)", [owners[0], "owner-a", owners[1], "owner-b", owners[2], "owner-c"]);
  });

  afterAll(async () => {
    await pool!.end();
    await adminPool!.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool!.end();
  });

  it("matches the frozen table, column, constraint, trigger, and index inventory", async () => {
    const tables = await pool!.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "artifact_lineage", "artifact_versions", "artifacts", "compatibility_reports",
      "dependencies", "dependency_resolutions", "provenances", "users",
    ]);

    const columns = await pool!.query<{ table_name: string; column_name: string }>(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() ORDER BY table_name,column_name",
    );
    const actualColumns = columns.rows.reduce<Record<string, string[]>>((grouped, row) => {
      (grouped[row.table_name] ??= []).push(row.column_name);
      return grouped;
    }, {});
    const expectedColumns: Record<string, string[]> = {
      users: ["id", "external_subject", "created_at", "updated_at"],
      artifacts: ["id", "owner_id", "name", "slug", "visibility", "status", "created_at", "updated_at"],
      artifact_versions: ["id", "artifact_id", "version", "content_hash", "content_location", "created_at", "published_at"],
      artifact_lineage: ["id", "parent_artifact_id", "child_artifact_id", "relationship_type", "created_at"],
      provenances: ["id", "artifact_version_id", "source_type", "source_url", "source_ref", "imported_at"],
      dependencies: ["id", "artifact_version_id", "target_artifact_id", "declared_range", "created_at"],
      dependency_resolutions: ["id", "dependency_id", "resolved_artifact_version_id", "resolved_at", "target_artifact_id"],
      compatibility_reports: ["id", "artifact_version_id", "target_artifact_version_id", "status", "report", "created_at"],
    };
    expect(Object.keys(actualColumns).sort()).toEqual(Object.keys(expectedColumns).sort());
    for (const [tableName, expected] of Object.entries(expectedColumns)) {
      expect(actualColumns[tableName]?.sort()).toEqual(expected.sort());
    }

    const constraints = await pool!.query<{ conname: string; contype: string }>(
      "SELECT conname,contype FROM pg_constraint JOIN pg_class ON pg_class.oid=conrelid JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace WHERE nspname=current_schema() ORDER BY conname",
    );
    const expectedConstraints: [string, string][] = [
      ["artifact_lineage_child_artifact_id_fkey", "f"],
      ["artifact_lineage_check", "c"],
      ["artifact_lineage_parent_artifact_id_child_artifact_id_relat_key", "u"],
      ["artifact_lineage_parent_artifact_id_fkey", "f"],
      ["artifact_lineage_pkey", "p"],
      ["artifact_lineage_relationship_type_check", "c"],
      ["artifact_versions_artifact_id_content_hash_key", "u"],
      ["artifact_versions_artifact_id_fkey", "f"],
      ["artifact_versions_artifact_id_version_key", "u"],
      ["artifact_versions_id_artifact_id_key", "u"],
      ["artifact_versions_pkey", "p"],
      ["artifacts_name_check", "c"],
      ["artifacts_owner_id_fkey", "f"],
      ["artifacts_owner_id_slug_key", "u"],
      ["artifacts_pkey", "p"],
      ["artifacts_slug_check", "c"],
      ["artifacts_status_check", "c"],
      ["artifacts_tombstone_unlisted", "c"],
      ["artifacts_visibility_check", "c"],
      ["compatibility_reports_artifact_version_id_fkey", "f"],
      ["compatibility_reports_pkey", "p"],
      ["compatibility_reports_target_artifact_version_id_fkey", "f"],
      ["dependencies_artifact_version_id_fkey", "f"],
      ["dependencies_id_target_artifact_id_key", "u"],
      ["dependencies_pkey", "p"],
      ["dependencies_target_artifact_id_fkey", "f"],
      ["dependency_resolutions_dependency_id_fkey", "f"],
      ["dependency_resolutions_dependency_target_fkey", "f"],
      ["dependency_resolutions_pkey", "p"],
      ["dependency_resolutions_resolved_artifact_version_id_fkey", "f"],
      ["dependency_resolutions_version_target_fkey", "f"],
      ["provenances_artifact_version_id_fkey", "f"],
      ["provenances_pkey", "p"],
      ["users_external_subject_key", "u"],
      ["users_pkey", "p"],
    ];
    const actualConstraintInventory = constraints.rows.map((row) => `${row.conname}:${row.contype}`).sort();
    expect(actualConstraintInventory).toEqual(expectedConstraints.map(([name, type]) => `${name}:${type}`).sort());

    const triggers = await pool!.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger JOIN pg_class ON pg_class.oid=tgrelid JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace WHERE nspname=current_schema() AND NOT tgisinternal ORDER BY tgname",
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "artifact_versions_immutable", "artifacts_identity_immutable", "artifacts_no_physical_delete", "dependency_resolutions_set_target",
    ]);

    const indexes = await pool!.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() ORDER BY indexname",
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "artifacts_owner_idx", "artifacts_visibility_status_idx", "artifact_versions_artifact_idx",
      "artifact_lineage_parent_idx", "artifact_lineage_child_idx", "provenances_version_idx",
      "dependencies_source_idx", "dependencies_target_idx", "dependency_resolutions_dependency_idx",
      "compatibility_reports_source_idx", "compatibility_reports_target_idx",
    ]));
  });

  async function createArtifact(ownerId: string = owners[0]!, slug: string = randomUUID(), visibility: string = "public", status: string = "active"): Promise<string> {
    const id = randomUUID();
    await pool!.query("INSERT INTO artifacts (id,owner_id,name,slug,visibility,status) VALUES ($1,$2,$3,$4,$5,$6)", [id, ownerId, `Artifact ${id}`, slug, visibility, status]);
    return id;
  }

  async function createVersion(artifactId: string, version = "1.0.0", contentHash: string = randomUUID()): Promise<string> {
    const id = randomUUID();
    await pool!.query("INSERT INTO artifact_versions (id,artifact_id,version,content_hash,content_location,published_at) VALUES ($1,$2,$3,$4,'loc',now())", [id, artifactId, version, contentHash]);
    return id;
  }

  it("preserves owner-scoped slug, version, and content-hash uniqueness", async () => {
    const artifactA = await createArtifact(owners[0], "shared-slug");
    const artifactB = await createArtifact(owners[1], "shared-slug");
    await expect(createArtifact(owners[0], "shared-slug")).rejects.toMatchObject({ code: "23505" });
    await createVersion(artifactA);
    await expect(createVersion(artifactA)).rejects.toMatchObject({ code: "23505" });
    await createVersion(artifactB);
    await createVersion(artifactA, "2.0.0", "duplicate-hash");
    await expect(createVersion(artifactA, "3.0.0", "duplicate-hash")).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects changes to Artifact identity and preserves the original values", async () => {
    const artifactId = await createArtifact(owners[0], "immutable-slug");
    const original = (await pool!.query("SELECT owner_id,name,slug FROM artifacts WHERE id=$1", [artifactId])).rows[0];
    await expect(pool!.query("UPDATE artifacts SET owner_id=$2 WHERE id=$1", [artifactId, owners[1]])).rejects.toMatchObject({ code: "55000" });
    await expect(pool!.query("UPDATE artifacts SET name='Changed' WHERE id=$1", [artifactId])).rejects.toMatchObject({ code: "55000" });
    await expect(pool!.query("UPDATE artifacts SET slug='changed-slug' WHERE id=$1", [artifactId])).rejects.toMatchObject({ code: "55000" });
    expect((await pool!.query("SELECT owner_id,name,slug FROM artifacts WHERE id=$1", [artifactId])).rows[0]).toEqual(original);
    await pool!.query("UPDATE artifacts SET visibility='private',updated_at=now() WHERE id=$1", [artifactId]);
  });

  it("enforces tombstone visibility and application deletion tombstones", async () => {
    await createArtifact(owners[0], randomUUID(), "public", "active");
    await createArtifact(owners[0], randomUUID(), "private", "active");
    await createArtifact(owners[0], randomUUID(), "unlisted", "active");
    await createArtifact(owners[0], randomUUID(), "unlisted", "tombstone");
    await expect(createArtifact(owners[0], randomUUID(), "public", "tombstone")).rejects.toMatchObject({ code: "23514" });
    await expect(createArtifact(owners[0], randomUUID(), "private", "tombstone")).rejects.toMatchObject({ code: "23514" });
    const artifactId = await createArtifact(owners[0], randomUUID());
    const artifacts = new PostgresArtifactRepository(pool!);
    await new DeleteArtifactService(artifacts, { canRead: async () => false, canWrite: async () => false }).execute({ actorId: owners[0]!, artifactId });
    expect((await pool!.query("SELECT status,visibility FROM artifacts WHERE id=$1", [artifactId])).rows[0]).toEqual({ status: "tombstone", visibility: "unlisted" });
  });

  it("keeps published versions immutable and rejects physical Artifact deletion", async () => {
    const artifactId = await createArtifact();
    const versionId = await createVersion(artifactId);
    await expect(pool!.query("UPDATE artifact_versions SET artifact_id=$2 WHERE id=$1", [versionId, randomUUID()])).rejects.toMatchObject({ code: "55000" });
    await expect(pool!.query("UPDATE artifact_versions SET version='2.0.0' WHERE id=$1", [versionId])).rejects.toMatchObject({ code: "55000" });
    await expect(pool!.query("UPDATE artifact_versions SET content_hash='changed' WHERE id=$1", [versionId])).rejects.toMatchObject({ code: "55000" });
    await expect(pool!.query("UPDATE artifact_versions SET content_location='changed' WHERE id=$1", [versionId])).rejects.toMatchObject({ code: "55000" });
    await expect(pool!.query("UPDATE artifact_versions SET created_at=now() WHERE id=$1", [versionId])).rejects.toMatchObject({ code: "55000" });
    await expect(pool!.query("UPDATE artifact_versions SET published_at=now() WHERE id=$1", [versionId])).rejects.toMatchObject({ code: "55000" });
    await expect(pool!.query("DELETE FROM artifact_versions WHERE id=$1", [versionId])).rejects.toMatchObject({ code: "55000" });
    await expect(pool!.query("DELETE FROM artifacts WHERE id=$1", [artifactId])).rejects.toMatchObject({ code: "55000" });
  });

  it("enforces dependency resolution target integrity", async () => {
    const artifactA = await createArtifact();
    const artifactB = await createArtifact();
    const versionA = await createVersion(artifactA);
    const versionB = await createVersion(artifactB);
    const dependencyId = randomUUID();
    await pool!.query("INSERT INTO dependencies (id,artifact_version_id,target_artifact_id,declared_range) VALUES ($1,$2,$3,'*')", [dependencyId, versionA, artifactA]);
    const dependencies = new PostgresDependencyRepository(pool!);
    await dependencies.createResolution({ id: randomUUID(), dependencyId, resolvedArtifactVersionId: versionA, resolvedAt: new Date() });
    await expect(dependencies.createResolution({ id: randomUUID(), dependencyId, resolvedArtifactVersionId: versionB, resolvedAt: new Date() })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("enforces foreign keys for all persisted relationships", async () => {
    const artifactId = await createArtifact();
    const versionId = await createVersion(artifactId);
    const dependencyId = randomUUID();
    const badId = randomUUID();
    await expect(createArtifact(badId)).rejects.toMatchObject({ code: "23503" });
    await expect(createVersion(badId)).rejects.toMatchObject({ code: "23503" });
    await expect(pool!.query("INSERT INTO artifact_lineage (id,parent_artifact_id,child_artifact_id,relationship_type) VALUES ($1,$2,$3,'fork')", [randomUUID(), badId, artifactId])).rejects.toMatchObject({ code: "23503" });
    await expect(pool!.query("INSERT INTO artifact_lineage (id,parent_artifact_id,child_artifact_id,relationship_type) VALUES ($1,$2,$3,'fork')", [randomUUID(), artifactId, badId])).rejects.toMatchObject({ code: "23503" });
    await expect(pool!.query("INSERT INTO provenances (id,artifact_version_id,source_type,source_url,source_ref) VALUES ($1,$2,'github','url','ref')", [randomUUID(), badId])).rejects.toMatchObject({ code: "23503" });
    await expect(pool!.query("INSERT INTO dependencies (id,artifact_version_id,target_artifact_id,declared_range) VALUES ($1,$2,$3,'*')", [randomUUID(), badId, artifactId])).rejects.toMatchObject({ code: "23503" });
    await expect(pool!.query("INSERT INTO dependencies (id,artifact_version_id,target_artifact_id,declared_range) VALUES ($1,$2,$3,'*')", [randomUUID(), versionId, badId])).rejects.toMatchObject({ code: "23503" });
    await expect(pool!.query("INSERT INTO dependency_resolutions (id,dependency_id,resolved_artifact_version_id) VALUES ($1,$2,$3)", [randomUUID(), badId, versionId])).rejects.toMatchObject({ code: "23503" });
    await pool!.query("INSERT INTO dependencies (id,artifact_version_id,target_artifact_id,declared_range) VALUES ($1,$2,$3,'*')", [dependencyId, versionId, artifactId]);
    await expect(pool!.query("INSERT INTO dependency_resolutions (id,dependency_id,resolved_artifact_version_id) VALUES ($1,$2,$3)", [randomUUID(), dependencyId, badId])).rejects.toMatchObject({ code: "23503" });
    await expect(pool!.query("INSERT INTO compatibility_reports (id,artifact_version_id,status,report) VALUES ($1,$2,'ok','{}')", [randomUUID(), badId])).rejects.toMatchObject({ code: "23503" });
    await expect(pool!.query("INSERT INTO compatibility_reports (id,artifact_version_id,target_artifact_version_id,status,report) VALUES ($1,$2,$3,'ok','{}')", [randomUUID(), versionId, badId])).rejects.toMatchObject({ code: "23503" });
  });

  it("preserves fork lineage, clone behavior, and lineage after tombstoning", async () => {
    const sourceId = await createArtifact();
    await createVersion(sourceId);
    const artifacts = new PostgresArtifactRepository(pool!);
    const versions = new PostgresArtifactVersionRepository(pool!);
    const dependencies = new PostgresDependencyRepository(pool!);
    const lineage = new PostgresLineageRepository(pool!);
    const access = { canRead: async () => false, canWrite: async () => false };
    const contentStore = { put: async () => "loc", get: async () => "{}", exists: async () => true };
    const clone = await new CloneArtifactService(artifacts, versions, contentStore, dependencies, access).execute({ actorId: owners[0]!, sourceArtifactId: sourceId, name: "Clone", slug: randomUUID() });
    expect(await lineage.getParents(clone.id)).toEqual([]);
    const fork = await new ForkArtifactService(artifacts, versions, contentStore, dependencies, lineage, access).execute({ actorId: owners[0]!, sourceArtifactId: sourceId, name: "Fork", slug: randomUUID() });
    expect((await lineage.getParents(fork.id)).map((item) => item.parentArtifactId)).toEqual([sourceId]);
    await expect(lineage.createFork(sourceId, fork.id)).rejects.toMatchObject({ code: "LINEAGE_INVALID" });
    await expect(lineage.createFork(sourceId, sourceId)).rejects.toMatchObject({ code: "LINEAGE_INVALID" });
    await new DeleteArtifactService(artifacts, access).execute({ actorId: owners[0]!, artifactId: sourceId });
    expect(await lineage.getChildren(sourceId)).toHaveLength(1);
  });

  it("rolls back Artifact, Version, and Dependency writes in a real transaction", async () => {
    const transactions = new PostgresTransactionManager(pool!);
    const artifacts = new PostgresArtifactRepository(transactions.database);
    const versions = new PostgresArtifactVersionRepository(transactions.database);
    const dependencies = new PostgresDependencyRepository(transactions.database);
    const artifactId = randomUUID();
    const versionId = randomUUID();
    const dependencyId = randomUUID();
    await expect(transactions.run(async () => {
      const artifact = Artifact.create({ id: artifactId, ownerId: owners[0]!, name: "Rollback", slug: randomUUID(), visibility: "private", createdAt: new Date() });
      await artifacts.create(artifact);
      const version = ArtifactVersion.create({ id: versionId, artifactId, version: "1.0.0", contentHash: randomUUID(), contentLocation: "loc", createdAt: new Date(), publishedAt: new Date() });
      await versions.create(version);
      await dependencies.create(Dependency.create({ id: dependencyId, artifactVersionId: versionId, targetArtifactId: artifactId, declaredRange: "*", createdAt: new Date() }));
      throw new Error("force rollback");
    })).rejects.toThrow("force rollback");
    expect((await pool!.query("SELECT (SELECT count(*) FROM artifacts WHERE id=$1) AS artifacts,(SELECT count(*) FROM artifact_versions WHERE id=$2) AS versions,(SELECT count(*) FROM dependencies WHERE id=$3) AS dependencies", [artifactId, versionId, dependencyId])).rows[0]).toEqual({ artifacts: "0", versions: "0", dependencies: "0" });
  });

  it("allows exactly one concurrent owner-scoped slug insert", async () => {
    const slug = randomUUID();
    const attempts = await Promise.allSettled([createArtifact(owners[2], slug), createArtifact(owners[2], slug)]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });
});