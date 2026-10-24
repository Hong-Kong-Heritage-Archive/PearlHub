import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloneArtifactService, DeleteArtifactService, DraftWorkflowService, ImportDraftService, PublishVersionService, RestoreArtifactService } from "../../src/application/services.js";
import { baselinePostgresMigrations, runPostgresMigrations } from "../../src/adapters/postgres-migrations.js";
import { PostgresArtifactDiscoveryRepository, PostgresArtifactRepository, PostgresArtifactVersionRepository, PostgresCompatibilityReportRepository, PostgresDependencyRepository, PostgresDraftRepository, PostgresLineageRepository, PostgresProvenanceRepository, PostgresTransactionManager, PostgresUserIdentityRepository } from "../../src/adapters/postgres.js";
import { MemoryArtifactContentStore } from "../../src/adapters/content-store.js";
import { Artifact } from "../../src/domain/artifact.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import { Draft } from "../../src/domain/draft.js";
import { Dependency } from "../../src/domain/dependency.js";
import { DevelopmentOnlyFakeAuthenticator } from "../../src/http/testing/development-fake-authenticator.js";
import { createHttpApp } from "../../src/http/app.js";
import { ListArtifactsService } from "../../src/application/discovery.js";
import { createPostgresRuntime } from "../../src/runtime.js";
import type { CompatibilityReport, Provenance } from "../../src/domain/records.js";

function requiredTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    throw new Error("TEST_DATABASE_URL is required; configure a dedicated disposable PostgreSQL database ending in _test.");
  }
  let testUrl: URL;
  try {
    testUrl = new URL(value);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  const databaseName = decodeURIComponent(testUrl.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(testUrl.protocol) || !databaseName.endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL must target a dedicated database whose name ends in _test.");
  }
  const applicationUrl = process.env.DATABASE_URL;
  if (applicationUrl) {
    const appUrl = new URL(applicationUrl);
    if (decodeURIComponent(appUrl.pathname) === decodeURIComponent(testUrl.pathname)) {
      throw new Error("TEST_DATABASE_URL must not target DATABASE_URL; use a separate disposable test database.");
    }
  }
  return value;
}

