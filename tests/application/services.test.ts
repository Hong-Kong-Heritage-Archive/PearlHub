import { describe, expect, it } from "vitest";
import { Artifact } from "../../src/domain/artifact.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import { Dependency } from "../../src/domain/dependency.js";
import type { DependencyResolution } from "../../src/domain/records.js";
import { CloneArtifactService, ForkArtifactService, ImportGitHubService, ResolveDependencyService } from "../../src/application/services.js";
import type { ArtifactRepository, ArtifactVersionRepository, DependencyRepository, LineageRepository, ProvenanceRepository, TransactionManager } from "../../src/ports/repositories.js";

const fixedTime = new Date("2026-01-01T00:00:00Z");
const sourceArtifact = Artifact.create({ id: "source", ownerId: "owner", name: "Source", slug: "source", visibility: "public", createdAt: fixedTime });
const sourceVersion = (id: string, version: string) => ArtifactVersion.create({ id, artifactId: "source", version, contentHash: `sha256:${id}`, contentLocation: id, createdAt: fixedTime, publishedAt: fixedTime });

function copyServices() {
  const artifacts: Artifact[] = [];
  const versions: ArtifactVersion[] = [];
  const lineages: Array<{ parent: string; child: string }> = [];
  const content = new Map([["source-location", '{"knowledge":[],"skill":{}}']]);
  const storedContent: string[] = [];
  const artifactRepo: ArtifactRepository = {
    findById: async (id) => id === sourceArtifact.id ? sourceArtifact : null,
    findByOwnerAndSlug: async () => null,
    create: async (artifact) => { artifacts.push(artifact); },
    save: async () => {},
  };
  const versionRepo: ArtifactVersionRepository = {
    findById: async () => null,
    findByArtifactAndVersion: async () => null,
    findForArtifact: async () => [],
    findLatest: async () => sourceVersionWithLocation,
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
    createFork: async (parentArtifactId, childArtifactId) => {
      lineages.push({ parent: parentArtifactId, child: childArtifactId });
      return { id: "lineage", parentArtifactId, childArtifactId, relationshipType: "fork", createdAt: fixedTime };
    },
    getParents: async () => [],
    getChildren: async () => [],
  };
  const ids = { next: (() => { let i = 0; return () => `new-${++i}`; })() };
  return { artifacts, versions, lineages, dependencies, sourceDependencies, sourceResolutions, createdResolutions, storedContent, sourceVersionWithLocation, artifactRepo, versionRepo, dependencyRepo, store, access, lineageRepo, ids };
}

