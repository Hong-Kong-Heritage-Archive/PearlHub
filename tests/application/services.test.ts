import { describe, expect, it } from "vitest";
import { Artifact } from "../../src/domain/artifact.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import { Dependency } from "../../src/domain/dependency.js";
import { CloneArtifactService, ForkArtifactService, ImportGitHubService, ResolveDependencyService } from "../../src/application/services.js";
import type { ArtifactRepository, ArtifactVersionRepository, DependencyRepository, LineageRepository, ProvenanceRepository } from "../../src/ports/repositories.js";

const fixedTime = new Date("2026-01-01T00:00:00Z");
const sourceArtifact = Artifact.create({ id: "source", ownerId: "owner", name: "Source", slug: "source", visibility: "public", createdAt: fixedTime });
const sourceVersion = (id: string, version: string) => ArtifactVersion.create({ id, artifactId: "source", version, contentHash: `sha256:${id}`, contentLocation: id, createdAt: fixedTime, publishedAt: fixedTime });

function copyServices() {
  const artifacts: Artifact[] = [];
  const versions: ArtifactVersion[] = [];
  const lineages: Array<{ parent: string; child: string }> = [];
  const content = new Map([["source-location", '{"knowledge":[],"skill":{}}']]);
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
  const store = {
    put: async (value: string, hash: string) => { content.set(hash, value); return hash; },
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
  return { artifacts, versions, lineages, artifactRepo, versionRepo, store, access, lineageRepo, ids };
}

describe("copy services", () => {
  it("creates fork lineage without mutating the source", async () => {
    const deps = copyServices();
    const service = new ForkArtifactService(deps.artifactRepo, deps.versionRepo, deps.store, deps.lineageRepo, deps.access, deps.ids, { now: () => fixedTime });
    const child = await service.execute({ actorId: "owner", sourceArtifactId: "source", name: "Fork", slug: "fork" });

    expect(deps.lineages).toHaveLength(1);
    expect(deps.lineages[0]).toEqual({ parent: "source", child: child.id });
    expect(sourceArtifact.name).toBe("Source");
    expect(deps.versions[0]?.artifactId).toBe(child.id);
  });

  it("clones content without creating lineage", async () => {
    const deps = copyServices();
    const service = new CloneArtifactService(deps.artifactRepo, deps.versionRepo, deps.store, deps.access, deps.ids, { now: () => fixedTime });
    await service.execute({ actorId: "owner", sourceArtifactId: "source", name: "Clone", slug: "clone" });
    expect(deps.lineages).toHaveLength(0);
    expect(deps.artifacts).toHaveLength(1);
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
  it("stores provenance and does not establish fork lineage", async () => {
    const savedArtifacts: Artifact[] = [];
    const savedVersions: ArtifactVersion[] = [];
    const provenance: unknown[] = [];
    const artifactRepo = { findById: async () => null, findByOwnerAndSlug: async () => null, create: async (value: Artifact) => { savedArtifacts.push(value); }, save: async () => {} } as ArtifactRepository;
    const versionRepo = { findById: async () => null, findByArtifactAndVersion: async () => null, findForArtifact: async () => [], findLatest: async () => null, create: async (value: ArtifactVersion) => { savedVersions.push(value); } } as ArtifactVersionRepository;
    const store = { put: async (_content: string, hash: string) => hash, get: async () => null, exists: async () => false };
    const provenanceRepo = { create: async (value: unknown) => { provenance.push(value); }, findForVersion: async () => [] } as unknown as ProvenanceRepository;
    const service = new ImportGitHubService({ fetch: async () => ({ content: { skill: {}, knowledge: [] }, ref: "main" }) }, artifactRepo, versionRepo, store, provenanceRepo, { next: (() => { let id = 0; return () => `generated-${++id}`; })(), }, { now: () => fixedTime });

    const result = await service.execute({ actorId: "owner", sourceUrl: "https://github.com/example/pearl", name: "Imported", slug: "imported" });
    expect(savedArtifacts).toHaveLength(1);
    expect(savedVersions).toHaveLength(1);
    expect(provenance).toMatchObject([{ artifactVersionId: result.version.id, sourceType: "github", sourceRef: "main" }]);
  });
});