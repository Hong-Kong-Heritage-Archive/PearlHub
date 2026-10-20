import { createHash, randomUUID } from "node:crypto";
import * as semver from "semver";
import { Artifact, type ArtifactVisibility } from "../domain/artifact.js";
import { ArtifactVersion } from "../domain/artifact-version.js";
import { Draft, hashDraftContent, hashKnowledgeFile, type DraftContent } from "../domain/draft.js";
import { Dependency } from "../domain/dependency.js";
import { DomainError } from "../domain/errors.js";
import { normalizePearlContent, readPearlTags } from "../domain/discovery.js";
import { parsePearlContent } from "../domain/pearl.js";
import { createForkLineage, type CompatibilityReport, type DependencyResolution, type Provenance } from "../domain/records.js";
import type {
  ArtifactContentStore,
  ArtifactDiscoveryRepository,
  ArtifactRepository,
  ArtifactVersionRepository,
  DraftRepository,
  Clock,
  CompatibilityReportRepository,
  DependencyRepository,
  IdGenerator,
  LineageRepository,
  ProvenanceRepository,
  TransactionManager,
} from "../ports/repositories.js";

const systemClock: Clock = { now: () => new Date() };
const uuidGenerator: IdGenerator = { next: () => randomUUID() };

export interface AccessPolicy {
  canRead(actorId: string, artifact: Artifact): Promise<boolean>;
  canWrite(actorId: string, artifact: Artifact): Promise<boolean>;
}

export interface RestoreAccessPolicy {
  canRestore(actorId: string, artifact: Artifact): Promise<boolean>;
}

export interface DraftWorkflow {
  create(input: { actorId: string; name: string; slug: string; visibility: ArtifactVisibility; content: DraftContent }): Promise<Draft>;
  get(input: { actorId: string; draftId: string }): Promise<Draft>;
  update(input: { actorId: string; draftId: string; revision: number; name: string; slug: string; visibility: ArtifactVisibility; content: DraftContent }): Promise<Draft>;
  discard(input: { actorId: string; draftId: string; revision: number }): Promise<void>;
  createWorkCopy(input: { actorId: string; artifactId: string; version: string }): Promise<Draft>;
  publish(input: { actorId: string; draftId: string; revision: number }): Promise<{ artifact: Artifact; version: ArtifactVersion }>;
  getPublishedVersion(input: { actorId: string | null; artifactId: string; version: string }): Promise<{ artifact: Artifact; version: ArtifactVersion }>;
  listPublishedVersions(input: { actorId: string | null; artifactId: string }): Promise<{ artifact: Artifact; versions: ArtifactVersion[] }>;
}

export class DraftWorkflowService implements DraftWorkflow {
  constructor(
    private readonly drafts: DraftRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly versions: ArtifactVersionRepository,
    private readonly dependencies: DependencyRepository,
    private readonly access: AccessPolicy,
    private readonly discovery: ArtifactDiscoveryRepository,
    private readonly transactions: TransactionManager,
    private readonly ids = uuidGenerator,
    private readonly clock = systemClock,
  ) {}

  async create(input: { actorId: string; name: string; slug: string; visibility: ArtifactVisibility; content: DraftContent }): Promise<Draft> {
    const existing = await this.artifacts.findByOwnerAndSlug(input.actorId, input.slug);
    if (existing) throw new DomainError("ARTIFACT_SLUG_CONFLICT", "Artifact slug is already used by this owner.", { slug: input.slug });
    const now = this.clock.now();
    const draft = Draft.create({
      id: this.ids.next(), ownerId: input.actorId, artifactId: null, baseVersionId: null,
      name: input.name, slug: input.slug, visibility: input.visibility, content: input.content,
      createdAt: now, updatedAt: now,
    });
    await this.drafts.create(draft);
    return draft;
  }

  async get(input: { actorId: string; draftId: string }): Promise<Draft> {
    const draft = await this.requireDraft(input.draftId);
    this.authorizeDraftOwner(input.actorId, draft);
    return draft;
  }

  async update(input: { actorId: string; draftId: string; revision: number; name: string; slug: string; visibility: ArtifactVisibility; content: DraftContent }): Promise<Draft> {
    return this.transactions.run(async () => {
      const draft = await this.requireDraftForUpdate(input.draftId);
      this.authorizeDraft(input.actorId, draft);
      const updated = draft.update({ ...input, at: this.clock.now() });
      await this.drafts.save(updated);
      return updated;
    });
  }

