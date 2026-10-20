import { describe, expect, it } from "vitest";
import { DraftWorkflowService } from "../../src/application/services.js";
import { Artifact } from "../../src/domain/artifact.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import { Draft } from "../../src/domain/draft.js";
import { DomainError } from "../../src/domain/errors.js";
import type { ArtifactDiscoveryRepository, ArtifactRepository, ArtifactVersionRepository, DependencyRepository, DraftRepository, TransactionManager } from "../../src/ports/repositories.js";

const at = new Date("2026-01-01T00:00:00.000Z");
const content = { instructions: "Handle requests", knowledgeFiles: [{ path: "guide.md", content: "Keep private data safe." }], dependencies: [{ targetArtifactId: "target-artifact", declaredRange: "^2.1.0" }] };

function fixture() {
  const artifacts: Artifact[] = [];
  const versions: ArtifactVersion[] = [];
  const dependencies: Array<{ artifactVersionId: string; targetArtifactId: string; declaredRange: string }> = [];
  const drafts = new Map<string, Draft>();
  let failDependencyWrite = false;
  let id = 0;
  const artifactRepo: ArtifactRepository = {
    findById: async (value) => artifacts.find((artifact) => artifact.id === value) ?? null,
    findByOwnerAndSlug: async (owner, slug) => artifacts.find((artifact) => artifact.ownerId === owner && artifact.slug === slug) ?? null,
    findTombstoneSnapshotArtifact: async () => null,
    create: async (artifact) => { artifacts.push(artifact); },
    save: async (artifact) => { artifacts.splice(artifacts.findIndex((item) => item.id === artifact.id), 1, artifact); },
    tombstone: async () => {},
    restore: async () => null,
  };
  const versionRepo: ArtifactVersionRepository = {
    findById: async (value) => versions.find((version) => version.id === value) ?? null,
    findByArtifactAndVersion: async (artifactId, versionText) => versions.find((version) => version.artifactId === artifactId && version.version === versionText) ?? null,
    findForArtifact: async (artifactId) => versions.filter((version) => version.artifactId === artifactId),
    findLatest: async (artifactId) => versions.filter((version) => version.artifactId === artifactId).sort((left, right) => right.version.localeCompare(left.version))[0] ?? null,
    lockArtifactForWrite: async () => true,
    create: async (version) => { versions.push(version); },
  };
  const draftRepo: DraftRepository = {
    findActiveByOwner: async (ownerId) => [...drafts.values()].filter((draft) => draft.ownerId === ownerId && draft.state === "active"),
    findById: async (value) => drafts.get(value) ?? null,
    findByIdForUpdate: async (value) => drafts.get(value) ?? null,
    create: async (draft) => { drafts.set(draft.id, draft); },
    save: async (draft) => { drafts.set(draft.id, draft); },
  };
  const dependencyRepo: DependencyRepository = {
    findForVersion: async () => [],
    create: async (dependency) => {
      if (failDependencyWrite) throw new Error("Injected dependency persistence failure.");
      dependencies.push({ artifactVersionId: dependency.artifactVersionId, targetArtifactId: dependency.targetArtifactId, declaredRange: dependency.declaredRange });
    },
    createResolution: async () => {},
    findResolutions: async () => [],
  };
  const discovery: ArtifactDiscoveryRepository = {
    findPage: async () => ({ rows: [], hasMore: false }),
    findArtifactIdsAfter: async () => [],
    replaceTagProjection: async () => {},
    clearTagProjections: async () => {},
    isReady: async () => true,
    setReady: async () => {},
  };
  const transactions: TransactionManager = {
    run: async (work) => {
      const previousArtifacts = [...artifacts];
      const previousVersions = [...versions];
      const previousDependencies = [...dependencies];
      const previousDrafts = new Map(drafts);
      try {
        return await work();
      } catch (error) {
        artifacts.splice(0, artifacts.length, ...previousArtifacts);
        versions.splice(0, versions.length, ...previousVersions);
        dependencies.splice(0, dependencies.length, ...previousDependencies);
        drafts.clear();
        for (const [key, value] of previousDrafts) drafts.set(key, value);
        throw error;
      }
    },
  };
  const service = new DraftWorkflowService(
    draftRepo, artifactRepo, versionRepo, dependencyRepo,
    { canRead: async () => true, canWrite: async (actorId, artifact) => actorId === artifact.ownerId },
    discovery, transactions,
    { next: () => `generated-${++id}` }, { now: () => at },
  );
  return { service, artifacts, versions, dependencies, drafts, setFailDependencyWrite: (value: boolean) => { failDependencyWrite = value; } };
}

