import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import * as semver from "semver";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { Artifact, type ArtifactSnapshot } from "../domain/artifact.js";
import { ArtifactVersion } from "../domain/artifact-version.js";
import { Draft, type DraftState } from "../domain/draft.js";
import type { ArtifactDiscoveryPageRow, ArtifactDiscoveryQuery, ArtifactSummary } from "../domain/discovery.js";
import { Dependency } from "../domain/dependency.js";
import { DomainError } from "../domain/errors.js";
import type { CompatibilityReport, DependencyResolution, Lineage, Provenance } from "../domain/records.js";
import type {
  ArtifactRepository,
  ArtifactVersionRepository,
  DraftRepository,
  ArtifactDiscoveryRepository,
  CompatibilityReportRepository,
  DependencyRepository,
  DiscoveryReindexLock,
  LineageRepository,
  ProvenanceRepository,
  TransactionManager,
  UserIdentity,
  UserIdentityRepository,
} from "../ports/repositories.js";

interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}

function translateConstraints(db: Queryable): Queryable {
  return {
    query: async <Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => {
      try {
        return await db.query<Row>(text, values);
      } catch (error) {
        const postgresError = readPostgresError(error);
        if (!postgresError) throw error;
        const sqlState = postgresError.code;
        if (!sqlState?.startsWith("23") && sqlState !== "55000") throw error;

        const constraint = postgresError.constraint;
        let code: ConstructorParameters<typeof DomainError>[0];
        if (sqlState === "23505") {
          code = constraint === "artifacts_owner_id_slug_key" ? "ARTIFACT_SLUG_CONFLICT"
            : constraint === "artifact_versions_artifact_id_version_key" ? "VERSION_ALREADY_EXISTS"
              : constraint === "drafts_one_active_per_artifact_idx" ? "DRAFT_ALREADY_ACTIVE"
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

        throw new DomainError(code, "Persistence constraint rejected the operation.");
      }
    },
  };
}

function readPostgresError(error: unknown): { code: string; constraint?: string; message?: string } | null {
  if ((typeof error !== "object" && typeof error !== "function") || error === null || !("code" in error)) {
    return null;
  }
  const code = error.code;
  if (typeof code !== "string") return null;
  const constraint = "constraint" in error && typeof error.constraint === "string" ? error.constraint : undefined;
  const message = "message" in error && typeof error.message === "string" ? error.message : undefined;
  return {
    code,
    ...(constraint ? { constraint } : {}),
    ...(message ? { message } : {}),
  };
}

type ArtifactRow = {
  id: string; owner_id: string; name: string; slug: string; visibility: ArtifactSnapshot["visibility"];
  status: ArtifactSnapshot["status"]; created_at: Date; updated_at: Date;
};
type VersionRow = {
  id: string; artifact_id: string; version: string; content_hash: string; content_location: string;
  content_snapshot: Record<string, unknown>; created_at: Date; published_at: Date;
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
    contentLocation: row.content_location, contentSnapshot: row.content_snapshot, createdAt: row.created_at, publishedAt: row.published_at,
  });
}

export class PostgresArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: Queryable) { this.db = translateConstraints(db); }

  async findById(id: string): Promise<Artifact | null> {
    const result = await this.db.query<ArtifactRow>("SELECT id,owner_id,name,slug,visibility,status,created_at,updated_at FROM artifacts WHERE id = $1", [id]);
    return result.rows[0] ? artifactFromRow(result.rows[0]) : null;
  }

  async findTombstoneSnapshotArtifact(id: string): Promise<Artifact | null> {
    const result = await this.db.query<{ artifact: ArtifactRow }>(
      "SELECT snapshot->'artifact' AS artifact FROM tombstone_snapshots WHERE artifact_id=$1 ORDER BY snapshot_number DESC LIMIT 1",
      [id],
    );
    return result.rows[0] ? artifactFromRow(result.rows[0].artifact) : null;
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

  async tombstone(artifact: Artifact): Promise<void> {
    const value = artifact.snapshot();
    await this.db.query("SELECT tombstone_artifact($1,$2,$3)", [value.id, randomUUID(), value.updatedAt]);
  }

  async restore(artifact: Artifact): Promise<Artifact | null> {
    const value = artifact.snapshot();
    const result = await this.db.query<ArtifactRow>(
      "SELECT * FROM restore_artifact($1,$2,$3)",
      [value.id, value.visibility, value.updatedAt],
    );
    return result.rows[0] ? artifactFromRow(result.rows[0]) : null;
  }
}