  async discard(input: { actorId: string; draftId: string; revision: number }): Promise<void> {
    await this.transactions.run(async () => {
      const draft = await this.requireDraftForUpdate(input.draftId);
      this.authorizeDraft(input.actorId, draft);
      await this.drafts.save(draft.discard(input.revision, this.clock.now()));
    });
  }

  async createWorkCopy(input: { actorId: string; artifactId: string; version: string }): Promise<Draft> {
    const artifact = await this.artifacts.findById(input.artifactId);
    if (!artifact || artifact.status !== "active") throw new DomainError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
    await authorizeWrite(this.access, input.actorId, artifact);
    const version = await this.versions.findByArtifactAndVersion(artifact.id, input.version);
    if (!version) throw new DomainError("VERSION_NOT_FOUND", "Artifact Version was not found.");
    const content = version.contentSnapshot;
    if (!content || typeof content.instructions !== "string" || !Array.isArray(content.knowledgeFiles) || !Array.isArray(content.dependencies)) {
      throw new DomainError("VERSION_CONTENT_UNAVAILABLE", "This legacy Artifact Version has no PostgreSQL content snapshot.");
    }
    const contentInput: DraftContent = {
      instructions: content.instructions,
      knowledgeFiles: content.knowledgeFiles.map((file) => {
        if (!file || typeof file !== "object" || !("path" in file) || !("content" in file) || typeof file.path !== "string" || typeof file.content !== "string") {
          throw new DomainError("VERSION_CONTENT_UNAVAILABLE", "Artifact Version content snapshot is invalid.");
        }
        return { path: file.path, content: file.content };
      }),
      dependencies: content.dependencies.map((dependency) => {
        if (!dependency || typeof dependency !== "object" || !("targetArtifactId" in dependency) || !("declaredRange" in dependency) || typeof dependency.targetArtifactId !== "string" || typeof dependency.declaredRange !== "string") {
          throw new DomainError("VERSION_CONTENT_UNAVAILABLE", "Artifact Version dependency snapshot is invalid.");
        }
        return { targetArtifactId: dependency.targetArtifactId, declaredRange: dependency.declaredRange };
      }),
    };
    const now = this.clock.now();
    const draft = Draft.create({
      id: this.ids.next(), ownerId: input.actorId, artifactId: artifact.id, baseVersionId: version.id,
      name: artifact.name, slug: artifact.slug, visibility: artifact.visibility, content: contentInput,
      createdAt: now, updatedAt: now,
    });
    await this.drafts.create(draft);
    return draft;
  }

  async publish(input: { actorId: string; draftId: string; revision: number }): Promise<{ artifact: Artifact; version: ArtifactVersion }> {
    return this.transactions.run(async () => {
      const draft = await this.requireDraftForUpdate(input.draftId);
      this.authorizeDraft(input.actorId, draft);
      if (draft.revision !== input.revision) {
        throw new DomainError("DRAFT_REVISION_CONFLICT", "Draft has changed; reload before publishing.", { expectedRevision: draft.revision });
      }

      let artifact: Artifact;
      let versionText = "0.1.0";
      if (draft.artifactId === null) {
        if (await this.artifacts.findByOwnerAndSlug(draft.ownerId, draft.slug)) {
          throw new DomainError("ARTIFACT_SLUG_CONFLICT", "Artifact slug is already used by this owner.", { slug: draft.slug });
        }
        artifact = Artifact.create({
          id: this.ids.next(), ownerId: draft.ownerId, name: draft.name, slug: draft.slug,
          visibility: draft.visibility, createdAt: this.clock.now(),
        });
        await this.artifacts.create(artifact);
      } else {
        if (!await this.versions.lockArtifactForWrite(draft.artifactId)) throw new DomainError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
        artifact = await this.artifacts.findById(draft.artifactId) ?? (() => { throw new DomainError("ARTIFACT_NOT_FOUND", "Artifact was not found."); })();
        if (artifact.status !== "active") throw new DomainError("INVALID_REQUEST", "Cannot publish to a tombstoned Artifact.");
        await authorizeWrite(this.access, input.actorId, artifact);
        if (artifact.visibility !== draft.visibility) {
          artifact = artifact.changeVisibility(draft.visibility, this.clock.now());
          await this.artifacts.save(artifact);
        }
        const latest = await this.versions.findLatest(artifact.id);
        if (!latest || latest.id !== draft.baseVersionId) {
          throw new DomainError("DRAFT_REVISION_CONFLICT", "The source version changed; create a new work-copy before publishing.");
        }
        const next = semver.inc(latest.version, "patch");
        if (!next) throw new DomainError("INVALID_SEMVER", "Could not allocate the next Artifact Version.");
        versionText = next;
      }

      const content = draft.content;
      const contentHash = hashDraftContent(content);
      const contentSnapshot = {
        instructions: content.instructions,
        knowledgeFiles: content.knowledgeFiles.map((file) => ({ ...file, contentHash: hashKnowledgeFile(file.content) })),
        dependencies: content.dependencies,
      };
      const now = this.clock.now();
      const version = ArtifactVersion.create({
        id: this.ids.next(), artifactId: artifact.id, version: versionText, contentHash,
        contentLocation: `postgres:${artifact.id}:${versionText}`, contentSnapshot, createdAt: now, publishedAt: now,
      });
      await this.versions.create(version);
      for (const declaration of content.dependencies) {
        await this.dependencies.create(Dependency.create({
          id: this.ids.next(), artifactVersionId: version.id, targetArtifactId: declaration.targetArtifactId,
          declaredRange: declaration.declaredRange, createdAt: now,
        }));
      }
      await this.discovery.replaceTagProjection(artifact.id, version.id, []);
      await this.drafts.save(draft.consume(input.revision, now));
      return { artifact, version };
    });
  }