describe("Draft workflow application service", () => {
  it("lists only the caller's active Drafts", async () => {
    const state = fixture();
    const own = await state.service.create({ actorId: "owner", name: "Mine", slug: "mine", visibility: "private", content });
    await state.service.create({ actorId: "other", name: "Theirs", slug: "theirs", visibility: "private", content });
    await state.service.update({ actorId: "owner", draftId: own.id, revision: 1, name: "Mine", slug: "mine", visibility: "private", content });

    expect(await state.service.list({ actorId: "owner" })).toEqual([
      expect.objectContaining({ id: own.id, ownerId: "owner", state: "active", revision: 2 }),
    ]);
  });

  it("publishes a complete first 0.1.0 version and consumes the Draft exactly once", async () => {
    const state = fixture();
    const draft = await state.service.create({ actorId: "owner", name: "Pearl", slug: "pearl", visibility: "public", content });
    const result = await state.service.publish({ actorId: "owner", draftId: draft.id, revision: 1 });

    expect(result.artifact.name).toBe("Pearl");
    expect(result.version.version).toBe("0.1.0");
    expect(result.version.contentSnapshot).toMatchObject({ instructions: content.instructions, knowledgeFiles: [{ path: "guide.md", content: "Keep private data safe.", contentHash: expect.stringMatching(/^sha256:/) }], dependencies: content.dependencies });
    expect(state.dependencies).toEqual([{ artifactVersionId: result.version.id, ...content.dependencies[0] }]);
    expect(state.drafts.get(draft.id)?.state).toBe("published");
    await expect(state.service.publish({ actorId: "owner", draftId: draft.id, revision: 1 })).rejects.toMatchObject({ code: "DRAFT_NOT_ACTIVE" });
    expect(state.versions).toHaveLength(1);
    expect(state.artifacts).toHaveLength(1);
  });

  it("enforces Draft ownership and optimistic revisions", async () => {
    const state = fixture();
    const draft = await state.service.create({ actorId: "owner", name: "Pearl", slug: "pearl", visibility: "private", content });
    await expect(state.service.get({ actorId: "other", draftId: draft.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const updated = await state.service.update({ actorId: "owner", draftId: draft.id, revision: 1, name: "Edited", slug: "edited", visibility: "private", content });
    expect(updated.revision).toBe(2);
    await expect(state.service.update({ actorId: "owner", draftId: draft.id, revision: 1, name: "Edited", slug: "edited", visibility: "private", content })).rejects.toMatchObject({ code: "DRAFT_REVISION_CONFLICT" });
  });

  it("rolls back all publication writes and leaves the Draft editable on persistence failure", async () => {
    const state = fixture();
    const draft = await state.service.create({ actorId: "owner", name: "Pearl", slug: "pearl", visibility: "private", content });
    state.setFailDependencyWrite(true);
    await expect(state.service.publish({ actorId: "owner", draftId: draft.id, revision: 1 })).rejects.toThrow("Injected dependency persistence failure.");
    expect(state.artifacts).toHaveLength(0);
    expect(state.versions).toHaveLength(0);
    expect(state.drafts.get(draft.id)?.state).toBe("active");
    expect((await state.service.get({ actorId: "owner", draftId: draft.id })).revision).toBe(1);
  });

  it("creates owner-only work-copies from a selected snapshot without mutating its source", async () => {
    const state = fixture();
    const artifact = Artifact.create({ id: "artifact", ownerId: "owner", name: "Pearl", slug: "pearl", visibility: "public", createdAt: at });
    const version = ArtifactVersion.create({ id: "version-id", artifactId: artifact.id, version: "2.1.0", contentHash: "sha256:test", contentLocation: "postgres", contentSnapshot: { ...content, knowledgeFiles: [{ ...content.knowledgeFiles[0], contentHash: "sha256:file" }] }, createdAt: at, publishedAt: at });
    state.artifacts.push(artifact);
    state.versions.push(version);
    const copy = await state.service.createWorkCopy({ actorId: "owner", artifactId: artifact.id, version: version.version });
    expect(copy.baseVersionId).toBe(version.id);
    expect(copy.content).toEqual(content);
    expect(version.snapshot().version).toBe("2.1.0");
    await expect(state.service.createWorkCopy({ actorId: "someone-else", artifactId: artifact.id, version: version.version })).rejects.toBeInstanceOf(DomainError);
  });
});
