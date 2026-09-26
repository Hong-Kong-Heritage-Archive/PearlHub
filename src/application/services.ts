import { createHash, randomUUID } from "node:crypto";
import * as semver from "semver";
import { Artifact, type ArtifactVisibility } from "../domain/artifact.js";
import { ArtifactVersion } from "../domain/artifact-version.js";
import { Dependency } from "../domain/dependency.js";
import { DomainError } from "../domain/errors.js";
import { createForkLineage, type CompatibilityReport, type DependencyResolution, type Provenance } from "../domain/records.js";
import type {
  ArtifactContentStore,
  ArtifactRepository,
  ArtifactVersionRepository,
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

export class CreateArtifactService {
  constructor(private readonly artifacts: ArtifactRepository, private readonly ids = uuidGenerator, private readonly clock = systemClock) {}

  async execute(input: { actorId: string; name: string; slug: string; visibility: ArtifactVisibility }): Promise<Artifact> {
    const existing = await this.artifacts.findByOwnerAndSlug(input.actorId, input.slug);
    if (existing) throw new DomainError("ARTIFACT_SLUG_CONFLICT", "Artifact slug is already used by this owner.", { slug: input.slug });
    const artifact = Artifact.create({ id: this.ids.next(), ownerId: input.actorId, name: input.name, slug: input.slug, visibility: input.visibility, createdAt: this.clock.now() });
    await this.artifacts.create(artifact);
    return artifact;
  }
}

export class PublishVersionService {
  constructor(
    private readonly artifacts: ArtifactRepository,
    private readonly versions: ArtifactVersionRepository,
    private readonly contentStore: ArtifactContentStore,
    private readonly dependencies: DependencyRepository,
    private readonly access: AccessPolicy,
    private readonly ids = uuidGenerator,
    private readonly clock = systemClock,
    private readonly transactions?: TransactionManager,
  ) {}

  async execute(input: { actorId: string; artifactId: string; version: string; content: Record<string, unknown>; dependencies?: Array<{ targetArtifactId: string; declaredRange: string }> }): Promise<ArtifactVersion> {
    const artifact = await this.artifacts.findById(input.artifactId);
    if (!artifact) throw new DomainError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
    await authorizeWrite(this.access, input.actorId, artifact);
    if (artifact.status !== "active") throw new DomainError("INVALID_REQUEST", "Cannot publish to a tombstoned Artifact.");
    if (await this.versions.findByArtifactAndVersion(artifact.id, input.version)) throw new DomainError("VERSION_ALREADY_EXISTS", "This version already exists.");
    const canonicalContent = canonicalize(input.content);
    const contentHash = `sha256:${createHash("sha256").update(canonicalContent).digest("hex")}`;
    const store = async (): Promise<ArtifactVersion> => {
      const contentLocation = await this.contentStore.put(canonicalContent, contentHash);
      const at = this.clock.now();
      const version = ArtifactVersion.create({ id: this.ids.next(), artifactId: artifact.id, version: input.version, contentHash, contentLocation, createdAt: at, publishedAt: at });
      await this.versions.create(version);
      for (const declaration of input.dependencies ?? []) {
        await this.dependencies.create(Dependency.create({ id: this.ids.next(), artifactVersionId: version.id, targetArtifactId: declaration.targetArtifactId, declaredRange: declaration.declaredRange, createdAt: at }));
      }
      return version;
    };
    return this.transactions ? this.transactions.run(store) : store();
  }
}

abstract class CopyArtifactService {
  constructor(
    protected readonly artifacts: ArtifactRepository,
    protected readonly versions: ArtifactVersionRepository,
    protected readonly contentStore: ArtifactContentStore,
    protected readonly access: AccessPolicy,
    protected readonly ids: IdGenerator = uuidGenerator,
    protected readonly clock: Clock = systemClock,
    protected readonly transactions?: TransactionManager,
  ) {}

  protected async copy(input: { actorId: string; sourceArtifactId: string; name: string; slug: string; sourceVersionId?: string }, afterCreate?: (artifact: Artifact) => Promise<void>): Promise<{ artifact: Artifact; sourceVersion: ArtifactVersion }> {
    const source = await this.artifacts.findById(input.sourceArtifactId);
    if (!source) throw new DomainError("ARTIFACT_NOT_FOUND", "Source Artifact was not found.");
    await authorizeRead(this.access, input.actorId, source);
    const sourceVersion = input.sourceVersionId
      ? await this.versions.findById(input.sourceVersionId)
      : await this.versions.findLatest(source.id);
    if (!sourceVersion || sourceVersion.artifactId !== source.id) throw new DomainError("VERSION_NOT_FOUND", "Source version was not found.");
    const content = await this.contentStore.get(sourceVersion.contentLocation);
    if (content === null) throw new DomainError("INVALID_REQUEST", "Source content is unavailable.");
    const artifact = Artifact.create({ id: this.ids.next(), ownerId: input.actorId, name: input.name, slug: input.slug, visibility: "private", createdAt: this.clock.now() });
    const contentLocation = await this.contentStore.put(content, sourceVersion.contentHash);
    const at = this.clock.now();
    const copiedVersion = ArtifactVersion.create({ id: this.ids.next(), artifactId: artifact.id, version: sourceVersion.version, contentHash: sourceVersion.contentHash, contentLocation, createdAt: at, publishedAt: at });
    const work = async () => {
      await this.artifacts.create(artifact);
      await this.versions.create(copiedVersion);
      await afterCreate?.(artifact);
    };
    if (this.transactions) await this.transactions.run(work); else await work();
    return { artifact, sourceVersion };
  }
}

export class ForkArtifactService extends CopyArtifactService {
  constructor(artifacts: ArtifactRepository, versions: ArtifactVersionRepository, contentStore: ArtifactContentStore, private readonly lineage: LineageRepository, access: AccessPolicy, ids = uuidGenerator, clock = systemClock, transactions?: TransactionManager) {
    super(artifacts, versions, contentStore, access, ids, clock, transactions);
  }

  async execute(input: { actorId: string; sourceArtifactId: string; name: string; slug: string; sourceVersionId?: string }): Promise<Artifact> {
    const copied = await this.copy(input, async (artifact) => {
      const relation = createForkLineage(input.sourceArtifactId, artifact.id, this.ids.next(), this.clock.now());
      await this.lineage.createFork(relation.parentArtifactId, relation.childArtifactId);
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
    const deleted = artifact.tombstone(this.clock.now());
    const save = () => this.artifacts.save(deleted);
    if (this.transactions) await this.transactions.run(save); else await save();
    return deleted;
  }
}

export interface GitHubSource {
  fetch(sourceUrl: string): Promise<{ content: unknown; ref: string }>;
}

export class ImportGitHubService {
  constructor(private readonly source: GitHubSource, private readonly artifacts: ArtifactRepository, private readonly versions: ArtifactVersionRepository, private readonly contentStore: ArtifactContentStore, private readonly provenances: ProvenanceRepository, private readonly ids = uuidGenerator, private readonly clock = systemClock, private readonly transactions?: TransactionManager) {}
  async execute(input: { actorId: string; sourceUrl: string; name: string; slug: string }): Promise<{ artifact: Artifact; version: ArtifactVersion }> {
    const fetched = await this.source.fetch(input.sourceUrl);
    if (!isPearlContent(fetched.content)) throw new DomainError("IMPORT_INVALID_FORMAT", "GitHub source is not valid Pearl content.");
    const canonical = canonicalize(fetched.content as Record<string, unknown>);
    const hash = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
    const location = await this.contentStore.put(canonical, hash);
    const now = this.clock.now();
    const artifact = Artifact.create({ id: this.ids.next(), ownerId: input.actorId, name: input.name, slug: input.slug, visibility: "private", createdAt: now });
    const version = ArtifactVersion.create({ id: this.ids.next(), artifactId: artifact.id, version: "1.0.0", contentHash: hash, contentLocation: location, createdAt: now, publishedAt: now });
    const provenance: Provenance = { id: this.ids.next(), artifactVersionId: version.id, sourceType: "github", sourceUrl: input.sourceUrl, sourceRef: fetched.ref, importedAt: now };
    const work = async () => { await this.artifacts.create(artifact); await this.versions.create(version); await this.provenances.create(provenance); };
    if (this.transactions) await this.transactions.run(work); else await work();
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

function isPearlContent(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "skill" in value && "knowledge" in value;
}

async function authorizeRead(access: AccessPolicy, actorId: string, artifact: Artifact): Promise<void> {
  if (artifact.ownerId !== actorId && !await access.canRead(actorId, artifact)) throw new DomainError("FORBIDDEN", "Actor cannot read this Artifact.");
}

async function authorizeWrite(access: AccessPolicy, actorId: string, artifact: Artifact): Promise<void> {
  if (artifact.ownerId !== actorId && !await access.canWrite(actorId, artifact)) throw new DomainError("FORBIDDEN", "Actor cannot modify this Artifact.");
}