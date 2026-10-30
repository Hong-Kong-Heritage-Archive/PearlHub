import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

const defaultMigrationsDirectory = resolve(process.cwd(), "migrations");

export async function runPostgresMigrations(
  pool: Pool,
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<string[]> {
  const migrations = await readMigrations(migrationsDirectory);
  const client = await pool.connect();
  let discardClient: Error | boolean | undefined;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext(current_schema()))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = await readAppliedMigrations(client);
    const byName = new Map(applied.map((entry) => [entry.version, entry.checksum]));
    for (const [version, checksum] of byName) {
      const migration = migrations.find((candidate) => candidate.name === version);
      if (!migration) {
        throw new Error(`Applied migration ${version} is missing from ${migrationsDirectory}.`);
      }
      if (migration.checksum !== checksum) {
        throw new Error(`Applied migration ${version} has changed; migrations are immutable.`);
      }
    }

    let encounteredPendingMigration = false;
    for (const migration of migrations) {
      if (!byName.has(migration.name)) {
        encounteredPendingMigration = true;
      } else if (encounteredPendingMigration) {
        throw new Error("Migration history is out of order; review schema_migrations before continuing.");
      }
    }

    const newlyApplied: string[] = [];
    for (const migration of migrations) {
      if (byName.has(migration.name)) continue;
      await applyMigration(client, migration);
      newlyApplied.push(migration.name);
    }
    return newlyApplied;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext(current_schema()))");
    } catch (error) {
      discardClient = error instanceof Error ? error : true;
      throw error;
    } finally {
      client.release(discardClient);
    }
  }
}

export async function baselinePostgresMigrations(
  pool: Pool,
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<string[]> {
  const migrations = await readMigrations(migrationsDirectory);
  const client = await pool.connect();
  let discardClient: Error | boolean | undefined;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext(current_schema()))");
    await verifyExistingFinalSchema(client);
    await client.query("BEGIN");
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const existing = await client.query<{ version: string }>(
        "SELECT version FROM schema_migrations",
      );
      if (existing.rows.length > 0) {
        throw new Error("Migration history already exists; use npm run db:migrate instead.");
      }
      for (const migration of migrations) {
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
      }
      await client.query("COMMIT");
      return migrations.map((migration) => migration.name);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext(current_schema()))");
    } catch (error) {
      discardClient = error instanceof Error ? error : true;
      throw error;
    } finally {
      client.release(discardClient);
    }
  }
}

export async function assertPostgresMigrationsCurrent(
  pool: Pool,
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<void> {
  const migrations = await readMigrations(migrationsDirectory);
  const client = await pool.connect();
  try {
    const ledgerTable = await client.query<{ table_name: string | null }>(
      "SELECT to_regclass('schema_migrations')::text AS table_name",
    );
    if (!ledgerTable.rows[0]?.table_name) {
      throw new Error("PostgreSQL migrations have not been run; run npm run db:migrate.");
    }
    const ledger = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations",
    );
    const applied = new Map(ledger.rows.map((entry) => [entry.version, entry.checksum]));
    for (const migration of migrations) {
      if (applied.get(migration.name) !== migration.checksum) {
        throw new Error(`Database schema is missing current migration ${migration.name}; run npm run db:migrate.`);
      }
    }
    for (const version of applied.keys()) {
      if (!migrations.some((migration) => migration.name === version)) {
        throw new Error(`Database records unknown migration ${version}; review migration history before starting.`);
      }
    }
  } finally {
    client.release();
  }
}

