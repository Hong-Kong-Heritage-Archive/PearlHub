import type { Artifact } from "../domain/artifact.js";
import type { ArtifactVersion } from "../domain/artifact-version.js";
import type { Draft } from "../domain/draft.js";
import type { Dependency } from "../domain/dependency.js";
import type { CompatibilityReport, DependencyResolution, Lineage, Provenance } from "../domain/records.js";
import type {
  ArtifactDiscoveryCursorPosition,
  ArtifactDiscoveryPageRow,
  ArtifactDiscoveryQuery,
  ArtifactSummary,
} from "../domain/discovery.js";

export interface ArtifactRepository {
  findById(id: string): Promise<Artifact | null>;
  findTombstoneSnapshotArtifact(id: string): Promise<Artifact | null>;
  findByOwnerAndSlug(ownerId: string, slug: string): Promise<Artifact | null>;
  create(artifact: Artifact): Promise<void>;
  save(artifact: Artifact): Promise<void>;
  tombstone(artifact: Artifact): Promise<void>;
  restore(artifact: Artifact): Promise<Artifact | null>;
}

export interface ArtifactVersionRepository {
  findById(id: string): Promise<ArtifactVersion | null>;
  findByArtifactAndVersion(artifactId: string, version: string): Promise<ArtifactVersion | null>;
  findForArtifact(artifactId: string): Promise<ArtifactVersion[]>;
  findLatest(artifactId: string): Promise<ArtifactVersion | null>;
  lockArtifactForWrite(artifactId: string): Promise<boolean>;
  create(version: ArtifactVersion): Promise<void>;
}

export interface DraftRepository {
  findActiveByOwner(ownerId: string): Promise<Draft[]>;
  findById(id: string): Promise<Draft | null>;
  findByIdForUpdate(id: string): Promise<Draft | null>;
  create(draft: Draft): Promise<void>;
  save(draft: Draft): Promise<void>;
}

export interface ArtifactDiscoveryRepository {
  findPage(input: Omit<ArtifactDiscoveryQuery, "cursor"> & { after?: ArtifactDiscoveryCursorPosition }): Promise<{ rows: ArtifactDiscoveryPageRow[]; hasMore: boolean }>;
  findArtifactIdsAfter(afterId: string | null, limit: number): Promise<string[]>;
  replaceTagProjection(artifactId: string, versionId: string | null, tags: string[]): Promise<void>;
  clearTagProjections(): Promise<void>;
  isReady(): Promise<boolean>;
  setReady(ready: boolean): Promise<void>;
}

export interface DiscoveryReindexLock {
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}

export interface LineageRepository {
  createFork(parentArtifactId: string, childArtifactId: string, sourceVersionId?: string): Promise<Lineage>;
  getParents(artifactId: string): Promise<Lineage[]>;
  getChildren(artifactId: string): Promise<Lineage[]>;
}

export interface UserIdentity {
  id: string;
  userId: string;
  provider: string;
  subject: string;
  createdAt: Date;
}

export interface UserIdentityRepository {
  findUserId(provider: string, subject: string): Promise<string | null>;
  create(identity: UserIdentity): Promise<void>;
}

export interface ProvenanceRepository {
  create(provenance: Provenance): Promise<void>;
  findForVersion(versionId: string): Promise<Provenance[]>;
}

export interface DependencyRepository {
  findForVersion(versionId: string): Promise<Dependency[]>;
  create(dependency: Dependency): Promise<void>;
  createResolution(resolution: DependencyResolution): Promise<void>;
  findResolutions(dependencyId: string): Promise<DependencyResolution[]>;
}

export interface CompatibilityReportRepository {
  create(report: CompatibilityReport): Promise<void>;
  findForArtifactVersion(versionId: string): Promise<CompatibilityReport[]>;
}

export interface ArtifactContentStore {
  put(content: string, contentHash: string): Promise<string>;
  get(location: string): Promise<string | null>;
  exists(contentHash: string): Promise<boolean>;
}

export interface TransactionManager {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export interface IdGenerator {
  next(): string;
}

export interface Clock {
  now(): Date;
}