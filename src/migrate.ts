import { Pool } from "pg";
import { baselinePostgresMigrations, runPostgresMigrations } from "./adapters/postgres-migrations.js";
import { requireDatabaseUrl } from "./runtime.js";

const pool = new Pool({ connectionString: requireDatabaseUrl() });
const mode = process.argv[2];

try {
  if (mode && mode !== "--baseline") {
    throw new Error("Usage: node dist/src/migrate.js [--baseline]");
  }
  const recorded = mode === "--baseline"
    ? await baselinePostgresMigrations(pool)
    : await runPostgresMigrations(pool);
  if (recorded.length === 0) {
    console.log("PostgreSQL schema is already current.");
  } else if (mode === "--baseline") {
    console.log(`Recorded verified migration baseline: ${recorded.join(", ")}`);
  } else {
    console.log(`Applied PostgreSQL migrations: ${recorded.join(", ")}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown migration error.";
  console.error(`PostgreSQL migration failed: ${message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