async function readMigrations(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory))
    .filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/.test(name))
    .sort();

  if (names.length === 0) {
    throw new Error(`No ordered SQL migrations found in ${directory}.`);
  }

  const migrations: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(resolve(directory, name), "utf8");
    stripTransactionEnvelope(sql);
    migrations.push({
      name,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return migrations;
}

async function readAppliedMigrations(client: PoolClient): Promise<Array<{ version: string; checksum: string }>> {
  const result = await client.query<{ version: string; checksum: string }>(
    "SELECT version, checksum FROM schema_migrations ORDER BY version",
  );
  return result.rows;
}

async function verifyExistingFinalSchema(client: PoolClient): Promise<void> {
  const requiredTables = [
    "users",
    "artifacts",
    "artifact_versions",
    "artifact_lineage",
    "provenances",
    "dependencies",
    "dependency_resolutions",
    "dependency_resolution_runs",
    "compatibility_reports",
    "user_identities",
    "tombstone_snapshots",
    "artifact_discovery_index",
    "artifact_discovery_index_state",
    "drafts",
  ];
  const tables = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name=ANY($1::text[])",
    [requiredTables],
  );
  if (tables.rows.length !== requiredTables.length) {
    throw new Error("Baseline requires the complete existing PearlHub schema; no application data was changed.");
  }

  const requiredColumns = [
    ["artifact_lineage", "source_version_id"],
    ["dependency_resolutions", "target_artifact_id"],
    ["dependency_resolutions", "run_id"],
    ["dependency_resolutions", "source_artifact_version_id"],
    ["dependency_resolution_runs", "source_artifact_version_id"],
    ["user_identities", "provider"],
    ["user_identities", "subject"],
    ["tombstone_snapshots", "snapshot_number"],
    ["artifact_discovery_index", "artifact_version_id"],
    ["artifact_discovery_index", "tags"],
    ["artifact_discovery_index_state", "ready"],
    ["artifact_versions", "content_snapshot"],
    ["drafts", "content"],
    ["drafts", "state"],
    ["drafts", "revision"],
    ["drafts", "fork_source_artifact_id"],
    ["drafts", "fork_source_version_id"],
    ["drafts", "provenance"],
  ];
  const columns = await client.query<{ table_name: string; column_name: string }>(
    "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND (table_name,column_name) IN (('artifact_lineage','source_version_id'),('dependency_resolutions','target_artifact_id'),('dependency_resolutions','run_id'),('dependency_resolutions','source_artifact_version_id'),('dependency_resolution_runs','source_artifact_version_id'),('user_identities','provider'),('user_identities','subject'),('tombstone_snapshots','snapshot_number'),('artifact_discovery_index','artifact_version_id'),('artifact_discovery_index','tags'),('artifact_discovery_index_state','ready'),('artifact_versions','content_snapshot'),('drafts','content'),('drafts','state'),('drafts','revision'),('drafts','fork_source_artifact_id'),('drafts','fork_source_version_id'),('drafts','provenance'))",
  );
  if (columns.rows.length !== requiredColumns.length) {
    throw new Error("Baseline schema is missing a migration column; no application data was changed.");
  }

  const requiredTriggers = [
    "artifacts_identity_immutable",
    "artifacts_no_physical_delete",
    "dependency_resolutions_set_target",
    "dependency_resolution_runs_lock_source",
    "dependency_resolution_runs_no_update_or_delete",
    "dependency_resolution_runs_no_truncate",
    "dependency_resolutions_no_update_or_delete",
    "dependency_resolutions_no_truncate",
    "dependencies_resolution_runs_immutable",
    "tombstone_snapshots_no_update_or_delete",
    "tombstone_snapshots_no_truncate",
  ];
  const triggers = await client.query<{ tgname: string }>(
    "SELECT tgname FROM pg_trigger JOIN pg_class ON pg_class.oid=tgrelid JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace WHERE nspname=current_schema() AND NOT tgisinternal AND tgname=ANY($1::text[])",
    [requiredTriggers],
  );
  if (triggers.rows.length !== requiredTriggers.length) {
    throw new Error("Baseline schema is missing a migration trigger; no application data was changed.");
  }

  const requiredIndexes = [
    "artifact_discovery_tags_gin_idx",
    "artifacts_discovery_name_trgm_idx",
    "artifacts_discovery_slug_trgm_idx",
    "artifacts_discovery_created_idx",
    "artifacts_discovery_updated_idx",
    "artifacts_discovery_name_idx",
    "drafts_one_active_per_artifact_idx",
    "dependency_resolution_runs_source_created_idx",
    "dependency_resolutions_run_idx",
  ];
  const indexes = await client.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname=ANY($1::text[])",
    [requiredIndexes],
  );
  if (indexes.rows.length !== requiredIndexes.length) {
    throw new Error("Baseline schema is missing a discovery index; no application data was changed.");
  }

  const extension = await client.query<{ extname: string }>(
    "SELECT extname FROM pg_extension WHERE extname='pg_trgm' AND extnamespace='public'::regnamespace",
  );
  if (extension.rows.length !== 1) {
    throw new Error("Baseline schema requires pg_trgm installed in public; no application data was changed.");
  }
}

async function applyMigration(client: PoolClient, migration: MigrationFile): Promise<void> {
  const body = stripTransactionEnvelope(migration.sql);
  await client.query("BEGIN");
  try {
    await client.query(body);
    await client.query(
      "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
      [migration.name, migration.checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      throw error;
    }
    throw error;
  }
}

function stripTransactionEnvelope(sql: string): string {
  const match = sql.match(/^\s*BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/i);
  if (!match?.[1]) {
    throw new Error("Every SQL migration must contain one BEGIN; ... COMMIT; transaction envelope.");
  }
  return match[1];
}