  async getPublishedVersion(input: { actorId: string | null; artifactId: string; version: string }): Promise<{ artifact: Artifact; version: ArtifactVersion }> {
    const artifact = await this.readableArtifact(input.actorId, input.artifactId);
    const version = await this.versions.findByArtifactAndVersion(artifact.id, input.version);
    if (!version) throw new DomainError("VERSION_NOT_FOUND", "Artifact Version was not found.");
    return { artifact, version };
  }

  async listPublishedVersions(input: { actorId: string | null; artifactId: string }): Promise<{ artifact: Artifact; versions: ArtifactVersion[] }> {
    const artifact = await this.readableArtifact(input.actorId, input.artifactId);
    return { artifact, versions: await this.versions.findForArtifact(artifact.id) };
  }

  private async readableArtifact(actorId: string | null, artifactId: string): Promise<Artifact> {
    const artifact = await this.artifacts.findById(artifactId);
    if (!artifact || artifact.status !== "active") throw new DomainError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
    if (artifact.visibility === "public") return artifact;
    if (actorId === null || artifact.ownerId !== actorId) {
      throw new DomainError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
    }
    return artifact;
  }

  private async requireDraft(id: string): Promise<Draft> {
    const draft = await this.drafts.findById(id);
    if (!draft) throw new DomainError("DRAFT_NOT_FOUND", "Draft was not found.");
    return draft;
  }

  private async requireDraftForUpdate(id: string): Promise<Draft> {
    const draft = await this.drafts.findByIdForUpdate(id);
    if (!draft) throw new DomainError("DRAFT_NOT_FOUND", "Draft was not found.");
    return draft;
  }

  private authorizeDraft(actorId: string, draft: Draft): void {
    this.authorizeDraftOwner(actorId, draft);
    if (draft.state !== "active") throw new DomainError("DRAFT_NOT_ACTIVE", "Draft is no longer active.");
  }

  private authorizeDraftOwner(actorId: string, draft: Draft): void {
    if (draft.ownerId !== actorId) throw new DomainError("FORBIDDEN", "Actor cannot access this Draft.");
  }
}

export class PublishVersionService {
  constructor(
    private readonly artifacts: ArtifactRepository,
    private readonly versions: ArtifactVersionRepository,
    private readonly contentStore: ArtifactContentStore,
    private readonly dependencies: DependencyRepository,
    private readonly access: AccessPolicy,
    private readonly discovery: ArtifactDiscoveryRepository,
    private readonly transactions: TransactionManager,
    private readonly ids = uuidGenerator,
    private readonly clock = systemClock,
  ) {}