export class PostgresArtifactVersionRepository implements ArtifactVersionRepository {
  constructor(private readonly db: Queryable) { this.db = translateConstraints(db); }

  async findById(id: string): Promise<ArtifactVersion | null> {
    const result = await this.db.query<VersionRow>("SELECT id,artifact_id,version,content_hash,content_location,content_snapshot,created_at,published_at FROM artifact_versions WHERE id = $1", [id]);
    return result.rows[0] ? versionFromRow(result.rows[0]) : null;
  }

  async findByArtifactAndVersion(artifactId: string, version: string): Promise<ArtifactVersion | null> {
    const result = await this.db.query<VersionRow>("SELECT id,artifact_id,version,content_hash,content_location,content_snapshot,created_at,published_at FROM artifact_versions WHERE artifact_id=$1 AND version=$2", [artifactId, version]);
    return result.rows[0] ? versionFromRow(result.rows[0]) : null;
  }

  async findForArtifact(artifactId: string): Promise<ArtifactVersion[]> {
    const result = await this.db.query<VersionRow>("SELECT id,artifact_id,version,content_hash,content_location,content_snapshot,created_at,published_at FROM artifact_versions WHERE artifact_id=$1 ORDER BY created_at,id", [artifactId]);
    return result.rows.map(versionFromRow);
  }

  async findLatest(artifactId: string): Promise<ArtifactVersion | null> {
    // PostgreSQL lexical ordering diverges from SemVer, so latest selection stays here.
    const versions = (await this.findForArtifact(artifactId)).sort((left, right) =>
      semver.rcompare(left.version, right.version) || (left.version < right.version ? 1 : left.version > right.version ? -1 : 0),
    );
    return versions[0] ?? null;
  }

  async lockArtifactForWrite(artifactId: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>("SELECT id FROM artifacts WHERE id=$1 FOR UPDATE", [artifactId]);
    return result.rows.length > 0;
  }

  async create(version: ArtifactVersion): Promise<void> {
    const value = version.snapshot();
    await this.db.query(
      "INSERT INTO artifact_versions (id,artifact_id,version,content_hash,content_location,content_snapshot,created_at,published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [value.id, value.artifactId, value.version, value.contentHash, value.contentLocation, value.contentSnapshot ?? {}, value.createdAt, value.publishedAt],
    );
  }
}

type DraftRow = {
  id: string; owner_id: string; artifact_id: string | null; base_version_id: string | null;
  name: string; slug: string; visibility: DraftState["visibility"]; content: DraftState["content"];
  state: DraftState["state"]; revision: number; created_at: Date; updated_at: Date;
};

