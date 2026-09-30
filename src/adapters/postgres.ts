import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import * as semver from "semver";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { Artifact, type ArtifactSnapshot } from "../domain/artifact.js";
import { ArtifactVersion } from "../domain/artifact-version.js";
import { Dependency } from "../domain/dependency.js";
import { DomainError } from "../domain/errors.js";
import type { CompatibilityReport, DependencyResolution, Lineage, Provenance } from "../domain/records.js";
import type {
  ArtifactRepository,
  ArtifactVersionRepository,
  CompatibilityReportRepository,
  DependencyRepository,
  LineageRepository,
  ProvenanceRepository,
  TransactionManager,
} from "../ports/repositories.js";

interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: any[]): Promise<QueryResult<Row>>;
}

function translateConstraints(db: Queryable): Queryable {
  return {
    query: async <Row extends QueryResultRow = QueryResultRow>(text: string, values?: any[]) => {
      try {
        return await db.query<Row>(text, values);
      } catch (error) {
        const postgresError = error as { code?: string; constraint?: string; message?: string; detail?: string };
        const sqlState = postgresError.code;
        if (!sqlState?.startsWith("23") && sqlState !== "55000") throw error;

        const constraint = postgresError.constraint;
        let code: ConstructorParameters<typeof DomainError>[0];
        if (sqlState === "23505") {
          code = constraint === "artifacts_owner_id_slug_key" ? "ARTIFACT_SLUG_CONFLICT"
            : constraint === "artifact_versions_artifact_id_version_key" ? "VERSION_ALREADY_EXISTS"
              : constraint?.startsWith("artifact_lineage_") ? "LINEAGE_INVALID"
                : "INVALID_REQUEST";
        } else if (sqlState === "55000") {
          code = constraint === "artifacts_owner_id_immutable" ? "ARTIFACT_OWNER_IMMUTABLE"
            : constraint === "artifacts_name_immutable" ? "ARTIFACT_NAME_IMMUTABLE"
              : constraint === "artifacts_slug_immutable" ? "ARTIFACT_SLUG_IMMUTABLE"
                : constraint === "artifact_versions_immutable" || postgresError.message?.includes("published Artifact Versions are immutable") ? "VERSION_IMMUTABLE"
                  : "INVALID_REQUEST";
        } else if (sqlState === "23514" && constraint?.startsWith("artifact_lineage_")) {
          code = "LINEAGE_INVALID";
        } else {
          code = "INVALID_REQUEST";
        }

        throw new DomainError(code, "Persistence constraint rejected the operation.", {
          sqlState,
          ...(constraint ? { constraint } : {}),
          ...(postgresError.detail ? { detail: postgresError.detail } : {}),
        });
      }
    },
  };
}

type ArtifactRow = {
  id: string; owner_id: string; name: string; slug: string; visibility: ArtifactSnapshot["visibility"];
  status: ArtifactSnapshot["status"]; created_at: Date; updated_at: Date;
};
type VersionRow = {
  id: string; artifact_id: string; version: string; content_hash: string; content_location: string;
  created_at: Date; published_at: Date;
};