  async execute(input: { actorId: string; artifactId: string; version: string; content: Record<string, unknown>; dependencies?: Array<{ targetArtifactId: string; declaredRange: string }> }): Promise<ArtifactVersion> {
    const artifact = await this.artifacts.findById(input.artifactId);
    if (!artifact) throw new DomainError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
    await authorizeWrite(this.access, input.actorId, artifact);
    if (artifact.status !== "active") throw new DomainError("INVALID_REQUEST", "Cannot publish to a tombstoned Artifact.");
    if (await this.versions.findByArtifactAndVersion(artifact.id, input.version)) throw new DomainError("VERSION_ALREADY_EXISTS", "This version already exists.");
    const normalizedContent = normalizePearlContent(input.content);
    const dependencyDeclarations = [...(input.dependencies ?? [])]
      .sort((left, right) => left.targetArtifactId < right.targetArtifactId ? -1
        : left.targetArtifactId > right.targetArtifactId ? 1
          : left.declaredRange < right.declaredRange ? -1
            : left.declaredRange > right.declaredRange ? 1 : 0);
    const contentSnapshot = { content: normalizedContent, dependencies: dependencyDeclarations };
    const contentHash = `sha256:${createHash("sha256").update(canonicalize(contentSnapshot), "utf8").digest("hex")}`;
    const at = this.clock.now();
    const version = ArtifactVersion.create({
      id: this.ids.next(), artifactId: artifact.id, version: input.version, contentHash,
      contentLocation: `postgres:${artifact.id}:${input.version}`, contentSnapshot, createdAt: at, publishedAt: at,
    });
    return this.transactions.run(async () => {
      if (!await this.versions.lockArtifactForWrite(artifact.id)) throw new DomainError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
      const current = await this.artifacts.findById(artifact.id);
      if (!current) throw new DomainError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
      await authorizeWrite(this.access, input.actorId, current);
      if (current.status !== "active") throw new DomainError("INVALID_REQUEST", "Cannot publish to a tombstoned Artifact.");
      if (await this.versions.findByArtifactAndVersion(artifact.id, input.version)) throw new DomainError("VERSION_ALREADY_EXISTS", "This version already exists.");
      await this.versions.create(version);
      for (const declaration of input.dependencies ?? []) {
        await this.dependencies.create(Dependency.create({ id: this.ids.next(), artifactVersionId: version.id, targetArtifactId: declaration.targetArtifactId, declaredRange: declaration.declaredRange, createdAt: at }));
      }
      await projectLatestVersionTags(artifact.id, this.versions, this.contentStore, this.discovery);
      return version;
    });
  }
}

abstract class CopyArtifactService {
  constructor(
    protected readonly artifacts: ArtifactRepository,
    protected readonly versions: ArtifactVersionRepository,
    protected readonly contentStore: ArtifactContentStore,
    protected readonly dependencies: DependencyRepository,
    protected readonly access: AccessPolicy,
    protected readonly discovery: ArtifactDiscoveryRepository,
    protected readonly transactions: TransactionManager,
    protected readonly ids: IdGenerator = uuidGenerator,
    protected readonly clock: Clock = systemClock,
  ) {}

  protected async copy(input: { actorId: string; sourceArtifactId: string; name: string; slug: string; sourceVersionId?: string }, afterCreate?: (artifact: Artifact, sourceVersion: ArtifactVersion) => Promise<void>): Promise<{ artifact: Artifact; sourceVersion: ArtifactVersion }> {
    const source = await this.artifacts.findById(input.sourceArtifactId);
    if (!source) throw new DomainError("ARTIFACT_NOT_FOUND", "Source Artifact was not found.");
    await authorizeRead(this.access, input.actorId, source);
    const sourceVersion = input.sourceVersionId
      ? await this.versions.findById(input.sourceVersionId)
      : await this.versions.findLatest(source.id);
    if (!sourceVersion || sourceVersion.artifactId !== source.id) throw new DomainError("VERSION_NOT_FOUND", "Source version was not found.");
    const content = await this.contentStore.get(sourceVersion.contentLocation);
    if (content === null) throw new DomainError("INVALID_REQUEST", "Source content is unavailable.");
    const tags = readPearlTags(content);
    const artifact = Artifact.create({ id: this.ids.next(), ownerId: input.actorId, name: input.name, slug: input.slug, visibility: "private", createdAt: this.clock.now() });
    const contentLocation = await this.contentStore.put(content, sourceVersion.contentHash);
    const at = this.clock.now();
    const copiedVersion = ArtifactVersion.create({ id: this.ids.next(), artifactId: artifact.id, version: sourceVersion.version, contentHash: sourceVersion.contentHash, contentLocation, createdAt: at, publishedAt: at });
    const work = async () => {
      await this.artifacts.create(artifact);
      await this.versions.create(copiedVersion);
      for (const dependency of await this.dependencies.findForVersion(sourceVersion.id)) {
        await this.dependencies.create(Dependency.create({ id: this.ids.next(), artifactVersionId: copiedVersion.id, targetArtifactId: dependency.targetArtifactId, declaredRange: dependency.declaredRange, createdAt: at }));
      }
      await this.discovery.replaceTagProjection(artifact.id, copiedVersion.id, tags);
      await afterCreate?.(artifact, sourceVersion);
    };
    await this.transactions.run(work);
    return { artifact, sourceVersion };
  }
}