function draftFromRow(row: DraftRow): Draft {
  return Draft.reconstitute({
    id: row.id, ownerId: row.owner_id, artifactId: row.artifact_id, baseVersionId: row.base_version_id,
    name: row.name, slug: row.slug, visibility: row.visibility, content: row.content,
    state: row.state, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

export class PostgresDraftRepository implements DraftRepository {
  constructor(private readonly db: Queryable) { this.db = translateConstraints(db); }

  async findById(id: string): Promise<Draft | null> {
    const result = await this.db.query<DraftRow>(
      "SELECT id,owner_id,artifact_id,base_version_id,name,slug,visibility,content,state,revision,created_at,updated_at FROM drafts WHERE id=$1",
      [id],
    );
    return result.rows[0] ? draftFromRow(result.rows[0]) : null;
  }

  async findByIdForUpdate(id: string): Promise<Draft | null> {
    const result = await this.db.query<DraftRow>(
      "SELECT id,owner_id,artifact_id,base_version_id,name,slug,visibility,content,state,revision,created_at,updated_at FROM drafts WHERE id=$1 FOR UPDATE",
      [id],
    );
    return result.rows[0] ? draftFromRow(result.rows[0]) : null;
  }

  async create(draft: Draft): Promise<void> {
    const value = draft.snapshot();
    await this.db.query(
      "INSERT INTO drafts (id,owner_id,artifact_id,base_version_id,name,slug,visibility,content,state,revision,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [value.id, value.ownerId, value.artifactId, value.baseVersionId, value.name, value.slug, value.visibility, value.content, value.state, value.revision, value.createdAt, value.updatedAt],
    );
  }

  async save(draft: Draft): Promise<void> {
    const value = draft.snapshot();
    const result = await this.db.query(
      "UPDATE drafts SET name=$2,slug=$3,visibility=$4,content=$5,state=$6,revision=$7,updated_at=$8 WHERE id=$1",
      [value.id, value.name, value.slug, value.visibility, value.content, value.state, value.revision, value.updatedAt],
    );
    if (result.rowCount !== 1) throw new DomainError("DRAFT_NOT_FOUND", "Draft was not found.");
  }
}

interface DiscoveryRow {
  id: string;
  name: string;
  slug: string;
  visibility: ArtifactSummary["visibility"];
  tags: string[] | null;
  created_at: Date;
  updated_at: Date;
  sort_value: string;
}

export class PostgresArtifactDiscoveryRepository implements ArtifactDiscoveryRepository {
  constructor(private readonly db: Queryable) { this.db = translateConstraints(db); }

  async findPage(input: Omit<ArtifactDiscoveryQuery, "cursor"> & { after?: { sortValue: string; id: string } }): Promise<{ rows: ArtifactDiscoveryPageRow[]; hasMore: boolean }> {
    const state = await this.db.query<{ ready: boolean }>(
      "SELECT ready FROM artifact_discovery_index_state WHERE singleton=TRUE",
    );
    if (state.rows[0]?.ready !== true) {
      throw new DomainError("DISCOVERY_NOT_READY", "Artifact discovery is temporarily unavailable.");
    }

    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    const conditions = ["a.status='active'"];
    if (input.visibility === "public") {
      conditions.push("a.visibility='public'");
    } else if (input.visibility) {
      if (!input.callerId) {
        conditions.push("FALSE");
      } else {
        const caller = bind(input.callerId);
        conditions.push(`a.owner_id=${caller} AND a.visibility=${bind(input.visibility)}`);
      }
    } else if (input.callerId) {
      const caller = bind(input.callerId);
      conditions.push(`(a.visibility='public' OR (a.owner_id=${caller} AND a.visibility='private'))`);
    } else {
      conditions.push("a.visibility='public'");
    }

    if (input.tags.length > 0) {
      conditions.push(`COALESCE(discovery.tags, ARRAY[]::text[]) @> ${bind(input.tags)}::text[]`);
    }
    if (input.q !== undefined) {
      const escaped = input.q.replace(/[\\%_]/g, "\\$&");
      const pattern = bind(`%${escaped}%`);
      conditions.push(`(lower(a.name) LIKE lower(${pattern}) ESCAPE E'\\\\' OR lower(a.slug) LIKE lower(${pattern}) ESCAPE E'\\\\')`);
    }

    const sortExpression = input.sort === "name" ? "lower(a.name)"
      : input.sort === "updatedAt" ? "a.updated_at"
        : "a.created_at";
    const cursorExpression = input.sort === "name" ? sortExpression : `extract(epoch FROM ${sortExpression})`;
    const cursorType = input.sort === "name" ? "text" : "numeric";
    if (input.after) {
      const operator = input.direction === "asc" ? ">" : "<";
      conditions.push(`(${cursorExpression},a.id) ${operator} (${bind(input.after.sortValue)}::${cursorType},${bind(input.after.id)}::uuid)`);
    }

    const limit = bind(input.limit + 1);
    const direction = input.direction.toUpperCase();
    const result = await this.db.query<DiscoveryRow>(
      `SELECT a.id,a.name,a.slug,a.visibility,discovery.tags,a.created_at,a.updated_at,${cursorExpression}::text AS sort_value
       FROM artifacts a
       LEFT JOIN artifact_discovery_index discovery ON discovery.artifact_id=a.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ${sortExpression} ${direction},a.id ${direction}
       LIMIT ${limit}`,
      values,
    );
    const hasMore = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit).map((row): ArtifactDiscoveryPageRow => ({
      item: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        visibility: row.visibility,
        tags: row.tags ?? [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      sortValue: row.sort_value,
    }));
    return { rows, hasMore };
  }

  async findArtifactIdsAfter(afterId: string | null, limit: number): Promise<string[]> {
    const result = await this.db.query<{ id: string }>(
      "SELECT id FROM artifacts WHERE $1::uuid IS NULL OR id>$1::uuid ORDER BY id LIMIT $2",
      [afterId, limit],
    );
    return result.rows.map((row) => row.id);
  }

  async replaceTagProjection(artifactId: string, versionId: string | null, tags: string[]): Promise<void> {
    if (versionId === null) {
      await this.db.query("DELETE FROM artifact_discovery_index WHERE artifact_id=$1", [artifactId]);
      return;
    }
    await this.db.query(
      `INSERT INTO artifact_discovery_index (artifact_id,artifact_version_id,tags)
       VALUES ($1,$2,$3)
       ON CONFLICT (artifact_id) DO UPDATE
       SET artifact_version_id=EXCLUDED.artifact_version_id,tags=EXCLUDED.tags`,
      [artifactId, versionId, tags],
    );
  }

  async clearTagProjections(): Promise<void> {
    await this.db.query("DELETE FROM artifact_discovery_index");
  }

  async isReady(): Promise<boolean> {
    const result = await this.db.query<{ ready: boolean }>(
      "SELECT ready FROM artifact_discovery_index_state WHERE singleton=TRUE",
    );
    return result.rows[0]?.ready === true;
  }

  async setReady(ready: boolean): Promise<void> {
    const result = await this.db.query(
      "UPDATE artifact_discovery_index_state SET ready=$1 WHERE singleton=TRUE",
      [ready],
    );
    if (result.rowCount !== 1) {
      throw new Error("Artifact discovery index state is missing.");
    }
  }
}

export class PostgresDiscoveryReindexLock implements DiscoveryReindexLock {
  constructor(private readonly pool: Pool) {}

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discardClient: Error | boolean | undefined;
    let lockHeld = false;
    let workError: unknown;
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtext(current_schema()),hashtext('pearlhub.discovery_index_rebuild'))",
      );
      lockHeld = true;
      return await work();
    } catch (error) {
      workError = error;
      throw error;
    } finally {
      try {
        if (lockHeld) {
          await client.query(
            "SELECT pg_advisory_unlock(hashtext(current_schema()),hashtext('pearlhub.discovery_index_rebuild'))",
          );
        }
      } catch (error) {
        discardClient = error instanceof Error ? error : true;
        if (workError !== undefined) attachDiagnostic(workError, "unlockError", error);
        else throw error;
      } finally {
        client.release(discardClient);
      }
    }
  }
}

