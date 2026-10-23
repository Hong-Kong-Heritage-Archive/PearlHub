import { describe, expect, it } from "vitest";
import { DraftWorkflowService } from "../../src/application/services.js";
import { ImportDraftService } from "../../src/application/services.js";
import { Artifact } from "../../src/domain/artifact.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import { Draft } from "../../src/domain/draft.js";
import { DomainError } from "../../src/domain/errors.js";
import type { ArtifactDiscoveryRepository, ArtifactRepository, ArtifactVersionRepository, DependencyRepository, DraftRepository, TransactionManager } from "../../src/ports/repositories.js";

const at = new Date("2026-01-01T00:00:00.000Z");
const content = { instructions: "Handle requests", knowledgeFiles: [{ path: "guide.md", content: "Keep private data safe." }], dependencies: [{ targetArtifactId: "target-artifact", declaredRange: "^2.1.0" }] };

function fixture(canRead: (actorId: string, artifact: Artifact) => Promise<boolean> = async () => true) {
  const artifacts: Artifact[] = [];
  const versions: ArtifactVersion[] = [];
  const dependencies: Array<{ artifactVersionId: string; targetArtifactId: string; declaredRange: string }> = [];
  const projections: Array<{ artifactId: string; versionId: string | null; tags: string[] }> = [];
  const lineages: Array<{ parentArtifactId: string; childArtifactId: string; sourceVersionId?: string }> = [];
  const provenances: Array<{ artifactVersionId: string; sourceType: string; sourceUrl: string; sourceRef: string; importedAt: Date }> = [];
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
    replaceTagProjection: async (artifactId, versionId, tags) => { projections.push({ artifactId, versionId, tags }); },
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
      const previousLineages = [...lineages];
      const previousProvenances = [...provenances];
      try {
        return await work();
      } catch (error) {
        artifacts.splice(0, artifacts.length, ...previousArtifacts);
        versions.splice(0, versions.length, ...previousVersions);
        dependencies.splice(0, dependencies.length, ...previousDependencies);
        drafts.clear();
        for (const [key, value] of previousDrafts) drafts.set(key, value);
        lineages.splice(0, lineages.length, ...previousLineages);
        provenances.splice(0, provenances.length, ...previousProvenances);
        throw error;
      }
    },
  };
  const lineageRepo = {
    createFork: async (parentArtifactId: string, childArtifactId: string, sourceVersionId?: string) => {
      lineages.push({ parentArtifactId, childArtifactId, ...(sourceVersionId === undefined ? {} : { sourceVersionId }) });
      return { id: `lineage-${lineages.length}`, parentArtifactId, childArtifactId, sourceVersionId: sourceVersionId ?? null, relationshipType: "fork" as const, createdAt: at };
    },
    getParents: async () => [],
    getChildren: async () => [],
  };
  const provenanceRepo = {
    create: async (value: { artifactVersionId: string; sourceType: string; sourceUrl: string; sourceRef: string; importedAt: Date }) => {
      provenances.push(value);
    },
    findForVersion: async () => [],
  };
  const service = new DraftWorkflowService(
    draftRepo, artifactRepo, versionRepo, dependencyRepo,
    { canRead, canWrite: async (actorId, artifact) => actorId === artifact.ownerId },
    discovery, transactions,
    { next: () => `generated-${++id}` }, { now: () => at }, lineageRepo, provenanceRepo,
  );
  return { service, artifactRepo, artifacts, versions, dependencies, drafts, projections, lineages, provenances, setFailDependencyWrite: (value: boolean) => { failDependencyWrite = value; } };
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
    const draft = await state.service.create({
      actorId: "owner", name: "Pearl", slug: "pearl", visibility: "public",
      content: { ...content, tags: [" RAG ", "Language-Model"] },
    });
    const result = await state.service.publish({ actorId: "owner", draftId: draft.id, revision: 1 });

    expect(result.artifact.name).toBe("Pearl");
    expect(result.version.version).toBe("0.1.0");
    expect(result.version.contentSnapshot).toMatchObject({ instructions: content.instructions, tags: ["rag", "language-model"], knowledgeFiles: [{ path: "guide.md", content: "Keep private data safe.", contentHash: expect.stringMatching(/^sha256:/) }], dependencies: content.dependencies });
    expect(state.projections).toEqual([{ artifactId: result.artifact.id, versionId: result.version.id, tags: ["rag", "language-model"] }]);
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

  it("creates a Fork Draft from the explicitly selected complete Version and writes lineage only on first publication", async () => {
    const state = fixture();
    const sourceDraft = await state.service.create({
      actorId: "owner", name: "Source", slug: "source", visibility: "public",
      content: { ...content, tags: [" RAG ", "Language-Model"] },
    });
    const source = await state.service.publish({ actorId: "owner", draftId: sourceDraft.id, revision: 1 });
    const forkDraft = await state.service.createFork({
      actorId: "forker", sourceArtifactId: source.artifact.id, sourceVersion: "0.1.0",
      name: "Fork", slug: "fork", visibility: "private",
    });

    expect(state.artifacts).toHaveLength(1);
    expect(forkDraft.forkOrigin).toEqual({ artifactId: source.artifact.id, versionId: source.version.id });
    expect(forkDraft.content).toMatchObject({
      instructions: content.instructions,
      tags: ["rag", "language-model"],
      knowledgeFiles: [{ path: "guide.md", content: "Keep private data safe." }],
      dependencies: content.dependencies,
    });
    await expect(state.service.createFork({
      actorId: "forker", sourceArtifactId: source.artifact.id, sourceVersion: "9.9.9",
      name: "Missing", slug: "missing", visibility: "private",
    })).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    expect(state.drafts.size).toBe(2);

    const publishedFork = await state.service.publish({ actorId: "forker", draftId: forkDraft.id, revision: 1 });
    expect(publishedFork.version.version).toBe("0.1.0");
    expect(state.lineages).toEqual([{
      parentArtifactId: source.artifact.id,
      childArtifactId: publishedFork.artifact.id,
      sourceVersionId: source.version.id,
    }]);
    expect(state.artifacts).toHaveLength(2);
    expect(publishedFork.version.contentSnapshot).toMatchObject({ instructions: content.instructions });
  });

  it("does not create a Fork Draft from a private source the caller cannot read", async () => {
    const state = fixture(async (_actorId, artifact) => artifact.visibility === "public");
    const sourceDraft = await state.service.create({
      actorId: "owner", name: "Private Source", slug: "private-source", visibility: "private", content,
    });
    const source = await state.service.publish({ actorId: "owner", draftId: sourceDraft.id, revision: 1 });

    await expect(state.service.createFork({
      actorId: "other-user", sourceArtifactId: source.artifact.id, sourceVersion: "0.1.0",
      name: "Unauthorized Fork", slug: "unauthorized-fork", visibility: "private",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.drafts.size).toBe(1);
    expect(state.artifacts).toHaveLength(1);
  });

  it("creates pasted and GitHub Import Drafts, persisting provenance only when publishing a sourced Draft", async () => {
    const state = fixture();
    const importer = new ImportDraftService({
      fetch: async () => ({ content: "# Imported Pearl\n\nKeep the original text.", ref: "main" }),
    }, state.service, { now: () => at });

    const pasted = await importer.execute({
      actorId: "owner", sourceType: "pasted", name: "Pasted", slug: "pasted", visibility: "private",
      content: "# Pasted Skill\n\nPreserve this text exactly.",
    });
    expect(pasted.content.instructions).toBe("# Pasted Skill\n\nPreserve this text exactly.");
    expect(pasted.provenance).toBeNull();

    const sourced = await importer.execute({
      actorId: "owner", sourceType: "github", name: "Sourced", slug: "sourced", visibility: "private",
      sourceUrl: "https://raw.githubusercontent.com/acme/pearl/main/SKILL.md",
    });
    expect(state.artifacts).toHaveLength(0);
    expect(sourced.content.instructions).toBe("# Imported Pearl\n\nKeep the original text.");
    expect(sourced.provenance).toEqual({
      sourceType: "github",
      sourceUrl: "https://raw.githubusercontent.com/acme/pearl/main/SKILL.md",
      sourceRef: "main",
      importedAt: at,
    });

    const result = await state.service.publish({ actorId: "owner", draftId: sourced.id, revision: 1 });
    expect(result.version.version).toBe("0.1.0");
    expect(state.provenances).toEqual([expect.objectContaining({
      artifactVersionId: result.version.id,
      sourceType: "github",
      sourceUrl: "https://raw.githubusercontent.com/acme/pearl/main/SKILL.md",
      sourceRef: "main",
      importedAt: at,
    })]);
    expect(state.lineages).toHaveLength(0);
  });

  it("rejects work-copy publication when its Artifact has been tombstoned", async () => {
    const state = fixture();
    const initial = await state.service.create({
      actorId: "owner", name: "Retired", slug: "retired", visibility: "private", content,
    });
    const published = await state.service.publish({ actorId: "owner", draftId: initial.id, revision: 1 });
    const workCopy = await state.service.createWorkCopy({
      actorId: "owner", artifactId: published.artifact.id, version: "0.1.0",
    });
    const deleted = published.artifact.tombstone(at);
    await state.artifactRepo.save(deleted);

    await expect(state.service.publish({ actorId: "owner", draftId: workCopy.id, revision: 1 }))
      .rejects.toMatchObject({ code: "ARTIFACT_GONE" });
    expect(state.versions).toHaveLength(1);
    expect(state.drafts.get(workCopy.id)?.state).toBe("active");
  });

  it("rejects empty or oversized pasted imports without creating a Draft", async () => {
    const state = fixture();
    const importer = new ImportDraftService({ fetch: async () => ({ content: "", ref: "main" }) }, state.service);
    await expect(importer.execute({
      actorId: "owner", sourceType: "pasted", name: "Empty", slug: "empty", visibility: "private", content: " \n",
    })).rejects.toMatchObject({ code: "IMPORT_INVALID_FORMAT" });
    await expect(importer.execute({
      actorId: "owner", sourceType: "pasted", name: "Large", slug: "large", visibility: "private", content: "a".repeat(1_048_577),
    })).rejects.toMatchObject({ code: "IMPORT_CONTENT_TOO_LARGE" });
    expect(state.drafts.size).toBe(0);
  });

  it("does not create an Import Draft when source retrieval fails", async () => {
    const state = fixture();
    const importer = new ImportDraftService({
      fetch: async () => { throw new DomainError("IMPORT_SOURCE_UNAVAILABLE", "GitHub source could not be retrieved."); },
    }, state.service);
    await expect(importer.execute({
      actorId: "owner", sourceType: "github", name: "Unavailable", slug: "unavailable",
      visibility: "private", sourceUrl: "https://raw.githubusercontent.com/acme/missing/main/SKILL.md",
    })).rejects.toMatchObject({ code: "IMPORT_SOURCE_UNAVAILABLE" });
    expect(state.drafts.size).toBe(0);
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
    const version = ArtifactVersion.create({ id: "version-id", artifactId: artifact.id, version: "2.1.0", contentHash: "sha256:test", contentLocation: "postgres", contentSnapshot: { ...content, tags: ["rag"], knowledgeFiles: [{ ...content.knowledgeFiles[0], contentHash: "sha256:file" }] }, createdAt: at, publishedAt: at });
    state.artifacts.push(artifact);
    state.versions.push(version);
    const copy = await state.service.createWorkCopy({ actorId: "owner", artifactId: artifact.id, version: version.version });
    expect(copy.baseVersionId).toBe(version.id);
    expect(copy.content).toEqual({ ...content, tags: ["rag"] });
    expect(version.snapshot().version).toBe("2.1.0");
    await expect(state.service.createWorkCopy({ actorId: "someone-else", artifactId: artifact.id, version: version.version })).rejects.toBeInstanceOf(DomainError);
  });

  it.each(["private", "unlisted"] as const)("publishes an owner work-copy from %s visibility as public", async (visibility) => {
    const state = fixture();
    const artifact = Artifact.create({ id: "artifact", ownerId: "owner", name: "Pearl", slug: "pearl", visibility, createdAt: at });
    const version = ArtifactVersion.create({
      id: "version-id",
      artifactId: artifact.id,
      version: "2.1.0",
      contentHash: "sha256:test",
      contentLocation: "postgres",
      contentSnapshot: { ...content, tags: ["rag"], knowledgeFiles: [{ ...content.knowledgeFiles[0], contentHash: "sha256:file" }] },
      createdAt: at,
      publishedAt: at,
    });
    state.artifacts.push(artifact);
    state.versions.push(version);

    const draft = await state.service.createWorkCopy({ actorId: "owner", artifactId: artifact.id, version: version.version });
    const updated = await state.service.update({
      actorId: "owner",
      draftId: draft.id,
      revision: draft.revision,
      name: draft.name,
      slug: draft.slug,
      visibility: "public",
      content: draft.content,
    });
    const result = await state.service.publish({ actorId: "owner", draftId: draft.id, revision: updated.revision });

    expect(result.artifact.visibility).toBe("public");
    expect(state.artifacts[0]?.visibility).toBe("public");
    expect(result.version.version).toBe("2.1.1");
    expect(version.version).toBe("2.1.0");
  });
});