describe("copy services", () => {
  it("creates fork lineage without mutating the source", async () => {
    const deps = copyServices();
    const originalVersion = deps.sourceVersionWithLocation.snapshot();
    const service = new ForkArtifactService(deps.artifactRepo, deps.versionRepo, deps.store, deps.dependencyRepo, deps.lineageRepo, deps.access, deps.ids, { now: () => fixedTime });
    const child = await service.execute({ actorId: "owner", sourceArtifactId: "source", name: "Fork", slug: "fork" });

    expect(deps.lineages).toHaveLength(1);
    expect(deps.lineages[0]).toEqual({ parent: "source", child: child.id });
    expect(sourceArtifact.name).toBe("Source");
    expect(deps.versions[0]?.artifactId).toBe(child.id);
    const copiedDependencies = deps.dependencies.filter((dependency) => dependency.artifactVersionId === deps.versions[0]?.id);
    expect(copiedDependencies.map(({ targetArtifactId, declaredRange }) => ({ targetArtifactId, declaredRange }))).toEqual([
      { targetArtifactId: "pearl-a", declaredRange: "^2.1.0" },
      { targetArtifactId: "pearl-b", declaredRange: "^1.4.0" },
    ]);
    expect(copiedDependencies[0]?.id).not.toBe(deps.sourceDependencies[0]?.id);
    expect(deps.sourceDependencies.map((dependency) => dependency.snapshot())).toMatchObject([
      { artifactVersionId: "source-v1", targetArtifactId: "pearl-a", declaredRange: "^2.1.0" },
      { artifactVersionId: "source-v1", targetArtifactId: "pearl-b", declaredRange: "^1.4.0" },
    ]);
    expect(deps.sourceResolutions).toHaveLength(1);
    expect(deps.createdResolutions).toHaveLength(0);
    expect((await Promise.all(copiedDependencies.map((dependency) => deps.dependencyRepo.findResolutions(dependency.id)))).flat()).toHaveLength(0);
    expect(deps.sourceVersionWithLocation.snapshot()).toEqual(originalVersion);
  });

  it("clones content without creating lineage", async () => {
    const deps = copyServices();
    const originalVersion = deps.sourceVersionWithLocation.snapshot();
    const service = new CloneArtifactService(deps.artifactRepo, deps.versionRepo, deps.store, deps.dependencyRepo, deps.access, deps.ids, { now: () => fixedTime });
    await service.execute({ actorId: "owner", sourceArtifactId: "source", name: "Clone", slug: "clone" });
    expect(deps.lineages).toHaveLength(0);
    expect(deps.artifacts).toHaveLength(1);
    const copiedDependencies = deps.dependencies.filter((dependency) => dependency.artifactVersionId === deps.versions[0]?.id);
    expect(copiedDependencies.map(({ targetArtifactId, declaredRange }) => ({ targetArtifactId, declaredRange }))).toEqual([
      { targetArtifactId: "pearl-a", declaredRange: "^2.1.0" },
      { targetArtifactId: "pearl-b", declaredRange: "^1.4.0" },
    ]);
    expect(copiedDependencies[0]?.id).not.toBe(deps.sourceDependencies[0]?.id);
    expect(deps.sourceResolutions).toHaveLength(1);
    expect(deps.createdResolutions).toHaveLength(0);
    expect((await Promise.all(copiedDependencies.map((dependency) => deps.dependencyRepo.findResolutions(dependency.id)))).flat()).toHaveLength(0);
    expect(deps.sourceVersionWithLocation.snapshot()).toEqual(originalVersion);
  });

  it("rolls back a failed dependency copy when a transaction is available", async () => {
    const deps = copyServices();
    const createDependency = deps.dependencyRepo.create.bind(deps.dependencyRepo);
    deps.dependencyRepo.create = async (dependency) => {
      await createDependency(dependency);
      if (dependency.artifactVersionId !== deps.sourceVersionWithLocation.id) throw new Error("Dependency copy failed.");
    };
    const transactions: TransactionManager = {
      run: async (work) => {
        const artifactCount = deps.artifacts.length;
        const versionCount = deps.versions.length;
        const dependencyCount = deps.dependencies.length;
        const lineageCount = deps.lineages.length;
        try {
          return await work();
        } catch (error) {
          deps.artifacts.splice(artifactCount);
          deps.versions.splice(versionCount);
          deps.dependencies.splice(dependencyCount);
          deps.lineages.splice(lineageCount);
          throw error;
        }
      },
    };
    const service = new ForkArtifactService(deps.artifactRepo, deps.versionRepo, deps.store, deps.dependencyRepo, deps.lineageRepo, deps.access, deps.ids, { now: () => fixedTime }, transactions);

    await expect(service.execute({ actorId: "owner", sourceArtifactId: "source", name: "Fork", slug: "fork" })).rejects.toThrow("Dependency copy failed.");
    expect(deps.artifacts).toHaveLength(0);
    expect(deps.versions).toHaveLength(0);
    expect(deps.dependencies).toEqual(deps.sourceDependencies);
    expect(deps.lineages).toHaveLength(0);
  });
});

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
});

