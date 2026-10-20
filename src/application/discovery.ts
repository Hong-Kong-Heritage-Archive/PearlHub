import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type {
  ArtifactDiscoveryCursorPosition,
  ArtifactDiscoveryPage,
  ArtifactDiscoveryQuery,
} from "../domain/discovery.js";
import { normalizePearlTags, readPearlTags } from "../domain/discovery.js";
import type {
  ArtifactContentStore,
  ArtifactDiscoveryRepository,
  ArtifactVersionRepository,
  DiscoveryReindexLock,
  TransactionManager,
} from "../ports/repositories.js";

const reindexBatchSize = 100;

export class ListArtifactsService {
  constructor(private readonly discovery: ArtifactDiscoveryRepository) {}

  async execute(input: ArtifactDiscoveryQuery): Promise<ArtifactDiscoveryPage> {
    const query = normalizeQuery(input);
    const fingerprint = queryFingerprint(query);
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint, query.sort) : undefined;
    const result = await this.discovery.findPage({
      callerId: query.callerId,
      ...(query.q === undefined ? {} : { q: query.q }),
      tags: query.tags,
      ...(query.visibility === undefined ? {} : { visibility: query.visibility }),
      limit: query.limit,
      sort: query.sort,
      direction: query.direction,
      ...(after === undefined ? {} : { after }),
    });

    const last = result.rows.at(-1);
    return {
      items: result.rows.map((row) => row.item),
      nextCursor: result.hasMore && last
        ? encodeCursor({ fingerprint, sortValue: last.sortValue, id: last.item.id })
        : null,
    };
  }
}

export class RebuildArtifactDiscoveryIndexService {
  constructor(
    private readonly discovery: ArtifactDiscoveryRepository,
    private readonly versions: ArtifactVersionRepository,
    private readonly contentStore: ArtifactContentStore,
    private readonly transactions: TransactionManager,
    private readonly lock: DiscoveryReindexLock,
  ) {}

  async execute(): Promise<void> {
    await this.lock.runExclusive(async () => {
      if (await this.discovery.isReady()) return;
      await this.transactions.run(async () => {
        await this.discovery.setReady(false);
        await this.discovery.clearTagProjections();
      });

      let afterId: string | null = null;
      while (true) {
        const artifactIds = await this.discovery.findArtifactIdsAfter(afterId, reindexBatchSize);
        if (artifactIds.length === 0) break;

        for (const artifactId of artifactIds) {
          await this.transactions.run(async () => {
            if (!await this.versions.lockArtifactForWrite(artifactId)) {
              throw new Error(`Artifact ${artifactId} disappeared during discovery index rebuild.`);
            }
            const latest = await this.versions.findLatest(artifactId);
            if (!latest) {
              await this.discovery.replaceTagProjection(artifactId, null, []);
              return;
            }
            const snapshot = latest.contentSnapshot;
            const content = snapshot && Object.keys(snapshot).length > 0
              ? JSON.stringify(snapshot.content ?? snapshot)
              : await this.contentStore.get(latest.contentLocation);
            if (content === null) {
              throw new Error(`Content for Artifact Version ${latest.id} is unavailable during discovery index rebuild.`);
            }
            await this.discovery.replaceTagProjection(artifactId, latest.id, readPearlTags(content));
          });
        }
        afterId = artifactIds.at(-1)!;
      }

      await this.transactions.run(() => this.discovery.setReady(true));
    });
  }
}

function normalizeQuery(input: ArtifactDiscoveryQuery): ArtifactDiscoveryQuery {
  const tags = normalizePearlTags(input.tags);
  if (input.q !== undefined && (input.q.trim().length < 1 || input.q.trim().length > 100)) {
    throw new DomainError("INVALID_REQUEST", "Search query must contain 1 to 100 characters.", { field: "q" });
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new DomainError("INVALID_REQUEST", "Limit must be an integer from 1 to 100.", { field: "limit" });
  }
  if (!["createdAt", "updatedAt", "name"].includes(input.sort) || !["asc", "desc"].includes(input.direction)) {
    throw new DomainError("INVALID_REQUEST", "Unsupported discovery sort.");
  }
  if (input.visibility !== undefined && !["public", "unlisted", "private"].includes(input.visibility)) {
    throw new DomainError("INVALID_REQUEST", "Unsupported visibility filter.", { field: "visibility" });
  }

  const q = input.q?.trim();
  return {
    ...input,
    ...(q === undefined ? {} : { q }),
    tags,
  };
}

function queryFingerprint(query: ArtifactDiscoveryQuery): string {
  const filters = {
    callerId: query.callerId,
    q: query.q ?? null,
    tags: [...query.tags].sort(),
    visibility: query.visibility ?? null,
    limit: query.limit,
    sort: query.sort,
    direction: query.direction,
  };
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex");
}

function encodeCursor(cursor: { fingerprint: string; sortValue: string; id: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

function decodeCursor(
  value: string,
  fingerprint: string,
  sort: ArtifactDiscoveryQuery["sort"],
): ArtifactDiscoveryCursorPosition {
  try {
    if (value.length > 1024) throw new Error();
    const json = Buffer.from(value, "base64url");
    if (json.toString("base64url") !== value) throw new Error();
    const payload: unknown = JSON.parse(json.toString("utf8"));
    if (
      payload === null
      || typeof payload !== "object"
      || Array.isArray(payload)
      || Object.keys(payload).sort().join(",") !== "fingerprint,id,sortValue,v"
    ) {
      throw new Error();
    }
    const cursor = payload as { v: unknown; fingerprint: unknown; sortValue: unknown; id: unknown };
    if (
      cursor.v !== 1
      || cursor.fingerprint !== fingerprint
      || typeof cursor.sortValue !== "string"
      || cursor.sortValue.length === 0
      || cursor.sortValue.length > 256
      || typeof cursor.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)
      || (sort === "name" && cursor.sortValue.length > 200)
      || (sort !== "name" && !/^-?\d+(?:\.\d+)?$/.test(cursor.sortValue))
    ) {
      throw new Error();
    }
    return { sortValue: cursor.sortValue, id: cursor.id };
  } catch {
    throw new DomainError("INVALID_REQUEST", "Cursor is invalid or does not match the discovery filters.", { field: "cursor" });
  }
}
