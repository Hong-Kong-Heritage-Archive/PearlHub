import { describe, expect, it, vi } from "vitest";
import { DraftWorkflowService, UpdateArtifactMetadataService } from "../../src/application/services.js";
import { Artifact } from "../../src/domain/artifact.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import { Dependency } from "../../src/domain/dependency.js";
import type { CompatibilityReport, DependencyResolution } from "../../src/domain/records.js";
import type {
  ArtifactDiscoveryRepository,
  ArtifactRepository,
  ArtifactVersionRepository,
  CompatibilityReportRepository,
  DependencyRepository,
  DraftRepository,
  TransactionManager,
  TransactionOptions,
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

  it("returns declarations, resolutions, and reports only for the exact readable Version", async () => {
    const artifact = artifactFixture("public");
    let targetArtifact = Artifact.create({
      id: "target-artifact",
      ownerId: "target-owner",
      name: "Target Pearl",
      slug: "target-pearl",
      visibility: "public",
      createdAt: now,
    });
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
    const privateTargetArtifact = Artifact.create({
      id: "private-target-artifact",
      ownerId: "private-target-owner",
      name: "Private Target",
      slug: "private-target",
      visibility: "private",
      createdAt: now,
    });
    const privateResolved = ArtifactVersion.create({
      id: "private-target-v4", artifactId: privateTargetArtifact.id, version: "4.1.0",
      contentHash: "private-target-hash", contentLocation: "private-target-loc",
      createdAt: now, publishedAt: now,
    });
    const declaration = Dependency.create({
      id: "dependency-1", artifactVersionId: sourceV1.id, targetArtifactId: resolved.artifactId,
      declaredRange: "^3.0.0", createdAt: now,
    });
    const privateDeclaration = Dependency.create({
      id: "dependency-private", artifactVersionId: sourceV1.id, targetArtifactId: privateTargetArtifact.id,
      declaredRange: "^4.0.0", createdAt: now,
    });
    const unresolvedDeclaration = Dependency.create({
      id: "dependency-2", artifactVersionId: sourceV1.id, targetArtifactId: "other-target",
      declaredRange: "~1.0.0", createdAt: now,
    });
    const resolution: DependencyResolution = {
      id: "resolution-1", dependencyId: declaration.id, runId: null, resolvedArtifactVersionId: resolved.id, resolvedAt: now,
    };
    const versions: ArtifactVersionRepository = {
      findById: async (id) => id === resolved.id ? resolved : id === privateResolved.id ? privateResolved : null,
      findByArtifactAndVersion: async (artifactId, version) =>
        artifactId === artifact.id && version === "1.0.0" ? sourceV1
          : artifactId === artifact.id && version === "2.0.0" ? sourceV2 : null,
      findForArtifact: async () => [sourceV1, sourceV2],
      findLatest: async () => sourceV2,
      lockArtifactForWrite: async () => true,
      create: async () => {},
    };
    const privateResolution: DependencyResolution = {
      id: "private-resolution", dependencyId: privateDeclaration.id, runId: null,
      resolvedArtifactVersionId: privateResolved.id, resolvedAt: now,
    };
    const findForVersion = vi.fn(async (versionId: string) =>
      versionId === sourceV1.id ? [declaration, privateDeclaration, unresolvedDeclaration] : []);
    const findResolutions = vi.fn(async (dependencyId: string) =>
      dependencyId === declaration.id ? [resolution]
        : dependencyId === privateDeclaration.id ? [privateResolution] : []);
    const createResolution = vi.fn(async () => {});
    const dependencies: DependencyRepository = {
      findForVersion,
      create: async () => {},
      createResolution,
      createResolutionForRun: async () => {},
      findResolutions,
    };
    const report: CompatibilityReport = {
      id: "report-1",
      artifactVersionId: sourceV1.id,
      targetArtifactVersionId: resolved.id,
      status: "compatible",
      report: { details: { warning: null } },
      createdAt: now,
    };
    const reportWithoutTarget: CompatibilityReport = {
      id: "report-without-target",
      artifactVersionId: sourceV1.id,
      targetArtifactVersionId: null,
      status: "compatible",
      report: { targetDerived: "must-not-leak" },
      createdAt: now,
    };
    let storedReports = [report];
    const findReports = vi.fn(async (versionId: string) => versionId === sourceV1.id ? storedReports : []);
    const compatibilityReports: CompatibilityReportRepository = {
      create: async () => {},
      findForArtifactVersion: findReports,
    };
    const artifacts: ArtifactRepository = {
      findById: async (id) => id === artifact.id ? artifact
        : id === targetArtifact.id ? targetArtifact
          : id === privateTargetArtifact.id ? privateTargetArtifact : null,
      findByIds: async (ids) => ids.flatMap((id) => id === targetArtifact.id ? [targetArtifact]
        : id === privateTargetArtifact.id ? [privateTargetArtifact] : []),
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
    const transactionOptions: Array<TransactionOptions | undefined> = [];
    const service = new DraftWorkflowService(
      drafts,
      artifacts,
      versions,
      dependencies,
      {
        canRead: async (actorId, value) => value.visibility === "public" || value.ownerId === actorId,
        canWrite: async () => true,
      },
      discovery,
      {
        run: async (work, options) => {
          transactionOptions.push(options);
          return work();
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      compatibilityReports,
    );

    await expect(service.getVersionDependencies({ actorId: null, artifactId: artifact.id, version: "1.0.0" }))
      .resolves.toEqual({
        artifactId: artifact.id,
        version: "1.0.0",
        dependencies: [{
          targetArtifactId: "target-artifact",
          declaredRange: "^3.0.0",
          resolutionState: "available",
          resolutions: [{ version: "3.2.1", resolvedAt: now }],
        }, {
          targetArtifactId: "private-target-artifact",
          declaredRange: "^4.0.0",
          resolutionState: "redacted",
          resolutions: [],
        }, {
          targetArtifactId: "other-target",
          declaredRange: "~1.0.0",
          resolutionState: "none",
          resolutions: [],
        }],
      });
    await expect(service.getVersionDependencies({ actorId: null, artifactId: artifact.id, version: "2.0.0" }))
      .resolves.toEqual({ artifactId: artifact.id, version: "2.0.0", dependencies: [] });
    expect(findForVersion).toHaveBeenNthCalledWith(1, sourceV1.id);
    expect(findForVersion).toHaveBeenNthCalledWith(2, sourceV2.id);
    expect(findResolutions).toHaveBeenCalledTimes(3);
    expect(createResolution).not.toHaveBeenCalled();
    await expect(service.getVersionCompatibilityReports({
      actorId: null,
      artifactId: artifact.id,
      version: "1.0.0",
    })).resolves.toEqual([{ ...report, availability: "available" }]);
    await expect(service.getVersionCompatibilityReports({
      actorId: null,
      artifactId: artifact.id,
      version: "2.0.0",
    })).resolves.toEqual([]);
    expect(findReports).toHaveBeenNthCalledWith(1, sourceV1.id);
    expect(findReports).toHaveBeenNthCalledWith(2, sourceV2.id);
    expect(transactionOptions.length).toBeGreaterThan(0);
    expect(transactionOptions.every((options) =>
      options?.isolationLevel === "repeatable read" && options.readOnly === true,
    )).toBe(true);

    targetArtifact = Artifact.create({
      id: "target-artifact",
      ownerId: "target-owner",
      name: "Target Pearl",
      slug: "target-pearl",
      visibility: "private",
      createdAt: now,
    });
    await expect(service.getVersionDependencies({
      actorId: null,
      artifactId: artifact.id,
      version: "1.0.0",
    })).resolves.toMatchObject({
      dependencies: expect.arrayContaining([{
        targetArtifactId: "target-artifact",
        declaredRange: "^3.0.0",
        resolutionState: "redacted",
        resolutions: [],
      }]),
    });
    await expect(service.getVersionDependencies({
      actorId: "target-owner",
      artifactId: artifact.id,
      version: "1.0.0",
    })).resolves.toMatchObject({
      dependencies: expect.arrayContaining([expect.objectContaining({
        resolutionState: "available",
        resolutions: expect.arrayContaining([expect.objectContaining({ version: "3.2.1" })]),
      })]),
    });
    await expect(service.getVersionCompatibilityReports({
      actorId: null,
      artifactId: artifact.id,
      version: "1.0.0",
    })).resolves.toMatchObject([{
      availability: "redacted",
      targetArtifactVersionId: null,
      status: "unavailable",
      report: {},
    }]);
    await expect(service.getVersionCompatibilityReports({
      actorId: "target-owner",
      artifactId: artifact.id,
      version: "1.0.0",
    })).resolves.toMatchObject([{
      availability: "available",
      targetArtifactVersionId: resolved.id,
      status: "compatible",
      report: { details: { warning: null } },
    }]);

    targetArtifact = Artifact.create({
      id: "target-artifact",
      ownerId: "target-owner",
      name: "Target Pearl",
      slug: "target-pearl",
      visibility: "unlisted",
      createdAt: now,
    });
    await expect(service.getVersionDependencies({
      actorId: "owner",
      artifactId: artifact.id,
      version: "1.0.0",
    })).resolves.toMatchObject({
      dependencies: expect.arrayContaining([
        expect.objectContaining({ resolutionState: "redacted", resolutions: [] }),
      ]),
    });

    targetArtifact = targetArtifact.tombstone(now);
    await expect(service.getVersionDependencies({
      actorId: "target-owner",
      artifactId: artifact.id,
      version: "1.0.0",
    })).resolves.toMatchObject({
      dependencies: expect.arrayContaining([
        expect.objectContaining({ resolutionState: "redacted", resolutions: [] }),
      ]),
    });
    await expect(service.getVersionCompatibilityReports({
      actorId: "target-owner",
      artifactId: artifact.id,
      version: "1.0.0",
    })).resolves.toMatchObject([{
      availability: "redacted",
      targetArtifactVersionId: null,
      status: "unavailable",
      report: {},
    }]);

    storedReports = [reportWithoutTarget];
    await expect(service.getVersionCompatibilityReports({
      actorId: "target-owner",
      artifactId: artifact.id,
      version: "1.0.0",
    })).resolves.toMatchObject([{
      id: "report-without-target",
      targetArtifactVersionId: null,
      status: "unavailable",
      report: {},
      availability: "redacted",
    }]);
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
      createResolutionForRun: async () => {},
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