export class ForkArtifactService extends CopyArtifactService {
  constructor(artifacts: ArtifactRepository, versions: ArtifactVersionRepository, contentStore: ArtifactContentStore, dependencies: DependencyRepository, private readonly lineage: LineageRepository, access: AccessPolicy, discovery: ArtifactDiscoveryRepository, transactions: TransactionManager, ids = uuidGenerator, clock = systemClock) {
    super(artifacts, versions, contentStore, dependencies, access, discovery, transactions, ids, clock);
  }

  async execute(input: { actorId: string; sourceArtifactId: string; name: string; slug: string; sourceVersionId?: string }): Promise<Artifact> {
    const copied = await this.copy(input, async (artifact, sourceVersion) => {
      const relation = createForkLineage(input.sourceArtifactId, artifact.id, this.ids.next(), this.clock.now(), sourceVersion.id);
      await this.lineage.createFork(relation.parentArtifactId, relation.childArtifactId, relation.sourceVersionId ?? undefined);
    });
    return copied.artifact;
  }
}

export class CloneArtifactService extends CopyArtifactService {
  async execute(input: { actorId: string; sourceArtifactId: string; name: string; slug: string; sourceVersionId?: string }): Promise<Artifact> {
    return (await this.copy(input)).artifact;
  }
}

export class DeleteArtifactService {
  constructor(private readonly artifacts: ArtifactRepository, private readonly access: AccessPolicy, private readonly clock = systemClock, private readonly transactions?: TransactionManager) {}
  async execute(input: { actorId: string; artifactId: string }): Promise<Artifact> {
    const artifact = await this.artifacts.findById(input.artifactId);
    if (!artifact) throw new DomainError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
    await authorizeWrite(this.access, input.actorId, artifact);
    if (artifact.status === "tombstone") return artifact;
    const deleted = artifact.tombstone(this.clock.now());
    const tombstone = () => this.artifacts.tombstone(deleted);
    if (this.transactions) await this.transactions.run(tombstone); else await tombstone();
    return deleted;
  }
}

export class RestoreArtifactService {
  constructor(private readonly artifacts: ArtifactRepository, private readonly access: RestoreAccessPolicy, private readonly clock = systemClock) {}

  async execute(input: { actorId: string; artifactId: string }): Promise<Artifact> {
    const artifact = await this.artifacts.findById(input.artifactId);
    if (!artifact) throw new DomainError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
    if (!(await this.access.canRestore(input.actorId, artifact))) {
      throw new DomainError("FORBIDDEN", "Only an Admin may restore an Artifact.");
    }
    if (artifact.status !== "tombstone") throw new DomainError("INVALID_REQUEST", "Only a tombstoned Artifact can be restored.");
    const original = await this.artifacts.findTombstoneSnapshotArtifact(artifact.id);
    if (!original) throw new DomainError("INVALID_REQUEST", "Artifact tombstone snapshot was not found.");
    const restored = artifact.restore(original.visibility, this.clock.now());
    const persisted = await this.artifacts.restore(restored);
    if (!persisted) throw new DomainError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
    return persisted;
  }
}

export interface GitHubSource {
  fetch(sourceUrl: string): Promise<{ content: unknown; ref: string }>;
}

export class ImportGitHubService {
  constructor(private readonly source: GitHubSource, private readonly artifacts: ArtifactRepository, private readonly versions: ArtifactVersionRepository, private readonly contentStore: ArtifactContentStore, private readonly provenances: ProvenanceRepository, private readonly discovery: ArtifactDiscoveryRepository, private readonly transactions: TransactionManager, private readonly ids = uuidGenerator, private readonly clock = systemClock) {}
  async execute(input: { actorId: string; sourceUrl: string; name: string; slug: string }): Promise<{ artifact: Artifact; version: ArtifactVersion }> {
    const fetched = await this.source.fetch(input.sourceUrl);
    const pearl = parsePearlContent(fetched.content);
    const canonical = canonicalize(pearl);
    const hash = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
    const location = await this.contentStore.put(canonical, hash);
    const now = this.clock.now();
    const artifact = Artifact.create({ id: this.ids.next(), ownerId: input.actorId, name: input.name, slug: input.slug, visibility: "private", createdAt: now });
    const version = ArtifactVersion.create({ id: this.ids.next(), artifactId: artifact.id, version: pearl.version, contentHash: hash, contentLocation: location, createdAt: now, publishedAt: now });
    const provenance: Provenance = { id: this.ids.next(), artifactVersionId: version.id, sourceType: "github", sourceUrl: input.sourceUrl, sourceRef: fetched.ref, importedAt: now };
    const work = async () => {
      await this.artifacts.create(artifact);
      await this.versions.create(version);
      await this.provenances.create(provenance);
      await this.discovery.replaceTagProjection(artifact.id, version.id, Array.isArray(pearl.tags) ? pearl.tags : []);
    };
    await this.transactions.run(work);
    return { artifact, version };
  }
}