export class PostgresLineageRepository implements LineageRepository {
  constructor(private readonly db: Queryable) { this.db = translateConstraints(db); }
  async createFork(parentArtifactId: string, childArtifactId: string, sourceVersionId?: string): Promise<Lineage> {
    const result = await this.db.query<Lineage>(
      "INSERT INTO artifact_lineage (id,parent_artifact_id,child_artifact_id,source_version_id,relationship_type,created_at) VALUES ($1,$2,$3,$4,'fork',now()) RETURNING id,parent_artifact_id AS \"parentArtifactId\",child_artifact_id AS \"childArtifactId\",source_version_id AS \"sourceVersionId\",relationship_type AS \"relationshipType\",created_at AS \"createdAt\"",
      [randomUUID(), parentArtifactId, childArtifactId, sourceVersionId ?? null],
    );
    return result.rows[0]!;
  }
  async getParents(artifactId: string): Promise<Lineage[]> {
    const result = await this.db.query<Lineage>("SELECT id,parent_artifact_id AS \"parentArtifactId\",child_artifact_id AS \"childArtifactId\",source_version_id AS \"sourceVersionId\",relationship_type AS \"relationshipType\",created_at AS \"createdAt\" FROM artifact_lineage WHERE child_artifact_id=$1 ORDER BY created_at,id", [artifactId]);
    return result.rows;
  }
  async getChildren(artifactId: string): Promise<Lineage[]> {
    const result = await this.db.query<Lineage>("SELECT id,parent_artifact_id AS \"parentArtifactId\",child_artifact_id AS \"childArtifactId\",source_version_id AS \"sourceVersionId\",relationship_type AS \"relationshipType\",created_at AS \"createdAt\" FROM artifact_lineage WHERE parent_artifact_id=$1 ORDER BY created_at,id", [artifactId]);
    return result.rows;
  }
}

export class PostgresUserIdentityRepository implements UserIdentityRepository {
  constructor(private readonly db: Queryable) { this.db = translateConstraints(db); }

  async findUserId(provider: string, subject: string): Promise<string | null> {
    const result = await this.db.query<{ user_id: string }>(
      "SELECT user_id FROM user_identities WHERE provider=$1 AND subject=$2",
      [provider, subject],
    );
    return result.rows[0]?.user_id ?? null;
  }

  async create(identity: UserIdentity): Promise<void> {
    await this.db.query(
      "INSERT INTO user_identities (id,user_id,provider,subject,created_at) VALUES ($1,$2,$3,$4,$5)",
      [identity.id, identity.userId, identity.provider, identity.subject, identity.createdAt],
    );
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