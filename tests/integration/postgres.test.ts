import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
const schema = `pearlhub_test_${randomUUID().replaceAll("-", "")}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` }) : undefined;

integration("PostgreSQL initial schema constraints", () => {
  beforeAll(async () => {
    await adminPool!.query(`CREATE SCHEMA ${schema}`);
    const migration = await readFile(resolve(process.cwd(), "migrations/001_initial.sql"), "utf8");
    await pool!.query(migration);
  });

  afterAll(async () => {
    await pool!.end();
    await adminPool!.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool!.end();
  });

      console.log(`Running integration test for PostgreSQL initial schema constraints ${databaseUrl}`);

  it("enforces owner-scoped uniqueness, foreign keys, and non-self fork lineage", async () => {
    const owners = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    await pool!.query("INSERT INTO users (id, external_subject) VALUES ($1,$2),($3,$4)", [owners[0], "owner-a", owners[1], "owner-b"]);
    const artifacts = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
    await pool!.query("INSERT INTO artifacts (id,owner_id,name,slug,visibility,status) VALUES ($1,$2,'A','same','public','active'),($3,$4,'B','same','public','active')", [artifacts[0], owners[0], artifacts[1], owners[1]]);
    await expect(pool!.query("INSERT INTO artifacts (id,owner_id,name,slug,visibility,status) VALUES ($1,$2,'Duplicate','same','public','active')", ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", owners[0]])).rejects.toMatchObject({ code: "23505" });
    await expect(pool!.query("INSERT INTO artifact_lineage (id,parent_artifact_id,child_artifact_id,relationship_type) VALUES ($1,$2,$2,'fork')", ["dddddddd-dddd-4ddd-8ddd-dddddddddddd", artifacts[0]])).rejects.toMatchObject({ code: "23514" });
    const versionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await pool!.query("INSERT INTO artifact_versions (id,artifact_id,version,content_hash,content_location,published_at) VALUES ($1,$2,'1.0.0','hash','loc',now())", [versionId, artifacts[0]]);
    await expect(pool!.query("UPDATE artifact_versions SET content_hash='changed' WHERE id=$1", [versionId])).rejects.toMatchObject({ code: "55000" });
    await expect(pool!.query("DELETE FROM artifacts WHERE id=$1", [artifacts[0]])).rejects.toMatchObject({ code: "55000" });
  });
});