export class ResolveDependencyService {
  constructor(private readonly dependencies: DependencyRepository, private readonly versions: ArtifactVersionRepository, private readonly ids = uuidGenerator, private readonly clock = systemClock, private readonly transactions?: TransactionManager) {}
  async execute(input: { dependencies: Dependency[] }): Promise<DependencyResolution[]> {
    const resolutions: DependencyResolution[] = [];
    for (const dependency of input.dependencies) {
      const candidates: ArtifactVersion[] = [];
      for (const version of await this.listCandidates(dependency.targetArtifactId)) {
        if (dependency.accepts(version.version)) candidates.push(version);
      }
      candidates.sort((left, right) => semver.rcompare(left.version, right.version));
      const selected = candidates[0];
      if (!selected) throw new DomainError("DEPENDENCY_RESOLUTION_FAILED", "No compatible Artifact Version found.", { dependencyId: dependency.id });
      resolutions.push({ id: this.ids.next(), dependencyId: dependency.id, resolvedArtifactVersionId: selected.id, resolvedAt: this.clock.now() });
    }
    const persist = async () => { for (const resolution of resolutions) await this.dependencies.createResolution(resolution); };
    if (this.transactions) await this.transactions.run(persist); else await persist();
    return resolutions;
  }
  private async listCandidates(artifactId: string): Promise<ArtifactVersion[]> {
    return this.versions.findForArtifact(artifactId);
  }
}

export class CreateCompatibilityReportService {
  constructor(private readonly versions: ArtifactVersionRepository, private readonly reports: CompatibilityReportRepository, private readonly ids = uuidGenerator, private readonly clock = systemClock) {}
  async execute(input: { artifactVersionId: string; targetArtifactVersionId?: string; status: string; report: Record<string, unknown> }): Promise<CompatibilityReport> {
    if (!await this.versions.findById(input.artifactVersionId)) throw new DomainError("VERSION_NOT_FOUND", "Artifact Version was not found.");
    if (input.targetArtifactVersionId && !await this.versions.findById(input.targetArtifactVersionId)) throw new DomainError("VERSION_NOT_FOUND", "Target Artifact Version was not found.");
    const value: CompatibilityReport = { id: this.ids.next(), artifactVersionId: input.artifactVersionId, targetArtifactVersionId: input.targetArtifactVersionId ?? null, status: input.status, report: input.report, createdAt: this.clock.now() };
    await this.reports.create(value);
    return value;
  }
}

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function authorizeRead(access: AccessPolicy, actorId: string, artifact: Artifact): Promise<void> {
  if (artifact.ownerId !== actorId && !await access.canRead(actorId, artifact)) throw new DomainError("FORBIDDEN", "Actor cannot read this Artifact.");
}

async function authorizeWrite(access: AccessPolicy, actorId: string, artifact: Artifact): Promise<void> {
  if (artifact.ownerId !== actorId && !await access.canWrite(actorId, artifact)) throw new DomainError("FORBIDDEN", "Actor cannot modify this Artifact.");
}

async function projectLatestVersionTags(
  artifactId: string,
  versions: ArtifactVersionRepository,
  contentStore: ArtifactContentStore,
  discovery: ArtifactDiscoveryRepository,
): Promise<void> {
  const latest = await versions.findLatest(artifactId);
  if (!latest) {
    await discovery.replaceTagProjection(artifactId, null, []);
    return;
  }
  const snapshot = latest.contentSnapshot;
  const content = snapshot && Object.keys(snapshot).length > 0
    ? JSON.stringify(snapshot.content ?? snapshot)
    : await contentStore.get(latest.contentLocation);
  if (content === null) throw new DomainError("INVALID_REQUEST", "Latest Artifact Version content is unavailable.");
  await discovery.replaceTagProjection(artifactId, latest.id, readPearlTags(content));
}