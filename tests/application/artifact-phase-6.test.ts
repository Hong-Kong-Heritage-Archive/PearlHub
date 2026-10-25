import { describe, expect, it, vi } from "vitest";
import { DraftWorkflowService, UpdateArtifactMetadataService } from "../../src/application/services.js";
import { Artifact } from "../../src/domain/artifact.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import { Dependency } from "../../src/domain/dependency.js";
import type { DependencyResolution } from "../../src/domain/records.js";
import type {
  ArtifactDiscoveryRepository,
  ArtifactRepository,
  ArtifactVersionRepository,
  DependencyRepository,
  DraftRepository,
  TransactionManager,
} from "../../src/ports/repositories.js";

const now = new Date("2026-04-01T12:00:00.000Z");

function artifactFixture(visibility: "private" | "unlisted" | "public" = "private") {
  return Artifact.create({
    id: "source-artifact",
    ownerId: "owner",
    name: "Immutable name",
    slug: "immutable-slug",
    visibility,
    createdAt: now,
  });
}

describe("Phase 6 Artifact metadata and dependency reads", () => {
  it("updates owner visibility only without creating or mutating versions", async () => {
    const artifact = artifactFixture();
    const save = vi.fn(async (_artifact: Artifact) => {});
    const artifactRepo: ArtifactRepository = {
      findById: async () => artifact,
      findByIds: async () => [],
      findTombstoneSnapshotArtifact: async () => null,
      findByOwnerAndSlug: async () => null,
      create: async () => {},
      save,
      tombstone: async () => {},
      restore: async () => null,
    };
    const transactions: TransactionManager = { run: async (work) => work() };
    const service = new UpdateArtifactMetadataService(
      artifactRepo,
      { canRead: async () => false, canWrite: async (actorId, value) => value.ownerId === actorId },
      { now: () => new Date("2026-04-02T12:00:00.000Z") },
      transactions,
    );

    const updated = await service.execute({ actorId: "owner", artifactId: artifact.id, visibility: "public" });

    expect(updated.snapshot()).toMatchObject({
      id: artifact.id,
      ownerId: artifact.ownerId,
      name: artifact.name,
      slug: artifact.slug,
      visibility: "public",
      status: "active",
    });
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0].updatedAt).toEqual(new Date("2026-04-02T12:00:00.000Z"));
  });

  it("forbids a non-owner and rejects missing or tombstoned Artifacts", async () => {
    const existing = artifactFixture();
    let current: Artifact | null = existing;
    const artifactRepo: ArtifactRepository = {
      findById: async () => current,
      findByIds: async () => [],
      findTombstoneSnapshotArtifact: async () => null,
      findByOwnerAndSlug: async () => null,
      create: async () => {},
      save: async () => {},
      tombstone: async () => {},
      restore: async () => null,
    };
    const service = new UpdateArtifactMetadataService(
      artifactRepo,
      { canRead: async () => false, canWrite: async (actorId, value) => value.ownerId === actorId },
      { now: () => now },
    );

    await expect(service.execute({ actorId: "other", artifactId: existing.id, visibility: "public" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    current = existing.tombstone(now);
    await expect(service.execute({ actorId: "owner", artifactId: existing.id, visibility: "public" }))
      .rejects.toMatchObject({ code: "ARTIFACT_GONE" });
    current = null;
    await expect(service.execute({ actorId: "owner", artifactId: existing.id, visibility: "public" }))
      .rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
  });

  it("returns declarations and only persisted resolution history for the exact readable Version", async () => {
    const artifact = artifactFixture("public");
    const sourceV1 = ArtifactVersion.create({
      id: "source-v1", artifactId: artifact.id, version: "1.0.0", contentHash: "hash-1",
      contentLocation: "loc-1", createdAt: now, publishedAt: now,
    });
    const sourceV2 = ArtifactVersion.create({
      id: "source-v2", artifactId: artifact.id, version: "2.0.0", contentHash: "hash-2",
      contentLocation: "loc-2", createdAt: now, publishedAt: now,
    });
    const resolved = ArtifactVersion.create({
      id: "target-v3", artifactId: "target-artifact", version: "3.2.1", contentHash: "target-hash",
      contentLocation: "target-loc", createdAt: now, publishedAt: now,
    });
    const declaration = Dependency.create({
      id: "dependency-1", artifactVersionId: sourceV1.id, targetArtifactId: resolved.artifactId,
      declaredRange: "^3.0.0", createdAt: now,
    });
    const unresolvedDeclaration = Dependency.create({
      id: "dependency-2", artifactVersionId: sourceV1.id, targetArtifactId: "other-target",
      declaredRange: "~1.0.0", createdAt: now,
    });
    const resolution: DependencyResolution = {
      id: "resolution-1", dependencyId: declaration.id, resolvedArtifactVersionId: resolved.id, resolvedAt: now,
    };
    const versions: ArtifactVersionRepository = {
      findById: async (id) => id === resolved.id ? resolved : null,
      findByArtifactAndVersion: async (artifactId, version) =>
        artifactId === artifact.id && version === "1.0.0" ? sourceV1
          : artifactId === artifact.id && version === "2.0.0" ? sourceV2 : null,
      findForArtifact: async () => [sourceV1, sourceV2],
      findLatest: async () => sourceV2,
      lockArtifactForWrite: async () => true,
      create: async () => {},
    };
    const findForVersion = vi.fn(async (versionId: string) => versionId === sourceV1.id ? [declaration, unresolvedDeclaration] : []);
    const findResolutions = vi.fn(async (dependencyId: string) => dependencyId === declaration.id ? [resolution] : []);
    const createResolution = vi.fn(async () => {});
    const dependencies: DependencyRepository = {
      findForVersion,
      create: async () => {},
      createResolution,
      findResolutions,
    };
    const artifacts: ArtifactRepository = {
      findById: async () => artifact,
      findByIds: async () => [],
      findTombstoneSnapshotArtifact: async () => null,
      findByOwnerAndSlug: async () => null,
      create: async () => {},
      save: async () => {},
      tombstone: async () => {},
      restore: async () => null,
    };
    const drafts: DraftRepository = {
      findActiveByOwner: async () => [],
      findById: async () => null,
      findByIdForUpdate: async () => null,
      create: async () => {},
      save: async () => {},
    };
    const discovery: ArtifactDiscoveryRepository = {
      findPage: async () => ({ rows: [], hasMore: false }),
      findArtifactIdsAfter: async () => [],
      replaceTagProjection: async () => {},
      clearTagProjections: async () => {},
      isReady: async () => true,
      setReady: async () => {},
    };
    const service = new DraftWorkflowService(
      drafts,
      artifacts,
      versions,
      dependencies,
      { canRead: async () => true, canWrite: async () => true },
      discovery,
      { run: async (work) => work() },
    );

    await expect(service.getVersionDependencies({ actorId: null, artifactId: artifact.id, version: "1.0.0" }))
      .resolves.toEqual({
        artifactId: artifact.id,
        version: "1.0.0",
        dependencies: [{
          targetArtifactId: "target-artifact",
          declaredRange: "^3.0.0",
          resolutions: [{ version: "3.2.1", resolvedAt: now }],
        }, {
          targetArtifactId: "other-target",
          declaredRange: "~1.0.0",
          resolutions: [],
        }],
      });
    await expect(service.getVersionDependencies({ actorId: null, artifactId: artifact.id, version: "2.0.0" }))
      .resolves.toEqual({ artifactId: artifact.id, version: "2.0.0", dependencies: [] });
    expect(findForVersion).toHaveBeenNthCalledWith(1, sourceV1.id);
    expect(findForVersion).toHaveBeenNthCalledWith(2, sourceV2.id);
    expect(findResolutions).toHaveBeenCalledTimes(2);
    expect(createResolution).not.toHaveBeenCalled();
  });

  it("does not expose private dependencies to anonymous callers or substitute a missing Version", async () => {
    const artifact = artifactFixture("private");
    const version = ArtifactVersion.create({
      id: "private-v1", artifactId: artifact.id, version: "1.0.0", contentHash: "hash",
      contentLocation: "loc", createdAt: now, publishedAt: now,
    });
    const dependencies: DependencyRepository = {
      findForVersion: async () => [],
      create: async () => {},
      createResolution: async () => {},
      findResolutions: async () => [],
    };
    const versions: ArtifactVersionRepository = {
      findById: async () => null,
      findByArtifactAndVersion: async (_artifactId, versionText) => versionText === "1.0.0" ? version : null,
      findForArtifact: async () => [],
      findLatest: async () => null,
      lockArtifactForWrite: async () => true,
      create: async () => {},
    };
    const artifacts: ArtifactRepository = {
      findById: async () => artifact,
      findByIds: async () => [],
      findTombstoneSnapshotArtifact: async () => null,
      findByOwnerAndSlug: async () => null,
      create: async () => {},
      save: async () => {},
      tombstone: async () => {},
      restore: async () => null,
    };
    const drafts: DraftRepository = {
      findActiveByOwner: async () => [],
      findById: async () => null,
      findByIdForUpdate: async () => null,
      create: async () => {},
      save: async () => {},
    };
    const discovery: ArtifactDiscoveryRepository = {
      findPage: async () => ({ rows: [], hasMore: false }),
      findArtifactIdsAfter: async () => [],
      replaceTagProjection: async () => {},
      clearTagProjections: async () => {},
      isReady: async () => true,
      setReady: async () => {},
    };
    const service = new DraftWorkflowService(
      drafts, artifacts, versions, dependencies,
      { canRead: async () => false, canWrite: async () => false },
      discovery,
      { run: async (work) => work() },
    );

    await expect(service.getVersionDependencies({ actorId: null, artifactId: artifact.id, version: "1.0.0" }))
      .rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
    await expect(service.getVersionDependencies({ actorId: "other", artifactId: artifact.id, version: "1.0.0" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.getVersionDependencies({ actorId: "owner", artifactId: artifact.id, version: "9.9.9" }))
      .rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
  });
});