describe("GitHub import", () => {
  it.each([
    { version: "2.3.1", contentHash: "sha256:bc7bb97945a8c63b3025f86569c210fe543b39c360e96f6cc78ac80482bbdad2" },
    { version: "2.4.3", contentHash: "sha256:df40d14d3a8a1290c9536b6c525ad2f7bc1e795b9a1ee1964ed80c5943bb82d2" },
  ])("preserves Pearl version $version, hashes canonical content, and stores provenance without Fork lineage", async ({ version, contentHash }) => {
    const savedArtifacts: Artifact[] = [];
    const savedVersions: ArtifactVersion[] = [];
    const provenance: unknown[] = [];
    const storedContent: Array<{ content: string; hash: string }> = [];
    const artifactRepo = { findById: async () => null, findByOwnerAndSlug: async () => null, create: async (value: Artifact) => { savedArtifacts.push(value); }, save: async () => {} } as ArtifactRepository;
    const versionRepo = { findById: async () => null, findByArtifactAndVersion: async () => null, findForArtifact: async () => [], findLatest: async () => null, create: async (value: ArtifactVersion) => { savedVersions.push(value); } } as ArtifactVersionRepository;
    const store = { put: async (content: string, hash: string) => { storedContent.push({ content, hash }); return hash; }, get: async () => null, exists: async () => false };
    const provenanceRepo = { create: async (value: unknown) => { provenance.push(value); }, findForVersion: async () => [] } as unknown as ProvenanceRepository;
    const service = new ImportGitHubService({ fetch: async () => ({ content: { skill: {}, knowledge: [], version }, ref: "v99.0.0" }) }, artifactRepo, versionRepo, store, provenanceRepo, { next: (() => { let id = 0; return () => `generated-${++id}`; })(), }, { now: () => fixedTime });

    const result = await service.execute({ actorId: "owner", sourceUrl: "https://github.com/example/pearl", name: "Imported", slug: "imported" });
    expect(savedArtifacts).toHaveLength(1);
    expect(savedVersions).toHaveLength(1);
    expect(result.version.version).toBe(version);
    expect(result.version.contentHash).toBe(contentHash);
    expect(storedContent).toEqual([{ content: `{"knowledge":[],"skill":{},"version":"${version}"}`, hash: contentHash }]);
    expect(provenance).toEqual([{ id: "generated-3", artifactVersionId: result.version.id, sourceType: "github", sourceUrl: "https://github.com/example/pearl", sourceRef: "v99.0.0", importedAt: fixedTime }]);
    expect(result.version.version).not.toBe("v99.0.0");
  });

  it("rejects content without a declared version instead of inventing a default", async () => {
    const deps = copyServices();
    const provenanceRepo = { create: async () => {}, findForVersion: async () => [] } as unknown as ProvenanceRepository;
    const service = new ImportGitHubService({ fetch: async () => ({ content: { skill: {}, knowledge: [] }, ref: "v9.0.0" }) }, deps.artifactRepo, deps.versionRepo, deps.store, provenanceRepo);

    await expect(service.execute({ actorId: "owner", sourceUrl: "https://github.com/example/pearl", name: "Imported", slug: "imported" })).rejects.toMatchObject({ code: "IMPORT_INVALID_FORMAT" });
  });

  it("validates the declared Pearl version as SemVer", async () => {
    const deps = copyServices();
    const provenanceRepo = { create: async () => {}, findForVersion: async () => [] } as unknown as ProvenanceRepository;
    const service = new ImportGitHubService({ fetch: async () => ({ content: { skill: {}, knowledge: [], version: "v2" }, ref: "main" }) }, deps.artifactRepo, deps.versionRepo, deps.store, provenanceRepo);

    await expect(service.execute({ actorId: "owner", sourceUrl: "https://github.com/example/pearl", name: "Imported", slug: "imported" })).rejects.toMatchObject({ code: "INVALID_SEMVER" });
  });

  it("rejects malformed Pearl structure before storing or persisting it", async () => {
    const deps = copyServices();
    const provenanceRepo = { create: async () => {}, findForVersion: async () => [] } as unknown as ProvenanceRepository;
    const service = new ImportGitHubService({ fetch: async () => ({ content: { version: "2.4.3", skill: [], knowledge: {} }, ref: "main" }) }, deps.artifactRepo, deps.versionRepo, deps.store, provenanceRepo);

    await expect(service.execute({ actorId: "owner", sourceUrl: "https://github.com/example/pearl", name: "Imported", slug: "imported" })).rejects.toMatchObject({ code: "IMPORT_INVALID_FORMAT" });
    expect(deps.storedContent).toHaveLength(0);
    expect(deps.artifacts).toHaveLength(0);
    expect(deps.versions).toHaveLength(0);
  });
});