import { Pool } from "pg";
import { RebuildArtifactDiscoveryIndexService, ListArtifactsService } from "./application/discovery.js";
import { DeleteArtifactService, DraftWorkflowService, ImportDraftService, UpdateArtifactMetadataService } from "./application/services.js";
import { assertPostgresMigrationsCurrent } from "./adapters/postgres-migrations.js";
import {
  PostgresArtifactDiscoveryRepository,
  PostgresDraftRepository,
  PostgresDependencyRepository,
  PostgresCompatibilityReportRepository,
  PostgresArtifactRepository,
  PostgresArtifactVersionRepository,
  PostgresDiscoveryReindexLock,
  PostgresLineageRepository,
  PostgresProvenanceRepository,
  PostgresTransactionManager,
} from "./adapters/postgres.js";
import { SafeGitHubRawSource } from "./adapters/github-raw-source.js";
import { createHttpApp } from "./http/app.js";
import type { Authenticator } from "./http/authentication.js";
import type { ArtifactContentStore } from "./ports/repositories.js";

export interface PostgresRuntimeOptions {
  databaseUrl: string;
  authenticator: Authenticator;
  contentStore: ArtifactContentStore;
  pool?: Pool;
  corsOrigins?: string[];
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
    const lineage = new PostgresLineageRepository(transactions.database);
    const provenances = new PostgresProvenanceRepository(transactions.database);
    const discovery = new PostgresArtifactDiscoveryRepository(transactions.database);
    await new RebuildArtifactDiscoveryIndexService(
      discovery,
      versions,
      options.contentStore,
      transactions,
      new PostgresDiscoveryReindexLock(pool),
    ).execute();
    const access = {
      canRead: async (actorId: string, artifact: import("./domain/artifact.js").Artifact) => artifact.ownerId === actorId || artifact.visibility === "public",
      canWrite: async (actorId: string, artifact: import("./domain/artifact.js").Artifact) => artifact.ownerId === actorId,
    };
    const dependencyRepository = new PostgresDependencyRepository(transactions.database);
    const compatibilityReports = new PostgresCompatibilityReportRepository(transactions.database);
    const drafts = new DraftWorkflowService(
      new PostgresDraftRepository(transactions.database),
      artifacts,
      versions,
      dependencyRepository,
      access,
      discovery,
      transactions,
      undefined,
      undefined,
      lineage,
      provenances,
      compatibilityReports,
    );
    const deleteArtifact = new DeleteArtifactService(artifacts, access, undefined, transactions);
    const updateArtifactMetadata = new UpdateArtifactMetadataService(artifacts, access, undefined, transactions);
    const importDraft = new ImportDraftService(new SafeGitHubRawSource(), drafts);
    const listArtifacts = new ListArtifactsService(discovery);
    return {
      app: createHttpApp({
        artifactReads: drafts,
        artifactVersionDependencies: drafts,
        artifactVersionCompatibilityReports: drafts,
        drafts,
        deleteArtifact,
        updateArtifactMetadata,
        importDraft,
        listArtifacts,
        authenticator: options.authenticator,
        ...(options.corsOrigins === undefined ? {} : { corsOrigins: options.corsOrigins }),
      }),
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
