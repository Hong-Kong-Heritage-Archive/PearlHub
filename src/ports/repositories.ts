import type { Artifact } from "../domain/artifact.js";
import type { ArtifactVersion } from "../domain/artifact-version.js";
import type { Dependency } from "../domain/dependency.js";
import type { CompatibilityReport, DependencyResolution, Lineage, Provenance } from "../domain/records.js";

export interface ArtifactRepository {
  findById(id: string): Promise<Artifact | null>;
  findByOwnerAndSlug(ownerId: string, slug: string): Promise<Artifact | null>;
  create(artifact: Artifact): Promise<void>;
  save(artifact: Artifact): Promise<void>;
}

export interface ArtifactVersionRepository {
  findById(id: string): Promise<ArtifactVersion | null>;
  findByArtifactAndVersion(artifactId: string, version: string): Promise<ArtifactVersion | null>;
  findForArtifact(artifactId: string): Promise<ArtifactVersion[]>;
  findLatest(artifactId: string): Promise<ArtifactVersion | null>;
  create(version: ArtifactVersion): Promise<void>;
}

export interface LineageRepository {
  createFork(parentArtifactId: string, childArtifactId: string): Promise<Lineage>;
  getParents(artifactId: string): Promise<Lineage[]>;
  getChildren(artifactId: string): Promise<Lineage[]>;
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