const databaseUrl = requiredTestDatabaseUrl();
const adminPool = new Pool({ connectionString: databaseUrl });
const schema = `pearlhub_test_${randomUUID().replaceAll("-", "")}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });

describe("PostgreSQL persistence hardening", () => {
  const owners = [randomUUID(), randomUUID(), randomUUID()];
  let schemaCreated = false;
  let firstMigrationRun: string[] = [];
  let repeatedMigrationRun: string[] = [];

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    firstMigrationRun = await runPostgresMigrations(pool);
    await pool.query("INSERT INTO users (id, external_subject) VALUES ($1,$2),($3,$4),($5,$6)", [owners[0], "owner-a", owners[1], "owner-b", owners[2], "owner-c"]);
    repeatedMigrationRun = await runPostgresMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
    try {
      if (schemaCreated) await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await adminPool.end();
    }
  });

  it("applies all migrations on a fresh schema and is repeat-safe", async () => {
    expect(firstMigrationRun).toEqual([
      "001_initial.sql",
      "002_persistence_hardening.sql",
      "003_identity_mapping_and_tombstone_snapshots.sql",
      "004_artifact_discovery.sql",
      "005_drafts_and_version_snapshots.sql",
      "006_draft_origins.sql",
    ]);
    expect(repeatedMigrationRun).toEqual([]);
    const ledger = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM schema_migrations",
    );
    expect(ledger.rows[0]?.count).toBe(6);
  });

  it("baselines a complete manually migrated schema without rerunning SQL", async () => {
    const baselineSchema = `pearlhub_baseline_${randomUUID().replaceAll("-", "")}`;
    const baselinePool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${baselineSchema}`,
    });
    let created = false;
    try {
      await adminPool.query(`CREATE SCHEMA ${baselineSchema}`);
      created = true;
      for (const migrationName of [
        "001_initial.sql",
        "002_persistence_hardening.sql",
        "003_identity_mapping_and_tombstone_snapshots.sql",
        "004_artifact_discovery.sql",
        "005_drafts_and_version_snapshots.sql",
        "006_draft_origins.sql",
      ]) {
        const sql = await readFile(resolve(process.cwd(), "migrations", migrationName), "utf8");
        await baselinePool.query(sql);
      }

      expect(await baselinePostgresMigrations(baselinePool)).toEqual([
        "001_initial.sql",
        "002_persistence_hardening.sql",
        "003_identity_mapping_and_tombstone_snapshots.sql",
        "004_artifact_discovery.sql",
        "005_drafts_and_version_snapshots.sql",
        "006_draft_origins.sql",
      ]);
      expect(await runPostgresMigrations(baselinePool)).toEqual([]);
    } finally {
      await baselinePool.end();
      if (created) await adminPool.query(`DROP SCHEMA ${baselineSchema} CASCADE`);
    }
  });

  it("creates a private Draft and atomically publishes a complete 0.1.0 PostgreSQL snapshot", async () => {
    const ownerId = randomUUID();
    await pool.query("INSERT INTO users (id, external_subject) VALUES ($1,$2)", [ownerId, `draft-owner-${ownerId}`]);
    const runtime = await createPostgresRuntime({
      databaseUrl,
      pool,
      authenticator: new DevelopmentOnlyFakeAuthenticator(ownerId, "integration-test-token"),
      contentStore: new MemoryArtifactContentStore(),
    });

    const headers = {
      authorization: "Bearer integration-test-token",
      "content-type": "application/json",
    };
    const requestBody = {
      name: "PostgreSQL HTTP Artifact",
      slug: "postgresql-http-artifact",
      visibility: "private",
      content: {
        instructions: "Use the knowledge file.",
        knowledgeFiles: [{ path: "guide/usage.md", content: "Reference content." }],
        dependencies: [],
        tags: [" RAG ", "language-model"],
      },
    };

    try {
      const response = await runtime.app.request("/api/v1/drafts", {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      });
      expect(response.status).toBe(201);
      const draft = await response.json() as { id: string; ownerId: string; revision: number; state: string };
      expect(draft).toMatchObject({ ownerId, revision: 1, state: "active" });
      expect((await pool.query("SELECT id FROM artifacts WHERE owner_id=$1 AND slug=$2", [ownerId, requestBody.slug])).rows).toEqual([]);

      const otherOwnerDraft = Draft.create({
        id: randomUUID(), ownerId: owners[1]!, artifactId: null, baseVersionId: null,
        name: "Other owner's private Draft", slug: `other-owner-${randomUUID().slice(0, 8)}`,
        visibility: "private", content: { instructions: "Private", knowledgeFiles: [], dependencies: [] },
        createdAt: new Date(), updatedAt: new Date(),
      });
      await new PostgresDraftRepository(pool).create(otherOwnerDraft);
      const draftList = await runtime.app.request("/api/v1/drafts", { headers });
      expect(draftList.status).toBe(200);
      const listedDrafts = await draftList.json() as Array<Record<string, unknown>>;
      expect(listedDrafts.map((item) => item.id)).toEqual([draft.id]);
      expect(listedDrafts[0]).not.toHaveProperty("content");

      const publish = await runtime.app.request(`/api/v1/drafts/${draft.id}/publish`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: draft.revision }),
      });
      expect(publish.status, await publish.clone().text()).toBe(201);
      const emptyDraftList = await runtime.app.request("/api/v1/drafts", { headers });
      expect(await emptyDraftList.json()).toEqual([]);
      const body = await publish.json() as { artifact: { id: string; ownerId: string; name: string; slug: string; visibility: string; createdAt: string; updatedAt: string }; version: { id: string; version: string; contentHash: string; content: { instructions: string; tags: string[]; knowledgeFiles: Array<{ path: string; content: string; contentHash: string }>; dependencies: unknown[] } } };
      expect(body.artifact).toMatchObject({ ownerId, name: requestBody.name, slug: requestBody.slug, visibility: requestBody.visibility });
      expect(body.version).toMatchObject({ version: "0.1.0", contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), content: { instructions: requestBody.content.instructions, tags: ["rag", "language-model"], knowledgeFiles: [{ path: "guide/usage.md", content: "Reference content.", contentHash: expect.stringMatching(/^sha256:/) }], dependencies: [] } });

      const stored = await pool.query<{ id: string; owner_id: string; name: string; slug: string; visibility: string; status: string; created_at: Date; updated_at: Date }>(
        "SELECT id,owner_id,name,slug,visibility,status,created_at,updated_at FROM artifacts WHERE id=$1",
        [body.artifact.id],
      );
      expect(stored.rows[0]).toEqual({
        id: body.artifact.id,
        owner_id: ownerId,
        name: requestBody.name,
        slug: requestBody.slug,
        visibility: requestBody.visibility,
        status: "active",
        created_at: new Date(body.artifact.createdAt),
        updated_at: new Date(body.artifact.updatedAt),
      });
      const persistedVersion = await pool.query<{ version: string; content_snapshot: Record<string, unknown> }>(
        "SELECT version,content_snapshot FROM artifact_versions WHERE id=$1",
        [body.version.id],
      );
      expect(persistedVersion.rows[0]).toMatchObject({ version: "0.1.0", content_snapshot: body.version.content });
      expect(await pool.query("SELECT state FROM drafts WHERE id=$1", [draft.id])).toMatchObject({ rows: [{ state: "published" }] });

      const readVersion = await runtime.app.request(`/api/v1/artifacts/${body.artifact.id}/versions/0.1.0`, { headers });
      expect(readVersion.status).toBe(200);
      expect(await readVersion.json()).toMatchObject({ version: { content: body.version.content, contentHash: body.version.contentHash } });

      const ownerDiscovery = await runtime.app.request("/api/v1/artifacts?visibility=private", { headers });
      expect(ownerDiscovery.status).toBe(200);
      const ownerPage = await ownerDiscovery.json() as { items: Array<{ id: string; visibility: string; tags: string[] }> };
      expect(ownerPage.items).toContainEqual(expect.objectContaining({
        id: body.artifact.id,
        visibility: "private",
        tags: ["rag", "language-model"],
      }));
      const anonymousDiscovery = await runtime.app.request("/api/v1/artifacts?visibility=private");
      expect(anonymousDiscovery.status).toBe(200);
      expect((await anonymousDiscovery.json() as { items: Array<{ id: string }> }).items)
        .not.toContainEqual(expect.objectContaining({ id: body.artifact.id }));

      const repeatPublish = await runtime.app.request(`/api/v1/drafts/${draft.id}/publish`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: draft.revision }),
      });
      expect(repeatPublish.status).toBe(409);
      expect(await repeatPublish.text()).toContain("DRAFT_NOT_ACTIVE");

      const invalidDraft = await runtime.app.request("/api/v1/drafts", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...requestBody, ownerId: owners[1] }),
      });
      expect(invalidDraft.status).toBe(400);
    } finally {
      await runtime.close();
    }
  });

  it("rolls back Artifact, version, and Draft state together when dependency persistence fails", async () => {
    const transactions = new PostgresTransactionManager(pool!);
    const artifacts = new PostgresArtifactRepository(transactions.database);
    const versions = new PostgresArtifactVersionRepository(transactions.database);
    const dependencies = new PostgresDependencyRepository(transactions.database);
    const drafts = new PostgresDraftRepository(transactions.database);
    const discovery = new PostgresArtifactDiscoveryRepository(transactions.database);
    const service = new DraftWorkflowService(
      drafts, artifacts, versions, dependencies,
      { canRead: async (actorId, artifact) => actorId === artifact.ownerId || artifact.visibility === "public", canWrite: async (actorId, artifact) => actorId === artifact.ownerId },
      discovery, transactions,
    );
    const target = Artifact.create({ id: randomUUID(), ownerId: owners[1]!, name: "Dependency target", slug: `dependency-target-${randomUUID().slice(0, 8)}`, visibility: "public", createdAt: new Date() });
    await artifacts.create(target);
    const draft = await service.create({
      actorId: owners[0]!,
      name: "Rollback Pearl",
      slug: `rollback-pearl-${randomUUID().slice(0, 8)}`,
      visibility: "public",
      content: { instructions: "Atomic publish", knowledgeFiles: [], dependencies: [{ targetArtifactId: randomUUID(), declaredRange: "^2.1.0" }] },
    });

    await expect(service.publish({ actorId: owners[0]!, draftId: draft.id, revision: 1 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await artifacts.findByOwnerAndSlug(owners[0]!, draft.slug)).toBeNull();
    expect(await pool!.query(
      "SELECT count(*)::int AS count FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.slug=$1",
      [draft.slug],
    )).toMatchObject({ rows: [{ count: 0 }] });
    expect((await drafts.findById(draft.id))?.state).toBe("active");

    const corrected = await service.update({
      actorId: owners[0]!, draftId: draft.id, revision: 1, name: draft.name, slug: draft.slug,
      visibility: "public",
      content: { ...draft.content, dependencies: [{ targetArtifactId: target.id, declaredRange: "^2.1.0" }] },
    });
    const published = await service.publish({ actorId: owners[0]!, draftId: draft.id, revision: corrected.revision });
    expect(published.version.version).toBe("0.1.0");
    expect(await dependencies.findForVersion(published.version.id)).toHaveLength(1);
    const copy = await service.createWorkCopy({ actorId: owners[0]!, artifactId: published.artifact.id, version: "0.1.0" });
    expect(copy.baseVersionId).toBe(published.version.id);
    await expect(service.createWorkCopy({ actorId: owners[0]!, artifactId: published.artifact.id, version: "0.1.0" })).rejects.toMatchObject({ code: "DRAFT_ALREADY_ACTIVE" });
  });

  it("discovers with literal search, AND tags, stable cursors, and authorization-safe visibility", async () => {
    const transactions = new PostgresTransactionManager(pool!);
    const artifacts = new PostgresArtifactRepository(transactions.database);
    const versions = new PostgresArtifactVersionRepository(transactions.database);
    const discovery = new PostgresArtifactDiscoveryRepository(transactions.database);
    const contentStore = new MemoryArtifactContentStore();
    const access = { canRead: async () => true, canWrite: async () => true };
    const publish = new PublishVersionService(
      artifacts,
      versions,
      contentStore,
      new PostgresDependencyRepository(transactions.database),
      access,
      discovery,
      transactions,
      { next: randomUUID },
      { now: () => new Date("2026-06-01T00:00:00.000Z") },
    );
    const create = async (ownerId: string, name: string, visibility: "private" | "unlisted" | "public", tags: string[]) => {
      const artifact = Artifact.create({
        id: randomUUID(),
        ownerId,
        name,
        slug: randomUUID(),
        visibility,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      });
      await artifacts.create(artifact);
      await publish.execute({ actorId: ownerId, artifactId: artifact.id, version: "1.0.0", content: { tags } });
      return artifact;
    };
    const publicLiteral = await create(owners[0]!, "Discovery Literal 100%", "public", ["obsolete"]);
    await publish.execute({
      actorId: owners[0]!,
      artifactId: publicLiteral.id,
      version: "10.0.0",
      content: { tags: [" RAG ", "language-model"] },
    });
    const publicSecond = await create(owners[0]!, "Discovery Second", "public", ["rag"]);
    const ownerPrivate = await create(owners[0]!, "Discovery Owner Private", "private", ["rag", "language-model"]);
    const otherPrivate = await create(owners[1]!, "Discovery Other Private", "private", ["rag", "language-model"]);
    const ownerUnlisted = await create(owners[0]!, "Discovery Owner Unlisted", "unlisted", ["rag"]);
    const tombstone = await create(owners[0]!, "Discovery Tombstone", "public", ["rag"]);
    await new DeleteArtifactService(artifacts, access, { now: () => new Date("2026-06-02T00:00:00.000Z") }, transactions)
      .execute({ actorId: owners[0]!, artifactId: tombstone.id });

    const runtime = await createPostgresRuntime({
      databaseUrl,
      pool,
      authenticator: new DevelopmentOnlyFakeAuthenticator(owners[0]!, "discovery-integration-token"),
      contentStore,
    });
    try {
      const anonymousHeaders = { "content-type": "text/plain" };
      const literal = await runtime.app.request("/api/v1/artifacts?q=%25", { headers: anonymousHeaders });
      expect(literal.status).toBe(200);
      const literalBody = await literal.json() as { items: Array<{ id: string; ownerId?: string }> };
      expect(literalBody.items.map((item) => item.id)).toEqual([publicLiteral.id]);
      expect(literalBody.items[0]).not.toHaveProperty("ownerId");

      const tagMatch = await runtime.app.request("/api/v1/artifacts?tag=rag&tag=language-model", { headers: anonymousHeaders });
      expect((await tagMatch.json()).items.map((item: { id: string }) => item.id)).toEqual([publicLiteral.id]);
      const staleTagMatch = await runtime.app.request("/api/v1/artifacts?tag=obsolete", { headers: anonymousHeaders });
      expect((await staleTagMatch.json()).items).toEqual([]);

      const nameSorted = await runtime.app.request("/api/v1/artifacts?q=Discovery&visibility=public&sort=name&order=asc&limit=10");
      expect((await nameSorted.json()).items.map((item: { name: string }) => item.name))
        .toEqual(["Discovery Literal 100%", "Discovery Second"]);
      const updatedSorted = await runtime.app.request("/api/v1/artifacts?q=Discovery&visibility=public&sort=updatedAt&order=desc&limit=10");
      const updatedIds = (await updatedSorted.json()).items.map((item: { id: string }) => item.id);
      expect(updatedIds).toEqual([publicLiteral.id, publicSecond.id].sort().reverse());

      const firstPage = await runtime.app.request("/api/v1/artifacts?q=Discovery&visibility=public&sort=createdAt&order=asc&limit=1");
      expect(firstPage.status).toBe(200);
      const first = await firstPage.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toBeTruthy();
      const nextUrl = new URL("/api/v1/artifacts?q=Discovery&visibility=public&sort=createdAt&order=asc&limit=1", "http://localhost");
      nextUrl.searchParams.set("cursor", first.nextCursor!);
      const secondPage = await runtime.app.request(`${nextUrl.pathname}${nextUrl.search}`);
      const second = await secondPage.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
      expect(second.nextCursor).toBeNull();
      expect(new Set([first.items[0]!.id, second.items[0]!.id])).toEqual(new Set([publicLiteral.id, publicSecond.id]));

      const ownerPrivatePage = await runtime.app.request("/api/v1/artifacts?visibility=private", {
        headers: { authorization: "Bearer discovery-integration-token" },
      });
      expect((await ownerPrivatePage.json()).items.map((item: { id: string }) => item.id)).toEqual([ownerPrivate.id]);
      const ownerUnlistedPage = await runtime.app.request("/api/v1/artifacts?visibility=unlisted", {
        headers: { authorization: "Bearer discovery-integration-token" },
      });
      expect((await ownerUnlistedPage.json()).items.map((item: { id: string }) => item.id)).toEqual([ownerUnlisted.id]);
      const anonymousPrivatePage = await runtime.app.request("/api/v1/artifacts?visibility=private");
      expect((await anonymousPrivatePage.json()).items).toEqual([]);
      const ownerDefaultPage = await runtime.app.request("/api/v1/artifacts?sort=name&order=asc", {
        headers: { authorization: "Bearer discovery-integration-token" },
      });
      const ownerDefaultIds = (await ownerDefaultPage.json()).items.map((item: { id: string }) => item.id);
      expect(ownerDefaultIds).toContain(ownerPrivate.id);
      expect(ownerDefaultIds).not.toContain(ownerUnlisted.id);
      expect(ownerDefaultIds).not.toContain(otherPrivate.id);
      expect(ownerDefaultIds).not.toContain(tombstone.id);
    } finally {
      await runtime.close();
    }
  });

  it("matches the frozen table, column, constraint, trigger, and index inventory", async () => {
    const tables = await pool!.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "artifact_discovery_index", "artifact_discovery_index_state",
      "artifact_lineage", "artifact_versions", "artifacts", "compatibility_reports",
      "dependencies", "dependency_resolutions", "drafts", "provenances", "schema_migrations",
      "tombstone_snapshots", "user_identities", "users",
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
      artifact_versions: ["id", "artifact_id", "version", "content_hash", "content_location", "content_snapshot", "created_at", "published_at"],
      drafts: ["id", "owner_id", "artifact_id", "base_version_id", "fork_source_artifact_id", "fork_source_version_id", "provenance", "name", "slug", "visibility", "content", "state", "revision", "created_at", "updated_at"],
      artifact_discovery_index: ["artifact_id", "artifact_version_id", "tags"],
      artifact_discovery_index_state: ["singleton", "ready"],
      artifact_lineage: ["id", "parent_artifact_id", "child_artifact_id", "source_version_id", "relationship_type", "created_at"],
      provenances: ["id", "artifact_version_id", "source_type", "source_url", "source_ref", "imported_at"],
      dependencies: ["id", "artifact_version_id", "target_artifact_id", "declared_range", "created_at"],
      dependency_resolutions: ["id", "dependency_id", "resolved_artifact_version_id", "resolved_at", "target_artifact_id"],
      compatibility_reports: ["id", "artifact_version_id", "target_artifact_version_id", "status", "report", "created_at"],
      tombstone_snapshots: ["id", "artifact_id", "snapshot_number", "snapshot", "created_at"],
      user_identities: ["id", "user_id", "provider", "subject", "created_at"],
      schema_migrations: ["version", "checksum", "applied_at"],
    };
    expect(Object.keys(actualColumns).sort()).toEqual(Object.keys(expectedColumns).sort());
    for (const [tableName, expected] of Object.entries(expectedColumns)) {
      expect(actualColumns[tableName]?.sort()).toEqual(expected.sort());
    }

    const constraints = await pool!.query<{ conname: string; contype: string }>(
      "SELECT conname,contype FROM pg_constraint JOIN pg_class ON pg_class.oid=conrelid JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace WHERE nspname=current_schema() ORDER BY conname",
    );
    const expectedConstraints: [string, string][] = [
      ["artifact_versions_content_snapshot_object", "c"],
      ["artifact_discovery_index_artifact_id_fkey", "f"],
      ["artifact_discovery_index_artifact_version_id_artifact_id_fkey", "f"],
      ["artifact_discovery_index_pkey", "p"],
      ["artifact_discovery_index_tags_count_check", "c"],
      ["artifact_discovery_index_tags_no_null_check", "c"],
      ["artifact_discovery_index_state_pkey", "p"],
      ["artifact_discovery_index_state_singleton_check", "c"],
      ["artifact_lineage_child_artifact_id_fkey", "f"],
      ["artifact_lineage_check", "c"],
      ["artifact_lineage_parent_artifact_id_child_artifact_id_relat_key", "u"],
      ["artifact_lineage_parent_artifact_id_fkey", "f"],
      ["artifact_lineage_pkey", "p"],
      ["artifact_lineage_relationship_type_check", "c"],
      ["artifact_lineage_source_version_parent_fkey", "f"],
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
      ["drafts_artifact_id_fkey", "f"],
      ["drafts_base_version_artifact_fkey", "f"],
      ["drafts_check", "c"],
      ["drafts_content_check", "c"],
      ["drafts_fork_source_pair", "c"],
      ["drafts_fork_source_version_fkey", "f"],
      ["drafts_name_check", "c"],
      ["drafts_owner_id_fkey", "f"],
      ["drafts_pkey", "p"],
      ["drafts_provenance_object", "c"],
      ["drafts_revision_check", "c"],
      ["drafts_slug_check", "c"],
      ["drafts_state_check", "c"],
      ["drafts_visibility_check", "c"],
      ["dependency_resolutions_dependency_id_fkey", "f"],
      ["dependency_resolutions_dependency_target_fkey", "f"],
      ["dependency_resolutions_pkey", "p"],
      ["dependency_resolutions_resolved_artifact_version_id_fkey", "f"],
      ["dependency_resolutions_version_target_fkey", "f"],
      ["provenances_artifact_version_id_fkey", "f"],
      ["provenances_pkey", "p"],
      ["schema_migrations_pkey", "p"],
      ["users_external_subject_key", "u"],
      ["users_pkey", "p"],
      ["user_identities_pkey", "p"],
      ["user_identities_provider_check", "c"],
      ["user_identities_provider_subject_key", "u"],
      ["user_identities_subject_check", "c"],
      ["user_identities_user_id_fkey", "f"],
      ["tombstone_snapshots_artifact_id_fkey", "f"],
      ["tombstone_snapshots_artifact_id_snapshot_number_key", "u"],
      ["tombstone_snapshots_pkey", "p"],
      ["tombstone_snapshots_snapshot_number_check", "c"],
    ];
    const actualConstraintInventory = constraints.rows.map((row) => `${row.conname}:${row.contype}`).sort();
    expect(actualConstraintInventory).toEqual(expectedConstraints.map(([name, type]) => `${name}:${type}`).sort());

    const triggers = await pool!.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger JOIN pg_class ON pg_class.oid=tgrelid JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace WHERE nspname=current_schema() AND NOT tgisinternal ORDER BY tgname",
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "artifact_versions_immutable", "artifacts_identity_immutable", "artifacts_no_physical_delete", "dependency_resolutions_set_target",
      "tombstone_snapshots_no_truncate", "tombstone_snapshots_no_update_or_delete",
    ]);

    const indexes = await pool!.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() ORDER BY indexname",
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "schema_migrations_pkey",
      "artifacts_owner_idx", "artifacts_visibility_status_idx", "artifact_versions_artifact_idx",
      "artifact_discovery_tags_gin_idx", "artifacts_discovery_name_trgm_idx",
      "artifacts_discovery_slug_trgm_idx", "artifacts_discovery_created_idx",
      "artifacts_discovery_updated_idx", "artifacts_discovery_name_idx",
      "artifact_lineage_parent_idx", "artifact_lineage_child_idx", "provenances_version_idx",
      "dependencies_source_idx", "dependencies_target_idx", "dependency_resolutions_dependency_idx",
      "compatibility_reports_source_idx", "compatibility_reports_target_idx",
      "user_identities_user_idx", "tombstone_snapshots_artifact_idx",
      "drafts_owner_state_idx", "drafts_one_active_per_artifact_idx",
    ]));
  });

  it("maps provider-subject identities without guessing legacy providers", async () => {
    const identities = new PostgresUserIdentityRepository(pool!);
    const legacy = await pool!.query<{ id: string; external_subject: string }>(
      "SELECT id,external_subject FROM users WHERE id=$1",
      [owners[0]],
    );
    expect(legacy.rows[0]).toEqual({ id: owners[0], external_subject: "owner-a" });
    expect(await identities.findUserId("firebase", "owner-a")).toBeNull();

    const userWithTwoProviders = randomUUID();
    const otherUser = randomUUID();
    await pool!.query("INSERT INTO users (id) VALUES ($1),($2)", [userWithTwoProviders, otherUser]);
    const createdAt = new Date("2026-05-01T00:00:00Z");
    await identities.create({ id: randomUUID(), userId: userWithTwoProviders, provider: "firebase", subject: "same-subject", createdAt });
    await identities.create({ id: randomUUID(), userId: userWithTwoProviders, provider: "oidc-example", subject: "same-subject", createdAt });
    await identities.create({ id: randomUUID(), userId: otherUser, provider: "firebase", subject: "other-subject", createdAt });
    expect(await identities.findUserId("firebase", "same-subject")).toBe(userWithTwoProviders);
    expect(await identities.findUserId("oidc-example", "same-subject")).toBe(userWithTwoProviders);
    expect(await identities.findUserId("firebase", "other-subject")).toBe(otherUser);
    await expect(identities.create({ id: randomUUID(), userId: otherUser, provider: "firebase", subject: "same-subject", createdAt }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST", details: {} });
  });

  async function createArtifact(ownerId: string = owners[0]!, slug: string = randomUUID(), visibility: string = "public", status: string = "active"): Promise<string> {
    const id = randomUUID();
    await pool!.query("INSERT INTO artifacts (id,owner_id,name,slug,visibility,status) VALUES ($1,$2,$3,$4,$5,$6)", [id, ownerId, `Artifact ${id}`, slug, visibility, status]);
    return id;
  }

  async function createVersion(artifactId: string, version = "1.0.0", contentHash: string = randomUUID(), contentSnapshot: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await pool!.query("INSERT INTO artifact_versions (id,artifact_id,version,content_hash,content_location,content_snapshot,published_at) VALUES ($1,$2,$3,$4,'loc',$5,now())", [id, artifactId, version, contentHash, contentSnapshot]);
    return id;
  }

  it("maps Artifact rows, updates only mutable state, and translates identity and slug constraints", async () => {
    const artifacts = new PostgresArtifactRepository(pool!);
    const createdAt = new Date("2026-02-03T04:05:06.000Z");
    const artifact = Artifact.create({ id: randomUUID(), ownerId: owners[0]!, name: "Repository mapping", slug: randomUUID(), visibility: "public", createdAt });
    await artifacts.create(artifact);

    expect((await artifacts.findById(artifact.id))?.snapshot()).toEqual(artifact.snapshot());
    expect((await artifacts.findByIds([artifact.id, randomUUID()])).map((item) => item.id)).toEqual([artifact.id]);
    expect(await artifacts.findByIds([])).toEqual([]);
    expect((await artifacts.findByOwnerAndSlug(artifact.ownerId, artifact.slug))?.id).toBe(artifact.id);
    expect(await artifacts.findById(randomUUID())).toBeNull();
    expect(await artifacts.findByOwnerAndSlug(artifact.ownerId, randomUUID())).toBeNull();

    const changed = artifact.changeVisibility("private", new Date("2026-02-04T04:05:06.000Z"));
    await artifacts.save(changed);
    expect((await artifacts.findById(artifact.id))?.snapshot()).toEqual(changed.snapshot());

    const duplicateSlug = Artifact.create({ id: randomUUID(), ownerId: artifact.ownerId, name: "Duplicate", slug: artifact.slug, visibility: "private", createdAt });
    await expect(artifacts.create(duplicateSlug)).rejects.toMatchObject({ code: "ARTIFACT_SLUG_CONFLICT", details: {} });
    const invalidTombstone = Artifact.reconstitute({ ...artifact.snapshot(), id: randomUUID(), slug: randomUUID(), status: "tombstone", visibility: "public" });
    await expect(artifacts.create(invalidTombstone)).rejects.toMatchObject({ code: "INVALID_REQUEST", details: {} });
    const immutableTriggerProbe = new PostgresArtifactRepository({
      query: () => pool!.query("UPDATE artifacts SET name='Changed' WHERE id=$1", [artifact.id]),
    } as never);
    await expect(immutableTriggerProbe.findById(artifact.id)).rejects.toMatchObject({ code: "ARTIFACT_NAME_IMMUTABLE", details: {} });
    const unexpectedError = Object.assign(new Error("connection interrupted"), { code: "08006" });
    const unexpectedErrorProbe = new PostgresArtifactRepository({ query: async () => { throw unexpectedError; } } as never);
    await expect(unexpectedErrorProbe.findById(artifact.id)).rejects.toBe(unexpectedError);

    for (const identityChange of [
      { name: "Changed name" },
      { slug: "changed-slug" },
      { ownerId: owners[1]! },
    ]) {
      await artifacts.save(Artifact.reconstitute({ ...changed.snapshot(), ...identityChange }));
      expect((await artifacts.findById(artifact.id))?.snapshot()).toMatchObject({
        id: artifact.id,
        ownerId: artifact.ownerId,
        name: artifact.name,
        slug: artifact.slug,
      });
    }
  });

  it("maps immutable Versions and selects latest with SemVer rather than lexical ordering", async () => {
    const artifacts = new PostgresArtifactVersionRepository(pool!);
    const artifactId = await createArtifact();
    const createdAt = new Date("2026-03-01T00:00:00.000Z");
    const versions = ["2.0.0", "10.0.0", "2.0.0+build.1", "2.0.0+build.2"];
    for (const [index, version] of versions.entries()) {
      await artifacts.create(ArtifactVersion.create({ id: randomUUID(), artifactId, version, contentHash: randomUUID(), contentLocation: `content/${version}`, createdAt: new Date(createdAt.getTime() + index), publishedAt: createdAt }));
    }

    const stored = await artifacts.findForArtifact(artifactId);
    expect(stored.map((version) => version.version)).toEqual(versions);
    expect((await artifacts.findById(stored[0]!.id))?.snapshot()).toEqual(stored[0]!.snapshot());
    expect((await artifacts.findByArtifactAndVersion(artifactId, "10.0.0"))?.version).toBe("10.0.0");
    expect(await artifacts.findById(randomUUID())).toBeNull();
    expect(await artifacts.findByArtifactAndVersion(artifactId, "9.0.0")).toBeNull();
    expect(await artifacts.findForArtifact(randomUUID())).toEqual([]);
    expect((await artifacts.findLatest(artifactId))?.version).toBe("10.0.0");
    expect(await artifacts.findLatest(randomUUID())).toBeNull();

    await expect(artifacts.create(ArtifactVersion.create({ id: randomUUID(), artifactId, version: "10.0.0", contentHash: randomUUID(), contentLocation: "content/duplicate", createdAt, publishedAt: createdAt }))).rejects.toMatchObject({ code: "VERSION_ALREADY_EXISTS", details: {} });
    const immutableTriggerProbe = new PostgresArtifactVersionRepository({
      query: () => pool!.query("UPDATE artifact_versions SET version='11.0.0' WHERE id=$1", [stored[0]!.id]),
    } as never);
    await expect(immutableTriggerProbe.findById(stored[0]!.id)).rejects.toMatchObject({ code: "VERSION_IMMUTABLE", details: {} });
  });

  it("persists lineage, provenance, dependencies, and compatibility reports with stable empty and ordered reads", async () => {
    const artifactA = await createArtifact();
    const artifactB = await createArtifact();
    const artifactC = await createArtifact();
    const artifactD = await createArtifact();
    const sourceVersionId = await createVersion(artifactA);
    const targetVersionId = await createVersion(artifactB, "2.0.0");
    const lineage = new PostgresLineageRepository(pool!);
    const provenances = new PostgresProvenanceRepository(pool!);
    const dependencies = new PostgresDependencyRepository(pool!);
    const reports = new PostgresCompatibilityReportRepository(pool!);

    expect(await lineage.getParents(artifactA)).toEqual([]);
    expect(await lineage.getChildren(artifactA)).toEqual([]);
    expect(await provenances.findForVersion(sourceVersionId)).toEqual([]);
    expect(await dependencies.findForVersion(sourceVersionId)).toEqual([]);
    expect(await dependencies.findResolutions(randomUUID())).toEqual([]);
    expect(await reports.findForArtifactVersion(sourceVersionId)).toEqual([]);

    const firstFork = await lineage.createFork(artifactA, artifactB);
    expect(firstFork).toMatchObject({ parentArtifactId: artifactA, childArtifactId: artifactB, relationshipType: "fork" });
    const secondFork = await lineage.createFork(artifactA, artifactC);
    const thirdFork = await lineage.createFork(artifactD, artifactB);
    await pool!.query(
      "UPDATE artifact_lineage SET created_at=CASE id WHEN $1 THEN $4::timestamptz WHEN $2 THEN $5::timestamptz WHEN $3 THEN $6::timestamptz END WHERE id=ANY($7::uuid[])",
      [firstFork.id, secondFork.id, thirdFork.id, new Date("2026-01-03T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"), [firstFork.id, secondFork.id, thirdFork.id]],
    );
    await expect(lineage.createFork(artifactA, artifactB)).rejects.toMatchObject({ code: "LINEAGE_INVALID", details: {} });
    const expectDateOrder = (records: Array<{ id: string; date: Date }>) => {
      expect(records.map((record) => record.id)).toEqual([...records].sort((left, right) => left.date.getTime() - right.date.getTime() || left.id.localeCompare(right.id)).map((record) => record.id));
    };
    const parents = await lineage.getParents(artifactB);
    const children = await lineage.getChildren(artifactA);
    expect(parents.map((record) => record.id)).toEqual([thirdFork.id, firstFork.id]);
    expect(children.map((record) => record.id)).toEqual([secondFork.id, firstFork.id]);
    expectDateOrder(parents.map(({ id, createdAt }) => ({ id, date: createdAt })));
    expectDateOrder(children.map(({ id, createdAt }) => ({ id, date: createdAt })));

    const provenance: Provenance = { id: randomUUID(), artifactVersionId: sourceVersionId, sourceType: "github", sourceUrl: "https://example.test/repo", sourceRef: "refs/tags/v1.0.0", importedAt: new Date("2026-04-01T00:00:00.000Z") };
    const secondProvenance: Provenance = { ...provenance, id: randomUUID(), sourceRef: "refs/tags/v1.0.1", importedAt: new Date("2026-04-01T00:00:01.000Z") };
    await provenances.create(provenance);
    await provenances.create(secondProvenance);
    const provenanceRows = await provenances.findForVersion(sourceVersionId);
    expect(provenanceRows).toEqual([provenance, secondProvenance]);
    expectDateOrder(provenanceRows.map(({ id, importedAt }) => ({ id, date: importedAt })));

    const dependency = Dependency.create({ id: randomUUID(), artifactVersionId: sourceVersionId, targetArtifactId: artifactB, declaredRange: "^2.0.0", createdAt: new Date("2026-04-02T00:00:00.000Z") });
    const secondDependency = Dependency.create({ id: randomUUID(), artifactVersionId: sourceVersionId, targetArtifactId: artifactB, declaredRange: ">=2.0.0 <3.0.0", createdAt: new Date("2026-04-02T00:00:01.000Z") });
    await dependencies.create(dependency);
    await dependencies.create(secondDependency);
    const dependencyRows = await dependencies.findForVersion(sourceVersionId);
    expect(dependencyRows.map((row) => row.snapshot())).toEqual([dependency.snapshot(), secondDependency.snapshot()]);
    expectDateOrder(dependencyRows.map((row) => ({ id: row.id, date: row.createdAt })));
    const resolutionAt = new Date("2026-04-03T00:00:00.000Z");
    const firstResolution = { id: randomUUID(), dependencyId: dependency.id, resolvedArtifactVersionId: targetVersionId, resolvedAt: resolutionAt };
    const secondResolution = { ...firstResolution, id: randomUUID(), resolvedAt: new Date(resolutionAt.getTime() + 1000) };
    await dependencies.createResolution(firstResolution);
    await dependencies.createResolution(secondResolution);
    const resolutionRows = await dependencies.findResolutions(dependency.id);
    expect(resolutionRows).toEqual([firstResolution, secondResolution]);
    expectDateOrder(resolutionRows.map(({ id, resolvedAt }) => ({ id, date: resolvedAt })));
    await expect(dependencies.createResolution({ id: randomUUID(), dependencyId: dependency.id, resolvedArtifactVersionId: sourceVersionId, resolvedAt: resolutionAt })).rejects.toMatchObject({ code: "INVALID_REQUEST", details: {} });

    const report: CompatibilityReport = { id: randomUUID(), artifactVersionId: sourceVersionId, targetArtifactVersionId: null, status: "compatible", report: { summary: "ok", score: 0.875, enabled: true, checks: [{ name: "schema", passed: true, metadata: { threshold: 2, labels: ["required", "stable"], nested: { active: false } } }] }, createdAt: new Date("2026-04-04T00:00:00.000Z") };
    const secondReport: CompatibilityReport = { ...report, id: randomUUID(), targetArtifactVersionId: targetVersionId, status: "incompatible", report: { summary: "breaking", breakingChanges: ["field removed"] }, createdAt: new Date("2026-04-04T00:00:01.000Z") };
    const emptyReport: CompatibilityReport = { ...report, id: randomUUID(), report: {}, createdAt: new Date("2026-04-04T00:00:02.000Z") };
    await reports.create(report);
    await reports.create(secondReport);
    await reports.create(emptyReport);
    const reportRows = await reports.findForArtifactVersion(sourceVersionId);
    expect(reportRows).toEqual([report, secondReport, emptyReport]);
    expectDateOrder(reportRows.map(({ id, createdAt }) => ({ id, date: createdAt })));
  });

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

  it("persists immutable complete lifecycle snapshots and restores the same Artifact identity", async () => {
    const artifactSlug = randomUUID();
    const artifactId = await createArtifact(owners[0], artifactSlug, "public");
    const childId = await createArtifact(owners[1]);
    const targetId = await createArtifact(owners[2]);
    const parentId = await createArtifact(owners[2]);
    const sourceVersionId = await createVersion(artifactId, "1.0.0", "sha256:source");
    const targetVersionId = await createVersion(targetId, "2.1.0", "sha256:target");
    const parentVersionId = await createVersion(parentId, "1.0.0", "sha256:parent");
    const dependencyId = randomUUID();
    const resolutionId = randomUUID();
    const lineage = new PostgresLineageRepository(pool!);
    await pool!.query(
      "INSERT INTO dependencies (id,artifact_version_id,target_artifact_id,declared_range) VALUES ($1,$2,$3,$4)",
      [dependencyId, sourceVersionId, targetId, "^2.1.0"],
    );
    await pool!.query(
      "INSERT INTO dependency_resolutions (id,dependency_id,resolved_artifact_version_id) VALUES ($1,$2,$3)",
      [resolutionId, dependencyId, targetVersionId],
    );
    await pool!.query(
      "INSERT INTO provenances (id,artifact_version_id,source_type,source_url,source_ref) VALUES ($1,$2,'github','https://example.test/repo','main')",
      [randomUUID(), sourceVersionId],
    );
    await pool!.query(
      "INSERT INTO compatibility_reports (id,artifact_version_id,status,report) VALUES ($1,$2,'compatible','{\"ok\":true}')",
      [randomUUID(), sourceVersionId],
    );
    await lineage.createFork(parentId, artifactId, parentVersionId);
    await lineage.createFork(artifactId, childId, sourceVersionId);

    const artifacts = new PostgresArtifactRepository(pool!);
    const access = { canRead: async () => true, canWrite: async () => true };
    const fixedTime = new Date("2026-06-01T00:00:00Z");
    const remove = new DeleteArtifactService(artifacts, access, { now: () => fixedTime });
    const tombstoned = await remove.execute({ actorId: owners[0]!, artifactId });
    const snapshotResult = await pool!.query<{ snapshot_number: number; snapshot: Record<string, any> }>(
      "SELECT snapshot_number,snapshot FROM tombstone_snapshots WHERE artifact_id=$1",
      [artifactId],
    );
    expect(snapshotResult.rows).toHaveLength(1);
    const snapshot = snapshotResult.rows[0]!.snapshot;
    expect(snapshot.format_version).toBe(1);
    expect(snapshot.artifact).toMatchObject({ id: artifactId, owner_id: owners[0], visibility: "public", status: "active" });
    expect(snapshot.versions).toHaveLength(1);
    expect(snapshot.versions[0]).toMatchObject({ id: sourceVersionId, content_hash: "sha256:source", content_location: "loc" });
    expect(snapshot.dependencies).toHaveLength(1);
    expect(snapshot.dependencies[0]).toMatchObject({ id: dependencyId, declared_range: "^2.1.0" });
    expect(snapshot.dependencies[0].resolutions).toMatchObject([{ id: resolutionId, resolved_artifact_version_id: targetVersionId }]);
    expect(snapshot.provenances).toHaveLength(1);
    expect(snapshot.compatibility_reports).toHaveLength(1);
    expect(snapshot.lineage).toEqual(expect.arrayContaining([
      expect.objectContaining({ parent_artifact_id: parentId, child_artifact_id: artifactId, source_version_id: parentVersionId }),
      expect.objectContaining({ parent_artifact_id: artifactId, child_artifact_id: childId, source_version_id: sourceVersionId }),
    ]));
    expect(tombstoned.snapshot()).toMatchObject({ id: artifactId, status: "tombstone", visibility: "unlisted" });

    await expect(pool!.query("UPDATE tombstone_snapshots SET snapshot='{}' WHERE artifact_id=$1", [artifactId]))
      .rejects.toMatchObject({ code: "55000", constraint: "tombstone_snapshots_immutable" });
    await expect(pool!.query("DELETE FROM tombstone_snapshots WHERE artifact_id=$1", [artifactId]))
      .rejects.toMatchObject({ code: "55000", constraint: "tombstone_snapshots_immutable" });
    await expect(pool!.query("TRUNCATE tombstone_snapshots"))
      .rejects.toMatchObject({ code: "55000", constraint: "tombstone_snapshots_immutable" });
    await expect(remove.execute({ actorId: owners[0]!, artifactId }))
      .rejects.toMatchObject({ code: "ARTIFACT_GONE" });
    expect((await pool!.query("SELECT snapshot_number,snapshot FROM tombstone_snapshots WHERE artifact_id=$1", [artifactId])).rows)
      .toEqual([{ snapshot_number: 1, snapshot }]);

    const restoreService = new RestoreArtifactService(artifacts, { canRestore: async () => false });
    await expect(restoreService.execute({ actorId: owners[0]!, artifactId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const restored = await new RestoreArtifactService(
      artifacts,
      { canRestore: async () => true },
      { now: () => new Date("2026-06-02T00:00:00Z") },
    ).execute({ actorId: "admin", artifactId });
    expect(restored.snapshot()).toMatchObject({
      id: artifactId,
      ownerId: owners[0],
      name: `Artifact ${artifactId}`,
      slug: artifactSlug,
      visibility: "public",
      status: "active",
    });
    expect(await artifacts.findTombstoneSnapshotArtifact(artifactId)).toMatchObject({ id: artifactId, visibility: "public", status: "active" });
    expect(await lineage.getChildren(artifactId)).toMatchObject([{ sourceVersionId, childArtifactId: childId }]);
    expect(await lineage.getParents(artifactId)).toMatchObject([{
      parentArtifactId: parentId,
      childArtifactId: artifactId,
      sourceVersionId: parentVersionId,
    }]);
    expect(await new PostgresArtifactVersionRepository(pool!).findForArtifact(artifactId)).toHaveLength(1);

    await remove.execute({ actorId: owners[0]!, artifactId });
    expect((await pool!.query("SELECT snapshot_number FROM tombstone_snapshots WHERE artifact_id=$1 ORDER BY snapshot_number", [artifactId])).rows)
      .toEqual([{ snapshot_number: 1 }, { snapshot_number: 2 }]);
  });

  it("rolls back snapshot creation and tombstoning together if snapshot persistence fails", async () => {
    const artifactId = await createArtifact();
    const artifacts = new PostgresArtifactRepository(pool!);
    await pool!.query(`
      CREATE FUNCTION reject_test_artifact_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced snapshot failure'; END;
      $$;
      CREATE TRIGGER reject_test_artifact_tombstone
      BEFORE UPDATE ON artifacts FOR EACH ROW
      WHEN (NEW.status = 'tombstone')
      EXECUTE FUNCTION reject_test_artifact_tombstone();
    `);
    try {
      await expect(new DeleteArtifactService(artifacts, { canRead: async () => true, canWrite: async () => true })
        .execute({ actorId: owners[0]!, artifactId })).rejects.toThrow("forced snapshot failure");
    } finally {
      await pool!.query("DROP TRIGGER reject_test_artifact_tombstone ON artifacts");
      await pool!.query("DROP FUNCTION reject_test_artifact_tombstone()");
    }
    expect((await artifacts.findById(artifactId))?.status).toBe("active");
    expect((await pool!.query("SELECT count(*)::int AS count FROM tombstone_snapshots WHERE artifact_id=$1", [artifactId])).rows[0]?.count).toBe(0);
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

  it("publishes Fork and Import Drafts with permanent relationships and preserves them after tombstoning", async () => {
    const sourceId = await createArtifact();
    const sourceVersionId = await createVersion(sourceId, "1.0.0", randomUUID(), {
      instructions: "Source instructions",
      tags: ["rag"],
      knowledgeFiles: [{ path: "guide.md", content: "Source knowledge", contentHash: "sha256:abc" }],
      dependencies: [],
    });
    const transactions = new PostgresTransactionManager(pool!);
    const artifacts = new PostgresArtifactRepository(transactions.database);
    const versions = new PostgresArtifactVersionRepository(transactions.database);
    const discovery = new PostgresArtifactDiscoveryRepository(transactions.database);
    const dependencies = new PostgresDependencyRepository(transactions.database);
    const lineage = new PostgresLineageRepository(transactions.database);
    const provenance = new PostgresProvenanceRepository(transactions.database);
    const access = { canRead: async () => true, canWrite: async () => true };
    const contentStore = { put: async () => "loc", get: async () => "{}", exists: async () => true };
    const clone = await new CloneArtifactService(artifacts, versions, contentStore, dependencies, access, discovery, transactions).execute({ actorId: owners[0]!, sourceArtifactId: sourceId, name: "Clone", slug: randomUUID() });
    expect(await lineage.getParents(clone.id)).toEqual([]);
    const workflow = new DraftWorkflowService(new PostgresDraftRepository(transactions.database), artifacts, versions, dependencies, access, discovery, transactions, undefined, undefined, lineage, provenance);
    const forkDraft = await workflow.createFork({
      actorId: owners[0]!, sourceArtifactId: sourceId, sourceVersion: "1.0.0",
      name: "Fork", slug: randomUUID(), visibility: "private",
    });
    expect(await artifacts.findByOwnerAndSlug(owners[0]!, forkDraft.slug)).toBeNull();
    expect(forkDraft.forkOrigin).toEqual({ artifactId: sourceId, versionId: sourceVersionId });
    const fork = await workflow.publish({ actorId: owners[0]!, draftId: forkDraft.id, revision: 1 });
    expect(fork.version.version).toBe("0.1.0");
    expect((await lineage.getParents(fork.artifact.id)).map((item) => item.parentArtifactId)).toEqual([sourceId]);
    await expect(lineage.createFork(sourceId, fork.artifact.id)).rejects.toMatchObject({ code: "LINEAGE_INVALID" });
    await expect(lineage.createFork(sourceId, sourceId)).rejects.toMatchObject({ code: "LINEAGE_INVALID" });
    const importer = new ImportDraftService({ fetch: async () => ({ content: "# Imported\n\nText", ref: "main" }) }, workflow);
    const importDraft = await importer.execute({
      actorId: owners[0]!, sourceType: "github", sourceUrl: "https://raw.githubusercontent.com/acme/test/main/SKILL.md",
      name: "Imported", slug: randomUUID(), visibility: "private",
    });
    const imported = await workflow.publish({ actorId: owners[0]!, draftId: importDraft.id, revision: 1 });
    expect(imported.version.version).toBe("0.1.0");
    expect((await provenance.findForVersion(imported.version.id)).map((item) => item.sourceUrl)).toEqual([
      "https://raw.githubusercontent.com/acme/test/main/SKILL.md",
    ]);
    expect(await lineage.getParents(imported.artifact.id)).toEqual([]);

    await new DeleteArtifactService(artifacts, access, undefined, transactions).execute({ actorId: owners[0]!, artifactId: sourceId });
    expect(await lineage.getChildren(sourceId)).toHaveLength(1);
    expect((await artifacts.findById(sourceId))?.snapshot()).toMatchObject({ status: "tombstone", visibility: "unlisted" });
    expect(await versions.findForArtifact(sourceId)).toHaveLength(1);
    expect((await pool!.query("SELECT id FROM artifact_lineage WHERE parent_artifact_id=$1", [sourceId])).rows).toHaveLength(1);

    await new DeleteArtifactService(artifacts, access, undefined, transactions).execute({ actorId: owners[0]!, artifactId: imported.artifact.id });
    const tombstone = await pool!.query<{ version_count: number; provenance_count: number }>(
      "SELECT jsonb_array_length(snapshot->'versions') AS version_count,jsonb_array_length(snapshot->'provenances') AS provenance_count FROM tombstone_snapshots WHERE artifact_id=$1",
      [imported.artifact.id],
    );
    expect(tombstone.rows[0]).toEqual({ version_count: 1, provenance_count: 1 });
  });

  it("verifies Fork, both Import modes, and owner-scoped tombstone responses through the HTTP API", async () => {
    const ownerId = owners[0]!;
    const otherOwnerId = owners[1]!;
    const sourceId = await createArtifact(ownerId, randomUUID(), "public");
    const sourceVersionId = await createVersion(sourceId, "2.3.1", `sha256:${"c".repeat(64)}`, {
      instructions: "Selected source version content",
      tags: ["source-tag"],
      knowledgeFiles: [],
      dependencies: [],
    });

    const transactions = new PostgresTransactionManager(pool!);
    const artifacts = new PostgresArtifactRepository(transactions.database);
    const versions = new PostgresArtifactVersionRepository(transactions.database);
    const discovery = new PostgresArtifactDiscoveryRepository(transactions.database);
    const lineage = new PostgresLineageRepository(transactions.database);
    const provenances = new PostgresProvenanceRepository(transactions.database);
    const access = {
      canRead: async (actorId: string, artifact: Artifact) => actorId === artifact.ownerId || artifact.visibility === "public",
      canWrite: async (actorId: string, artifact: Artifact) => actorId === artifact.ownerId,
    };
    const drafts = new DraftWorkflowService(
      new PostgresDraftRepository(transactions.database),
      artifacts,
      versions,
      new PostgresDependencyRepository(transactions.database),
      access,
      discovery,
      transactions,
      undefined,
      undefined,
      lineage,
      provenances,
    );
    const importDraft = new ImportDraftService({
      fetch: async () => ({ content: "# GitHub fixture\n\nFetched by the backend fixture.", ref: "fixture-ref" }),
    }, drafts);
    const deleteArtifact = new DeleteArtifactService(artifacts, access, undefined, transactions);
    const common = {
      listArtifacts: new ListArtifactsService(discovery),
      artifactReads: drafts,
      drafts,
      deleteArtifact,
      importDraft,
    };
    const app = createHttpApp({
      ...common,
      authenticator: new DevelopmentOnlyFakeAuthenticator(ownerId, "owner-token", [
        { userId: otherOwnerId, token: "other-owner-token" },
      ]),
    });
    const ownerApp = app;
    const otherOwnerApp = app;
    const ownerHeaders = { authorization: "Bearer owner-token", "content-type": "application/json" };
    const otherOwnerHeaders = { authorization: "Bearer other-owner-token", "content-type": "application/json" };

    const anonymousReadResponse = await app.request(`/api/v1/artifacts/${sourceId}/versions/2.3.1`);
    expect(anonymousReadResponse.status).toBe(200);
    expect(await anonymousReadResponse.json()).toMatchObject({
      artifact: { id: sourceId, visibility: "public" },
      version: { id: sourceVersionId, version: "2.3.1" },
    });
    const sourceDetailResponse = await app.request(`/api/v1/artifacts/${sourceId}`);
    expect(sourceDetailResponse.status).toBe(200);
    expect(await sourceDetailResponse.json()).toMatchObject({
      id: sourceId,
      ownerId,
      visibility: "public",
      status: "active",
    });
    const unlistedId = await createArtifact(ownerId, randomUUID(), "unlisted");
    const ownerUnlistedDetail = await ownerApp.request(`/api/v1/artifacts/${unlistedId}`, { headers: ownerHeaders });
    expect(ownerUnlistedDetail.status).toBe(200);
    const anonymousUnlistedDetail = await ownerApp.request(`/api/v1/artifacts/${unlistedId}`);
    expect(anonymousUnlistedDetail.status).toBe(404);
    const otherOwnerUnlistedDetail = await otherOwnerApp.request(`/api/v1/artifacts/${unlistedId}`, { headers: otherOwnerHeaders });
    expect(otherOwnerUnlistedDetail.status).toBe(403);
    const sourceLineageBeforePublish = await app.request(`/api/v1/artifacts/${sourceId}/lineage`);
    expect(sourceLineageBeforePublish.status).toBe(200);
    expect(await sourceLineageBeforePublish.json()).toEqual({ parents: [], children: [] });

    const forkDraftResponse = await ownerApp.request(`/api/v1/artifacts/${sourceId}/fork`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        sourceVersion: "2.3.1",
        name: "Forked selected version",
        slug: `fork-${randomUUID()}`,
        visibility: "private",
      }),
    });
    expect(forkDraftResponse.status).toBe(201);
    const forkDraft = await forkDraftResponse.json() as {
      id: string;
      revision: number;
      content: { instructions: string };
      forkOrigin: { artifactId: string; versionId: string } | null;
    };
    expect(forkDraft).toMatchObject({
      content: { instructions: "Selected source version content" },
      forkOrigin: { artifactId: sourceId, versionId: sourceVersionId },
    });
    expect(await lineage.getChildren(sourceId)).toHaveLength(0);

    const forkPublishResponse = await ownerApp.request(`/api/v1/drafts/${forkDraft.id}/publish`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ revision: forkDraft.revision }),
    });
    expect(forkPublishResponse.status).toBe(201);
    const publishedFork = await forkPublishResponse.json() as {
      artifact: { id: string };
      version: { version: string; content: { instructions: string } };
    };
    expect(publishedFork.version).toMatchObject({
      version: "0.1.0",
      content: { instructions: "Selected source version content" },
    });
    expect(await lineage.getParents(publishedFork.artifact.id)).toMatchObject([{
      parentArtifactId: sourceId,
      sourceVersionId,
    }]);
    const ownerChildDetail = await ownerApp.request(`/api/v1/artifacts/${publishedFork.artifact.id}`, { headers: ownerHeaders });
    expect(ownerChildDetail.status).toBe(200);
    expect(await ownerChildDetail.json()).toMatchObject({
      id: publishedFork.artifact.id,
      ownerId,
      visibility: "private",
      status: "active",
    });
    const anonymousChildDetail = await ownerApp.request(`/api/v1/artifacts/${publishedFork.artifact.id}`);
    expect(anonymousChildDetail.status).toBe(404);
    const deniedChildDetail = await otherOwnerApp.request(`/api/v1/artifacts/${publishedFork.artifact.id}`, { headers: otherOwnerHeaders });
    expect(deniedChildDetail.status).toBe(403);
    expect(await deniedChildDetail.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const childLineageResponse = await ownerApp.request(`/api/v1/artifacts/${publishedFork.artifact.id}/lineage`, { headers: ownerHeaders });
    expect(childLineageResponse.status).toBe(200);
    expect(await childLineageResponse.json()).toMatchObject({
      parents: [{
        parentArtifactId: sourceId,
        childArtifactId: publishedFork.artifact.id,
        sourceVersionId,
        artifact: { id: sourceId, name: `Artifact ${sourceId}` },
      }],
      children: [],
    });
    const ownerSourceLineage = await ownerApp.request(`/api/v1/artifacts/${sourceId}/lineage`, { headers: ownerHeaders });
    expect(ownerSourceLineage.status).toBe(200);
    expect(await ownerSourceLineage.json()).toMatchObject({
      parents: [],
      children: [{
        parentArtifactId: sourceId,
        childArtifactId: publishedFork.artifact.id,
        sourceVersionId,
        artifact: { id: publishedFork.artifact.id },
      }],
    });
    const anonymousSourceLineage = await ownerApp.request(`/api/v1/artifacts/${sourceId}/lineage`);
    expect(anonymousSourceLineage.status).toBe(200);
    expect(await anonymousSourceLineage.json()).toEqual({ parents: [], children: [] });

    const pastedContent = "# Pasted fixture\n\nPreserved content.";
    const pastedResponse = await ownerApp.request("/api/v1/imports/github", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        sourceType: "pasted",
        name: "Pasted Import",
        slug: `pasted-${randomUUID()}`,
        visibility: "private",
        content: pastedContent,
      }),
    });
    expect(pastedResponse.status).toBe(201);
    const pastedDraft = await pastedResponse.json() as {
      id: string;
      revision: number;
      content: { instructions: string };
      forkOrigin: unknown;
      provenance: unknown;
    };
    expect(pastedDraft).toMatchObject({ content: { instructions: pastedContent }, forkOrigin: null, provenance: null });
    const pastedPublishResponse = await ownerApp.request(`/api/v1/drafts/${pastedDraft.id}/publish`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ revision: pastedDraft.revision }),
    });
    expect(pastedPublishResponse.status).toBe(201);
    const pastedPublished = await pastedPublishResponse.json() as { artifact: { id: string }; version: { id: string } };
    expect(await lineage.getParents(pastedPublished.artifact.id)).toEqual([]);
    expect(await provenances.findForVersion(pastedPublished.version.id)).toEqual([]);
    const pastedLineageResponse = await ownerApp.request(`/api/v1/artifacts/${pastedPublished.artifact.id}/lineage`, { headers: ownerHeaders });
    expect(pastedLineageResponse.status).toBe(200);
    expect(await pastedLineageResponse.json()).toEqual({ parents: [], children: [] });

    const githubUrl = "https://raw.githubusercontent.com/example/pearls/main/SKILL.md";
    const githubResponse = await ownerApp.request("/api/v1/imports/github", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        sourceType: "github",
        name: "GitHub Import",
        slug: `github-${randomUUID()}`,
        visibility: "private",
        sourceUrl: githubUrl,
      }),
    });
    expect(githubResponse.status).toBe(201);
    const githubDraft = await githubResponse.json() as {
      id: string;
      revision: number;
      content: { instructions: string };
      forkOrigin: unknown;
      provenance: { sourceType: string; sourceUrl: string; sourceRef: string } | null;
    };
    expect(githubDraft).toMatchObject({
      content: { instructions: "# GitHub fixture\n\nFetched by the backend fixture." },
      forkOrigin: null,
      provenance: { sourceType: "github", sourceUrl: githubUrl, sourceRef: "fixture-ref" },
    });
    const githubPublishResponse = await ownerApp.request(`/api/v1/drafts/${githubDraft.id}/publish`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ revision: githubDraft.revision }),
    });
    expect(githubPublishResponse.status).toBe(201);
    const githubPublished = await githubPublishResponse.json() as { artifact: { id: string }; version: { id: string } };
    expect(await lineage.getParents(githubPublished.artifact.id)).toEqual([]);
    expect(await provenances.findForVersion(githubPublished.version.id)).toMatchObject([{
      sourceType: "github",
      sourceUrl: githubUrl,
      sourceRef: "fixture-ref",
    }]);
    const githubLineageResponse = await ownerApp.request(`/api/v1/artifacts/${githubPublished.artifact.id}/lineage`, { headers: ownerHeaders });
    expect(githubLineageResponse.status).toBe(200);
    expect(await githubLineageResponse.json()).toEqual({ parents: [], children: [] });

    const deniedDeleteResponse = await otherOwnerApp.request(`/api/v1/artifacts/${sourceId}`, {
      method: "DELETE",
      headers: otherOwnerHeaders,
    });
    expect(deniedDeleteResponse.status).toBe(403);
    expect(await deniedDeleteResponse.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const ownerDeleteResponse = await ownerApp.request(`/api/v1/artifacts/${sourceId}`, {
      method: "DELETE",
      headers: ownerHeaders,
    });
    expect(ownerDeleteResponse.status).toBe(204);
    const repeatedDeleteResponse = await ownerApp.request(`/api/v1/artifacts/${sourceId}`, {
      method: "DELETE",
      headers: ownerHeaders,
    });
    expect(repeatedDeleteResponse.status).toBe(410);
    expect(await repeatedDeleteResponse.json()).toMatchObject({ error: { code: "ARTIFACT_GONE" } });

    expect((await artifacts.findById(sourceId))?.snapshot()).toMatchObject({
      id: sourceId,
      status: "tombstone",
      visibility: "unlisted",
    });
    expect(await versions.findForArtifact(sourceId)).toHaveLength(1);
    const tombstone = await pool!.query<{ version_count: number; lineage_count: number }>(
      "SELECT jsonb_array_length(snapshot->'versions') AS version_count,jsonb_array_length(snapshot->'lineage') AS lineage_count FROM tombstone_snapshots WHERE artifact_id=$1",
      [sourceId],
    );
    expect(tombstone.rows[0]).toEqual({ version_count: 1, lineage_count: 1 });
    expect(await lineage.getChildren(sourceId)).toMatchObject([{ childArtifactId: publishedFork.artifact.id }]);
    const tombstonedSourceDetail = await ownerApp.request(`/api/v1/artifacts/${sourceId}`, { headers: ownerHeaders });
    expect(tombstonedSourceDetail.status).toBe(410);
    expect(await tombstonedSourceDetail.json()).toMatchObject({ error: { code: "ARTIFACT_GONE" } });
    const childLineageAfterParentDeletion = await ownerApp.request(`/api/v1/artifacts/${publishedFork.artifact.id}/lineage`, { headers: ownerHeaders });
    expect(childLineageAfterParentDeletion.status).toBe(200);
    expect(await childLineageAfterParentDeletion.json()).toEqual({ parents: [], children: [] });
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

  it("commits transactions, rejects nesting, and releases the client for reuse", async () => {
    const transactions = new PostgresTransactionManager(pool!);
    const artifacts = new PostgresArtifactRepository(transactions.database);
    const artifact = Artifact.create({ id: randomUUID(), ownerId: owners[0]!, name: "Committed", slug: randomUUID(), visibility: "private", createdAt: new Date() });

    await transactions.run(async () => {
      await artifacts.create(artifact);
      await expect(transactions.run(async () => undefined)).rejects.toThrow("Nested transactions are not supported.");
    });
    expect(await artifacts.findById(artifact.id)).not.toBeNull();

    const second = Artifact.create({ id: randomUUID(), ownerId: owners[0]!, name: "Reused client", slug: randomUUID(), visibility: "private", createdAt: new Date() });
    await transactions.run(() => artifacts.create(second));
    expect(await artifacts.findById(second.id)).not.toBeNull();
  });

  it("allows exactly one concurrent owner-scoped slug insert", async () => {
    const slug = randomUUID();
    const attempts = await Promise.allSettled([createArtifact(owners[2], slug), createArtifact(owners[2], slug)]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });

  it("allows concurrent same-slug inserts across owners and rejects one duplicate Version", async () => {
    const slug = randomUUID();
    const differentOwners = await Promise.allSettled([
      createArtifact(owners[0], slug),
      createArtifact(owners[1], slug),
    ]);
    expect(differentOwners.every((attempt) => attempt.status === "fulfilled")).toBe(true);

    const artifactId = await createArtifact();
    const duplicateVersions = await Promise.allSettled([
      createVersion(artifactId, "7.0.0"),
      createVersion(artifactId, "7.0.0"),
    ]);
    expect(duplicateVersions.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = duplicateVersions.filter((attempt) => attempt.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: "23505", constraint: "artifact_versions_artifact_id_version_key" } });
  });
});