import { DomainError } from "./errors.js";

export interface DependencyResolution {
  id: string;
  dependencyId: string;
  runId: string | null;
  resolvedArtifactVersionId: string;
  resolvedAt: Date;
}

export interface Lineage {
  id: string;
  parentArtifactId: string;
  childArtifactId: string;
  sourceVersionId: string | null;
  relationshipType: "fork";
  createdAt: Date;
}

export interface Provenance {
  id: string;
  artifactVersionId: string;
  sourceType: string;
  sourceUrl: string;
  sourceRef: string;
  importedAt: Date;
}

export interface CompatibilityReport {
  id: string;
  artifactVersionId: string;
  targetArtifactVersionId: string | null;
  status: string;
  report: Record<string, unknown>;
  createdAt: Date;
}

export function createForkLineage(parentArtifactId: string, childArtifactId: string, id: string, createdAt: Date, sourceVersionId: string | null = null): Lineage {
  if (parentArtifactId === childArtifactId) {
    throw new DomainError("LINEAGE_INVALID", "An Artifact cannot be its own fork parent.");
  }
  return { id, parentArtifactId, childArtifactId, sourceVersionId, relationshipType: "fork", createdAt: new Date(createdAt) };
}