import { Pool } from "pg";
import { RebuildArtifactDiscoveryIndexService, ListArtifactsService } from "./application/discovery.js";
import { CreateArtifactService } from "./application/services.js";
import { assertPostgresMigrationsCurrent } from "./adapters/postgres-migrations.js";
import {
  PostgresArtifactDiscoveryRepository,
  PostgresArtifactRepository,
  PostgresArtifactVersionRepository,
  PostgresDiscoveryReindexLock,
  PostgresTransactionManager,
} from "./adapters/postgres.js";
import { createHttpApp } from "./http/app.js";
import type { Authenticator } from "./http/authentication.js";
import type { ArtifactContentStore } from "./ports/repositories.js";

export interface PostgresRuntimeOptions {
  databaseUrl: string;
  authenticator: Authenticator;
  contentStore: ArtifactContentStore;
  pool?: Pool;
}

export async function createPostgresRuntime(options: PostgresRuntimeOptions) {
  validateDatabaseUrl(options.databaseUrl);
  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? new Pool({ connectionString: options.databaseUrl });

  try {
    await assertPostgresMigrationsCurrent(pool);
    const transactions = new PostgresTransactionManager(pool);
    const artifacts = new PostgresArtifactRepository(transactions.database);
    const versions = new PostgresArtifactVersionRepository(transactions.database);
    const discovery = new PostgresArtifactDiscoveryRepository(transactions.database);
    await new RebuildArtifactDiscoveryIndexService(
      discovery,
      versions,
      options.contentStore,
      transactions,
      new PostgresDiscoveryReindexLock(pool),
    ).execute();
    const createArtifact = new CreateArtifactService(artifacts);
    const listArtifacts = new ListArtifactsService(discovery);
    return {
      app: createHttpApp({ createArtifact, listArtifacts, authenticator: options.authenticator }),
      close: async () => {
        if (ownsPool) await pool.end();
      },
    };
  } catch (error) {
    if (ownsPool) await pool.end();
    throw error;
  }
}

export function requireDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to start PearlHub or run migrations.");
  }
  validateDatabaseUrl(databaseUrl);
  return databaseUrl;
}

function validateDatabaseUrl(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2) {
    throw new Error("DATABASE_URL must include a PostgreSQL protocol, host, and database name.");
  }
}
