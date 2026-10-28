import { describe, expect, it } from "vitest";
import { Artifact } from "../../src/domain/artifact.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import { Dependency } from "../../src/domain/dependency.js";
import type { CompatibilityReport, DependencyResolution } from "../../src/domain/records.js";
import { CreateCompatibilityReportService, DeleteArtifactService, PublishVersionService, ResolveDependencyService, RestoreArtifactService } from "../../src/application/services.js";
import type { ArtifactDiscoveryRepository, ArtifactRepository, ArtifactVersionRepository, CompatibilityReportRepository, DependencyRepository, LineageRepository, TransactionManager } from "../../src/ports/repositories.js";

const fixedTime = new Date("2026-01-01T00:00:00Z");
const sourceArtifact = Artifact.create({ id: "source", ownerId: "owner", name: "Source", slug: "source", visibility: "public", createdAt: fixedTime });
const sourceVersion = (id: string, version: string, artifactId = "source") => ArtifactVersion.create({ id, artifactId, version, contentHash: `sha256:${id}`, contentLocation: id, createdAt: fixedTime, publishedAt: fixedTime });

function copyServices() {
  const artifacts: Artifact[] = [];
  const versions: ArtifactVersion[] = [];
  const projections: Array<{ artifactId: string; versionId: string | null; tags: string[] }> = [];
  const lineages: Array<{ parent: string; child: string; sourceVersion: string | null }> = [];
  const content = new Map([["source-location", '{"knowledge":[],"skill":{},"tags":[" RAG "]}']]);
  const storedContent: string[] = [];
  const artifactRepo: ArtifactRepository = {
    findById: async (id) => id === sourceArtifact.id ? sourceArtifact : null,
    findByIds: async (ids) => ids.includes(sourceArtifact.id) ? [sourceArtifact] : [],
    findTombstoneSnapshotArtifact: async () => null,
    findByOwnerAndSlug: async () => null,
    create: async (artifact) => { artifacts.push(artifact); },
    save: async () => {},
    tombstone: async () => {},
    restore: async () => null,
  };
  const versionRepo: ArtifactVersionRepository = {
    findById: async () => null,
    findByArtifactAndVersion: async () => null,
    lockArtifactForWrite: async () => true,
    findForArtifact: async () => [],
    findLatest: async (artifactId) => versions.filter((version) => version.artifactId === artifactId).at(-1) ?? sourceVersionWithLocation,
    create: async (version) => { versions.push(version); },
  };
  const sourceVersionWithLocation = ArtifactVersion.create({ ...sourceVersion("source-v1", "1.2.0").snapshot(), contentLocation: "source-location" });
  const sourceDependencies = [
    Dependency.create({ id: "source-dependency-a", artifactVersionId: sourceVersionWithLocation.id, targetArtifactId: "pearl-a", declaredRange: "^2.1.0", createdAt: fixedTime }),
    Dependency.create({ id: "source-dependency-b", artifactVersionId: sourceVersionWithLocation.id, targetArtifactId: "pearl-b", declaredRange: "^1.4.0", createdAt: fixedTime }),
  ];
  const dependencies = [...sourceDependencies];
  const sourceResolutions: DependencyResolution[] = [{ id: "source-resolution", dependencyId: "source-dependency-a", resolvedArtifactVersionId: "pearl-a-v243", resolvedAt: fixedTime }];
  const createdResolutions: DependencyResolution[] = [];
  const dependencyRepo: DependencyRepository = {
    findForVersion: async (versionId) => dependencies.filter((dependency) => dependency.artifactVersionId === versionId),
    create: async (dependency) => { dependencies.push(dependency); },
    createResolution: async (resolution) => { createdResolutions.push(resolution); },
    findResolutions: async (dependencyId) => sourceResolutions.filter((resolution) => resolution.dependencyId === dependencyId),
  };
  const store = {
    put: async (value: string, hash: string) => { storedContent.push(value); content.set(hash, value); return hash; },
    get: async (location: string) => content.get(location) ?? null,
    exists: async (hash: string) => content.has(hash),
  };
  const access = { canRead: async () => true, canWrite: async () => true };
  const lineageRepo: LineageRepository = {
    createFork: async (parentArtifactId, childArtifactId, sourceVersionId) => {
      lineages.push({ parent: parentArtifactId, child: childArtifactId, sourceVersion: sourceVersionId ?? null });
      return { id: "lineage", parentArtifactId, childArtifactId, sourceVersionId: sourceVersionId ?? null, relationshipType: "fork", createdAt: fixedTime };
    },
    getParents: async () => [],
    getChildren: async () => [],
  };
  const ids = { next: (() => { let i = 0; return () => `new-${++i}`; })() };
  const discovery: ArtifactDiscoveryRepository = {
    findPage: async () => ({ rows: [], hasMore: false }),
    findArtifactIdsAfter: async () => [],
    replaceTagProjection: async (artifactId, versionId, tags) => { projections.push({ artifactId, versionId, tags }); },
    clearTagProjections: async () => { projections.splice(0); },
    isReady: async () => true,
    setReady: async () => {},
  };
  const transactions: TransactionManager = { run: async (work) => work() };
  return { artifacts, versions, projections, lineages, dependencies, sourceDependencies, sourceResolutions, createdResolutions, storedContent, sourceVersionWithLocation, artifactRepo, versionRepo, dependencyRepo, store, access, lineageRepo, ids, discovery, transactions };
}

