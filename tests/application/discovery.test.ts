import { describe, expect, it } from "vitest";
import { ListArtifactsService, RebuildArtifactDiscoveryIndexService } from "../../src/application/discovery.js";
import { parseArtifactDiscoveryQuery } from "../../src/contracts/discovery.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import type { ArtifactDiscoveryPageRow } from "../../src/domain/discovery.js";
import type {
  ArtifactContentStore,
  ArtifactDiscoveryRepository,
  ArtifactVersionRepository,
  DiscoveryReindexLock,
  TransactionManager,
} from "../../src/ports/repositories.js";

const createdAt = new Date("2026-01-01T00:00:00.000Z");

function discoveryRepository(overrides: Partial<ArtifactDiscoveryRepository> = {}): ArtifactDiscoveryRepository {
  return {
    findPage: async () => ({ rows: [], hasMore: false }),
    findArtifactIdsAfter: async () => [],
    replaceTagProjection: async () => {},
    clearTagProjections: async () => {},
    isReady: async () => true,
    setReady: async () => {},
    ...overrides,
  };
}

describe("Artifact discovery query parsing", () => {
  it("trims q and parses repeated tags, limit, sort, direction, and visibility", () => {
    expect(parseArtifactDiscoveryQuery(
      new URLSearchParams("q=%20Pearl%20&tag=rag&tag=language-model&limit=50&sort=name&order=asc&visibility=private"),
      "owner-1",
    )).toEqual({
      callerId: "owner-1",
      q: "Pearl",
      tags: ["rag", "language-model"],
      limit: 50,
      sort: "name",
      direction: "asc",
      visibility: "private",
    });
  });

  it("rejects invalid, duplicate, unknown, or out-of-range query parameters", () => {
    for (const query of [
      "q=%20",
      "q=word&limit=101",
      "limit=1.5",
      "sort=ownerId",
      "tag=duplicate&tag=%20DUPLICATE",
      "cursor=a&cursor=b",
      "other=value",
    ]) {
      expect(() => parseArtifactDiscoveryQuery(new URLSearchParams(query), null), query).toThrow();
    }
  });
});

describe("ListArtifactsService", () => {
  it("creates an opaque cursor from the last row and rejects cursors from different filters", async () => {
    const rows: ArtifactDiscoveryPageRow[] = [{
      item: {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Pearl",
        slug: "pearl",
        visibility: "public",
        tags: ["rag"],
        createdAt,
        updatedAt: createdAt,
      },
      sortValue: "1767225600.000000",
    }];
    const calls: Array<Parameters<ArtifactDiscoveryRepository["findPage"]>[0]> = [];
    const service = new ListArtifactsService(discoveryRepository({
      findPage: async (input) => {
        calls.push(input);
        return { rows, hasMore: calls.length === 1 };
      },
    }));
    const query = parseArtifactDiscoveryQuery(new URLSearchParams("q=pearl&tag=rag&limit=1"), null);
    const firstPage = await service.execute(query);

    expect(firstPage.items).toEqual(rows.map((row) => row.item));
    expect(firstPage.nextCursor).toBeTruthy();
    expect(firstPage.nextCursor).not.toContain("pearl");

    const secondPage = await service.execute({ ...query, cursor: firstPage.nextCursor! });
    expect(secondPage.nextCursor).toBeNull();
    expect(calls[1]?.after).toEqual({ sortValue: "1767225600.000000", id: rows[0]!.item.id });
    await expect(service.execute({ ...query, q: "other", cursor: firstPage.nextCursor! })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});

describe("RebuildArtifactDiscoveryIndexService", () => {
  it("reindexes each Artifact's highest SemVer content before marking discovery ready", async () => {
    const version = ArtifactVersion.create({
      id: "version-1",
      artifactId: "artifact-1",
      version: "10.0.0",
      contentHash: "hash",
      contentLocation: "location",
      createdAt,
      publishedAt: createdAt,
    });
    let ready = false;
    let latestVersion: ArtifactVersion | null = version;
    const projections: Array<{ artifactId: string; versionId: string | null; tags: string[] }> = [];
    const discovery = discoveryRepository({
      findArtifactIdsAfter: async (afterId) => afterId === null ? ["artifact-1"] : [],
      replaceTagProjection: async (artifactId, versionId, tags) => { projections.push({ artifactId, versionId, tags }); },
      isReady: async () => ready,
      setReady: async (value) => { ready = value; },
    });
    const versions: ArtifactVersionRepository = {
      findById: async () => null,
      findByArtifactAndVersion: async () => null,
      findForArtifact: async () => [],
      findLatest: async () => latestVersion,
      lockArtifactForWrite: async () => true,
      create: async () => {},
    };
    const contentStore: ArtifactContentStore = {
      put: async () => "location",
      get: async () => '{"tags":[" Pearl-Tag "]}',
      exists: async () => true,
    };
    const transactions: TransactionManager = { run: async (work) => work() };
    let lockRuns = 0;
    const lock: DiscoveryReindexLock = {
      runExclusive: async (work) => { lockRuns += 1; return work(); },
    };

    await new RebuildArtifactDiscoveryIndexService(discovery, versions, contentStore, transactions, lock).execute();
    expect(projections).toEqual([{ artifactId: "artifact-1", versionId: "version-1", tags: ["pearl-tag"] }]);
    expect(ready).toBe(true);
    expect(lockRuns).toBe(1);

    latestVersion = null;
    await new RebuildArtifactDiscoveryIndexService(discovery, versions, contentStore, transactions, lock).execute();
    expect(lockRuns).toBe(2);
  });

  it("keeps discovery unavailable when version content cannot be read", async () => {
    const versions = {
      findLatest: async () => ArtifactVersion.create({
        id: "version-1",
        artifactId: "artifact-1",
        version: "1.0.0",
        contentHash: "hash",
        contentLocation: "missing",
        createdAt,
        publishedAt: createdAt,
      }),
      lockArtifactForWrite: async () => true,
    } as unknown as ArtifactVersionRepository;
    const contentStore: ArtifactContentStore = {
      put: async () => "location",
      get: async () => null,
      exists: async () => false,
    };
    let ready = false;
    const stateRepository = discoveryRepository({
      findArtifactIdsAfter: async (afterId) => afterId === null ? ["artifact-1"] : [],
      isReady: async () => ready,
      setReady: async (value) => { ready = value; },
    });
    const transactions: TransactionManager = { run: async (work) => work() };
    const lock: DiscoveryReindexLock = { runExclusive: async (work) => work() };

    await expect(new RebuildArtifactDiscoveryIndexService(stateRepository, versions, contentStore, transactions, lock).execute())
      .rejects.toThrow("Content for Artifact Version");
    expect(ready).toBe(false);
  });
});