function artifactFromRow(row: ArtifactRow): Artifact {
  return Artifact.reconstitute({
    id: row.id, ownerId: row.owner_id, name: row.name, slug: row.slug,
    visibility: row.visibility, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

function versionFromRow(row: VersionRow): ArtifactVersion {
  return ArtifactVersion.create({
    id: row.id, artifactId: row.artifact_id, version: row.version, contentHash: row.content_hash,
    contentLocation: row.content_location, createdAt: row.created_at, publishedAt: row.published_at,
  });
}

export class PostgresArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: Queryable) { this.db = translateConstraints(db); }

  async findById(id: string): Promise<Artifact | null> {
    const result = await this.db.query<ArtifactRow>("SELECT id,owner_id,name,slug,visibility,status,created_at,updated_at FROM artifacts WHERE id = $1", [id]);
    return result.rows[0] ? artifactFromRow(result.rows[0]) : null;
  }

  async findByOwnerAndSlug(ownerId: string, slug: string): Promise<Artifact | null> {
    const result = await this.db.query<ArtifactRow>("SELECT id,owner_id,name,slug,visibility,status,created_at,updated_at FROM artifacts WHERE owner_id = $1 AND slug = $2", [ownerId, slug]);
    return result.rows[0] ? artifactFromRow(result.rows[0]) : null;
  }

  async create(artifact: Artifact): Promise<void> {
    const value = artifact.snapshot();
    await this.db.query(
      "INSERT INTO artifacts (id, owner_id, name, slug, visibility, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [value.id, value.ownerId, value.name, value.slug, value.visibility, value.status, value.createdAt, value.updatedAt],
    );
  }

  async save(artifact: Artifact): Promise<void> {
    const value = artifact.snapshot();
    await this.db.query("UPDATE artifacts SET visibility=$2, status=$3, updated_at=$4 WHERE id=$1", [value.id, value.visibility, value.status, value.updatedAt]);
  }
}

export class PostgresArtifactVersionRepository implements ArtifactVersionRepository {
  constructor(private readonly db: Queryable) { this.db = translateConstraints(db); }

  async findById(id: string): Promise<ArtifactVersion | null> {
    const result = await this.db.query<VersionRow>("SELECT id,artifact_id,version,content_hash,content_location,created_at,published_at FROM artifact_versions WHERE id = $1", [id]);
    return result.rows[0] ? versionFromRow(result.rows[0]) : null;
  }

  async findByArtifactAndVersion(artifactId: string, version: string): Promise<ArtifactVersion | null> {
    const result = await this.db.query<VersionRow>("SELECT id,artifact_id,version,content_hash,content_location,created_at,published_at FROM artifact_versions WHERE artifact_id=$1 AND version=$2", [artifactId, version]);
    return result.rows[0] ? versionFromRow(result.rows[0]) : null;
  }

  async findForArtifact(artifactId: string): Promise<ArtifactVersion[]> {
    const result = await this.db.query<VersionRow>("SELECT id,artifact_id,version,content_hash,content_location,created_at,published_at FROM artifact_versions WHERE artifact_id=$1 ORDER BY created_at,id", [artifactId]);
    return result.rows.map(versionFromRow);
  }

  async findLatest(artifactId: string): Promise<ArtifactVersion | null> {
    // PostgreSQL lexical ordering diverges from SemVer, so latest selection stays here.
    const versions = (await this.findForArtifact(artifactId)).sort((left, right) =>
      semver.rcompare(left.version, right.version) || (left.version < right.version ? 1 : left.version > right.version ? -1 : 0),
    );
    return versions[0] ?? null;
  }

  async create(version: ArtifactVersion): Promise<void> {
    const value = version.snapshot();
    await this.db.query(
      "INSERT INTO artifact_versions (id,artifact_id,version,content_hash,content_location,created_at,published_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [value.id, value.artifactId, value.version, value.contentHash, value.contentLocation, value.createdAt, value.publishedAt],
    );
  }
}

export class PostgresLineageRepository implements LineageRepository {
  constructor(private readonly db: Queryable) { this.db = translateConstraints(db); }
  async createFork(parentArtifactId: string, childArtifactId: string): Promise<Lineage> {
    const result = await this.db.query<Lineage>(
      "INSERT INTO artifact_lineage (id,parent_artifact_id,child_artifact_id,relationship_type,created_at) VALUES ($1,$2,$3,'fork',now()) RETURNING id,parent_artifact_id AS \"parentArtifactId\",child_artifact_id AS \"childArtifactId\",relationship_type AS \"relationshipType\",created_at AS \"createdAt\"",
      [randomUUID(), parentArtifactId, childArtifactId],
    );
    return result.rows[0]!;
  }
  async getParents(artifactId: string): Promise<Lineage[]> {
    const result = await this.db.query<Lineage>("SELECT id,parent_artifact_id AS \"parentArtifactId\",child_artifact_id AS \"childArtifactId\",relationship_type AS \"relationshipType\",created_at AS \"createdAt\" FROM artifact_lineage WHERE child_artifact_id=$1 ORDER BY created_at,id", [artifactId]);
    return result.rows;
  }
  async getChildren(artifactId: string): Promise<Lineage[]> {
    const result = await this.db.query<Lineage>("SELECT id,parent_artifact_id AS \"parentArtifactId\",child_artifact_id AS \"childArtifactId\",relationship_type AS \"relationshipType\",created_at AS \"createdAt\" FROM artifact_lineage WHERE parent_artifact_id=$1 ORDER BY created_at,id", [artifactId]);
    return result.rows;
  }
}

export class PostgresProvenanceRepository implements ProvenanceRepository {
  constructor(private readonly db: Queryable) { this.db = translateConstraints(db); }
  async create(value: Provenance): Promise<void> {
    await this.db.query("INSERT INTO provenances (id,artifact_version_id,source_type,source_url,source_ref,imported_at) VALUES ($1,$2,$3,$4,$5,$6)", [value.id, value.artifactVersionId, value.sourceType, value.sourceUrl, value.sourceRef, value.importedAt]);
  }
  async findForVersion(versionId: string): Promise<Provenance[]> {
    const result = await this.db.query<Provenance>("SELECT id,artifact_version_id AS \"artifactVersionId\",source_type AS \"sourceType\",source_url AS \"sourceUrl\",source_ref AS \"sourceRef\",imported_at AS \"importedAt\" FROM provenances WHERE artifact_version_id=$1 ORDER BY imported_at,id", [versionId]);
    return result.rows;
  }
}

export class PostgresDependencyRepository implements DependencyRepository {
  constructor(private readonly db: Queryable) { this.db = translateConstraints(db); }
  async findForVersion(versionId: string): Promise<Dependency[]> {
    const result = await this.db.query<{ id: string; artifact_version_id: string; target_artifact_id: string; declared_range: string; created_at: Date }>("SELECT id,artifact_version_id,target_artifact_id,declared_range,created_at FROM dependencies WHERE artifact_version_id=$1 ORDER BY created_at,id", [versionId]);
    return result.rows.map((row) => Dependency.create({ id: row.id, artifactVersionId: row.artifact_version_id, targetArtifactId: row.target_artifact_id, declaredRange: row.declared_range, createdAt: row.created_at }));
  }
  async create(value: Dependency): Promise<void> {
    const row = value.snapshot();
    await this.db.query("INSERT INTO dependencies (id,artifact_version_id,target_artifact_id,declared_range,created_at) VALUES ($1,$2,$3,$4,$5)", [row.id, row.artifactVersionId, row.targetArtifactId, row.declaredRange, row.createdAt]);
  }
  async createResolution(value: DependencyResolution): Promise<void> {
    await this.db.query("INSERT INTO dependency_resolutions (id,dependency_id,resolved_artifact_version_id,resolved_at) VALUES ($1,$2,$3,$4)", [value.id, value.dependencyId, value.resolvedArtifactVersionId, value.resolvedAt]);
  }
  async findResolutions(dependencyId: string): Promise<DependencyResolution[]> {
    const result = await this.db.query<DependencyResolution>("SELECT id,dependency_id AS \"dependencyId\",resolved_artifact_version_id AS \"resolvedArtifactVersionId\",resolved_at AS \"resolvedAt\" FROM dependency_resolutions WHERE dependency_id=$1 ORDER BY resolved_at,id", [dependencyId]);
    return result.rows;
  }
}

export class PostgresCompatibilityReportRepository implements CompatibilityReportRepository {
  constructor(private readonly db: Queryable) { this.db = translateConstraints(db); }
  async create(value: CompatibilityReport): Promise<void> {
    await this.db.query("INSERT INTO compatibility_reports (id,artifact_version_id,target_artifact_version_id,status,report,created_at) VALUES ($1,$2,$3,$4,$5,$6)", [value.id, value.artifactVersionId, value.targetArtifactVersionId, value.status, value.report, value.createdAt]);
  }
  async findForArtifactVersion(versionId: string): Promise<CompatibilityReport[]> {
    const result = await this.db.query<CompatibilityReport>("SELECT id,artifact_version_id AS \"artifactVersionId\",target_artifact_version_id AS \"targetArtifactVersionId\",status,report,created_at AS \"createdAt\" FROM compatibility_reports WHERE artifact_version_id=$1 ORDER BY created_at,id", [versionId]);
    return result.rows;
  }
}

export class PostgresTransactionManager implements TransactionManager {
  private readonly currentClient = new AsyncLocalStorage<PoolClient>();
  readonly database: Queryable;

  constructor(private readonly pool: Pool) {
    this.database = { query: <Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => this.query<Row>(text, values) };
  }

  private async query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>> {
    const client = this.currentClient.getStore();
    return client ? client.query<Row>(text, values) : this.pool.query<Row>(text, values);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    // Nested runs reject before checkout; repository work must use the outer transaction.
    if (this.currentClient.getStore()) throw new Error("Nested transactions are not supported.");

    const client = await this.pool.connect();
    let discardClient: Error | boolean | undefined;
    try {
      try {
        await client.query("BEGIN");
      } catch (error) {
        discardClient = error instanceof Error ? error : true;
        throw error;
      }

      return await this.currentClient.run(client, async () => {
        let result: T;
        try {
          result = await work();
        } catch (workError) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            discardClient = rollbackError instanceof Error ? rollbackError : true;
            attachDiagnostic(workError, "rollbackError", rollbackError);
          }
          throw workError;
        }

        try {
          await client.query("COMMIT");
        } catch (commitError) {
          // A failed COMMIT can have an ambiguous outcome; rollback is best-effort only.
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            discardClient = rollbackError instanceof Error ? rollbackError : true;
            attachDiagnostic(commitError, "rollbackError", rollbackError);
          }
          throw commitError;
        }
        return result;
      });
    } finally {
      client.release(discardClient);
    }
  }
}

function attachDiagnostic(error: unknown, key: string, diagnostic: unknown): void {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return;
  try {
    Object.defineProperty(error, key, { configurable: true, value: diagnostic });
  } catch {
    // Preserve the original failure even when it cannot carry secondary diagnostics.
  }
}