describe("dependency resolution", () => {
  it("selects the highest compatible version and records its version identity", async () => {
    const candidates = [sourceVersion("v210", "2.1.0"), sourceVersion("v243", "2.4.3"), sourceVersion("v300", "3.0.0")];
    const versionRepo = { findForArtifact: async () => candidates } as unknown as ArtifactVersionRepository;
    const saved: unknown[] = [];
    const dependencyRepo = { createResolution: async (record: unknown) => { saved.push(record); } } as unknown as DependencyRepository;
    const dependency = Dependency.create({ id: "dependency", artifactVersionId: "source-version", targetArtifactId: "source", declaredRange: "^2.1.0", createdAt: fixedTime });
    const service = new ResolveDependencyService(dependencyRepo, versionRepo, { next: () => "resolution" }, { now: () => fixedTime });
    const result = await service.execute({ dependencies: [dependency] });

    expect(result[0]?.resolvedArtifactVersionId).toBe("v243");
    expect(saved).toEqual(result);
    expect(sourceArtifact.name).toBe("Source");
  });

  it("uses SemVer ordering and only resolves versions of the declared target Artifact", async () => {
    const candidates = [
      sourceVersion("target-v190", "1.9.0", "target"),
      sourceVersion("target-v1100", "1.10.0", "target"),
      sourceVersion("target-v1100-rc", "1.10.0-rc.1", "target"),
      sourceVersion("target-v200", "2.0.0", "target"),
    ];
    const foreignVersion = sourceVersion("foreign-v1990", "1.99.0", "other-target");
    const queriedArtifacts: string[] = [];
    const versionRepo = {
      findForArtifact: async (artifactId: string) => {
        queriedArtifacts.push(artifactId);
        return artifactId === "target" ? candidates : [foreignVersion];
      },
    } as unknown as ArtifactVersionRepository;
    const saved: DependencyResolution[] = [];
    const dependencyRepo = { createResolution: async (record: DependencyResolution) => { saved.push(record); } } as unknown as DependencyRepository;
    const dependency = Dependency.create({
      id: "dependency",
      artifactVersionId: "source-version",
      targetArtifactId: "target",
      declaredRange: ">=1.9.0 <2.0.0",
      createdAt: fixedTime,
    });
    const versionSnapshots = candidates.map((version) => version.snapshot());
    const service = new ResolveDependencyService(dependencyRepo, versionRepo, { next: () => "resolution" }, { now: () => fixedTime });

    const result = await service.execute({ dependencies: [dependency] });

    expect(queriedArtifacts).toEqual(["target"]);
    expect(result[0]?.resolvedArtifactVersionId).toBe("target-v1100");
    expect(result[0]?.resolvedArtifactVersionId).not.toBe(foreignVersion.id);
    expect(dependency.declaredRange).toBe(">=1.9.0 <2.0.0");
    expect(candidates.map((version) => version.snapshot())).toEqual(versionSnapshots);
    expect(saved).toEqual(result);
  });

  it("does not persist partial resolution history when any dependency has no eligible version", async () => {
    const eligibleVersion = sourceVersion("target-v1", "1.0.0", "target");
    const versionRepo = {
      findForArtifact: async (artifactId: string) => artifactId === "target" ? [eligibleVersion] : [],
    } as unknown as ArtifactVersionRepository;
    const saved: DependencyResolution[] = [];
    const dependencyRepo = { createResolution: async (record: DependencyResolution) => { saved.push(record); } } as unknown as DependencyRepository;
    const resolvable = Dependency.create({
      id: "resolvable",
      artifactVersionId: "source-version",
      targetArtifactId: "target",
      declaredRange: "^1.0.0",
      createdAt: fixedTime,
    });
    const unresolved = Dependency.create({
      id: "unresolved",
      artifactVersionId: "source-version",
      targetArtifactId: "missing-target",
      declaredRange: "^4.0.0",
      createdAt: fixedTime,
    });
    const service = new ResolveDependencyService(dependencyRepo, versionRepo, { next: () => "resolution" }, { now: () => fixedTime });

    await expect(service.execute({ dependencies: [resolvable, unresolved] }))
      .rejects.toMatchObject({ code: "DEPENDENCY_RESOLUTION_FAILED" });

    expect(saved).toEqual([]);
  });

  describe("version tag projection", () => {
    it("normalizes tags into immutable published content and projects the latest version", async () => {
      const deps = copyServices();
      await new PublishVersionService(
        deps.artifactRepo,
        deps.versionRepo,
        deps.store,
        deps.dependencyRepo,
        deps.access,
        deps.discovery,
        deps.transactions,
        deps.ids,
        { now: () => fixedTime },
      ).execute({
        actorId: "owner",
        artifactId: "source",
        version: "2.0.0",
        content: { tags: [" Retrieval ", "RAG-Tools"] },
      });

      expect(deps.storedContent).toEqual([]);
      expect(deps.versions[0]?.contentSnapshot).toMatchObject({ content: { tags: ["retrieval", "rag-tools"] }, dependencies: [] });
      expect(deps.projections.at(-1)).toEqual({
        artifactId: "source",
        versionId: "new-1",
        tags: ["retrieval", "rag-tools"],
      });
    });

    it("rejects invalid tags before storing or persisting a version", async () => {
      const deps = copyServices();
      await expect(new PublishVersionService(
        deps.artifactRepo,
        deps.versionRepo,
        deps.store,
        deps.dependencyRepo,
        deps.access,
        deps.discovery,
        deps.transactions,
      ).execute({
        actorId: "owner",
        artifactId: "source",
        version: "2.0.0",
        content: { tags: ["duplicate", " DUPLICATE "] },
      })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(deps.storedContent).toHaveLength(0);
      expect(deps.versions).toHaveLength(0);
    });
  });
});

describe("compatibility report creation", () => {
  it("preserves report JSON and optional target Artifact Version references", async () => {
    const source = sourceVersion("report-source-version", "1.0.0");
    const target = sourceVersion("report-target-version", "2.0.0", "target");
    const versions = new Map([[source.id, source], [target.id, target]]);
    const versionRepo = {
      findById: async (id: string) => versions.get(id) ?? null,
    } as unknown as ArtifactVersionRepository;
    const saved: CompatibilityReport[] = [];
    const reportRepo: CompatibilityReportRepository = {
      create: async (report) => { saved.push(report); },
      findForArtifactVersion: async () => [],
    };
    const ids = { next: (() => { let index = 0; return () => `report-${++index}`; })() };
    const service = new CreateCompatibilityReportService(versionRepo, reportRepo, ids, { now: () => fixedTime });
    const report = {
      summary: "compatible",
      score: 0.875,
      enabled: false,
      checks: [{ name: "schema", passed: true, details: { labels: ["stable"], nullable: null } }],
    };

    const withoutTarget = await service.execute({ artifactVersionId: source.id, status: "compatible", report });
    const withTarget = await service.execute({
      artifactVersionId: source.id,
      targetArtifactVersionId: target.id,
      status: "incompatible",
      report,
    });

    expect(withoutTarget).toMatchObject({
      id: "report-1",
      artifactVersionId: source.id,
      targetArtifactVersionId: null,
      status: "compatible",
      report,
      createdAt: fixedTime,
    });
    expect(withTarget).toMatchObject({
      id: "report-2",
      artifactVersionId: source.id,
      targetArtifactVersionId: target.id,
      status: "incompatible",
      report,
      createdAt: fixedTime,
    });
    expect(saved).toEqual([withoutTarget, withTarget]);
  });

  it("rejects missing source or target versions without creating a report", async () => {
    const source = sourceVersion("report-source-version", "1.0.0");
    const versionRepo = {
      findById: async (id: string) => id === source.id ? source : null,
    } as unknown as ArtifactVersionRepository;
    const saved: CompatibilityReport[] = [];
    const reportRepo: CompatibilityReportRepository = {
      create: async (report) => { saved.push(report); },
      findForArtifactVersion: async () => [],
    };
    const service = new CreateCompatibilityReportService(versionRepo, reportRepo, { next: () => "report" }, { now: () => fixedTime });
    const validReport = { summary: "compatible" };

    await expect(service.execute({ artifactVersionId: "missing-source", status: "compatible", report: validReport }))
      .rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    await expect(service.execute({
      artifactVersionId: source.id,
      targetArtifactVersionId: "missing-target",
      status: "compatible",
      report: validReport,
    })).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    expect(saved).toEqual([]);
  });
});

describe("application transaction boundaries", () => {
  function transactionTracker() {
    let active = false;
    let runs = 0;
    const transactions: TransactionManager = {
      run: async <T>(work: () => Promise<T>) => {
        runs += 1;
        active = true;
        try { return await work(); } finally { active = false; }
      },
    };
    return { transactions, inTransaction: () => active, runCount: () => runs };
  }

  it("wraps PublishVersion and dependency resolutions", async () => {
    const publishDeps = copyServices();
    const publishTracker = transactionTracker();
    const publishWrites: boolean[] = [];
    const publishVersionCreate = publishDeps.versionRepo.create.bind(publishDeps.versionRepo);
    const publishDependencyCreate = publishDeps.dependencyRepo.create.bind(publishDeps.dependencyRepo);
    publishDeps.versionRepo.create = async (version) => { publishWrites.push(publishTracker.inTransaction()); await publishVersionCreate(version); };
    publishDeps.dependencyRepo.create = async (dependency) => { publishWrites.push(publishTracker.inTransaction()); await publishDependencyCreate(dependency); };
    const publishProjection = publishDeps.discovery.replaceTagProjection.bind(publishDeps.discovery);
    publishDeps.discovery.replaceTagProjection = async (...values) => { publishWrites.push(publishTracker.inTransaction()); await publishProjection(...values); };
    await new PublishVersionService(publishDeps.artifactRepo, publishDeps.versionRepo, publishDeps.store, publishDeps.dependencyRepo, publishDeps.access, publishDeps.discovery, publishTracker.transactions, publishDeps.ids, { now: () => fixedTime })
      .execute({ actorId: "owner", artifactId: "source", version: "1.3.0", content: {}, dependencies: [{ targetArtifactId: "pearl-a", declaredRange: "^2.0.0" }] });
    expect(publishTracker.runCount()).toBe(1);
    expect(publishWrites).toEqual([true, true, true]);

    const resolutionTracker = transactionTracker();
    const resolutionWrites: boolean[] = [];
    const resolutionRepo = { createResolution: async () => { resolutionWrites.push(resolutionTracker.inTransaction()); } } as unknown as DependencyRepository;
    const targetVersion = sourceVersion("target-v1", "1.2.0");
    const targetVersions = { findForArtifact: async () => [targetVersion] } as unknown as ArtifactVersionRepository;
    const dependency = Dependency.create({ id: "dependency", artifactVersionId: "source-v1", targetArtifactId: "source", declaredRange: "^1.0.0", createdAt: fixedTime });
    await new ResolveDependencyService(resolutionRepo, targetVersions, { next: () => "resolution" }, { now: () => fixedTime }, resolutionTracker.transactions).execute({ dependencies: [dependency] });
    expect(resolutionTracker.runCount()).toBe(1);
    expect(resolutionWrites).toEqual([true]);
  });
});

describe("Artifact lifecycle services", () => {
  it("creates one tombstone and reports Gone for a repeated delete", async () => {
    let current = sourceArtifact;
    let snapshotCount = 0;
    const artifacts: ArtifactRepository = {
      findById: async () => current,
      findByIds: async (ids) => ids.includes(current.id) ? [current] : [],
      findTombstoneSnapshotArtifact: async () => null,
      findByOwnerAndSlug: async () => null,
      create: async () => {},
      save: async () => {},
      tombstone: async (artifact) => {
        snapshotCount += 1;
        current = artifact;
      },
      restore: async () => null,
    };
    const service = new DeleteArtifactService(artifacts, { canRead: async () => true, canWrite: async () => false }, { now: () => fixedTime });

    await service.execute({ actorId: sourceArtifact.ownerId, artifactId: sourceArtifact.id });
    await expect(service.execute({ actorId: sourceArtifact.ownerId, artifactId: sourceArtifact.id })).rejects.toMatchObject({ code: "ARTIFACT_GONE" });
    expect(current.status).toBe("tombstone");
    expect(snapshotCount).toBe(1);
  });

  it("rejects deletion by a caller without write permission", async () => {
    const deps = copyServices();
    const service = new DeleteArtifactService(
      deps.artifactRepo,
      { canRead: async () => true, canWrite: async () => false },
      { now: () => fixedTime },
    );
    await expect(service.execute({ actorId: "other-user", artifactId: sourceArtifact.id }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("restores only when authorized and keeps the snapshot state as source of visibility", async () => {
    const deleted = sourceArtifact.tombstone(fixedTime);
    let current = deleted;
    const artifacts: ArtifactRepository = {
      findById: async () => current,
      findByIds: async (ids) => ids.includes(current.id) ? [current] : [],
      findTombstoneSnapshotArtifact: async () => sourceArtifact,
      findByOwnerAndSlug: async () => null,
      create: async () => {},
      save: async () => {},
      tombstone: async () => {},
      restore: async (artifact) => {
        current = artifact;
        return artifact;
      },
    };
    const service = new RestoreArtifactService(artifacts, { canRestore: async () => false }, { now: () => fixedTime });
    await expect(service.execute({ actorId: sourceArtifact.ownerId, artifactId: sourceArtifact.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    current = deleted;
    const restored = await new RestoreArtifactService(artifacts, { canRestore: async () => true }, { now: () => fixedTime })
      .execute({ actorId: "admin", artifactId: sourceArtifact.id });
    expect(restored.snapshot()).toMatchObject({ id: sourceArtifact.id, ownerId: sourceArtifact.ownerId, visibility: "public", status: "active" });
  });
});
