import { DomainError } from "../domain/errors.js";

export interface CreateArtifactRequest {
  name: string;
  slug: string;
  visibility: "private" | "unlisted" | "public";
}

export interface ArtifactResponse {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  visibility: CreateArtifactRequest["visibility"];
  status: "active" | "tombstone";
  createdAt: string;
  updatedAt: string;
}

export interface PublishVersionRequest {
  version: string;
  content: Record<string, unknown>;
  dependencies?: Array<{ targetArtifactId: string; declaredRange: string }>;
}

export interface VersionResponse {
  id: string;
  artifactId: string;
  version: string;
  contentHash: string;
  contentLocation: string;
  createdAt: string;
  publishedAt: string;
}

export interface CopyArtifactRequest {
  name: string;
  slug: string;
  sourceVersionId?: string;
}

export interface ImportGitHubRequest {
  sourceUrl: string;
  name: string;
  slug: string;
}

export interface ResolveDependenciesRequest {
  dependencies: Array<{ targetArtifactId: string; declaredRange: string }>;
}

export interface CompatibilityReportRequest {
  artifactVersionId: string;
  targetArtifactVersionId?: string;
  status: string;
  report: Record<string, unknown>;
}

export interface CompatibilityReportResponse extends Omit<CompatibilityReportRequest, "targetArtifactVersionId"> {
  id: string;
  targetArtifactVersionId: string | null;
  createdAt: string;
}

export interface ApiErrorResponse {
  error: { code: string; message: string; details: Record<string, unknown> };
}

export function parseCreateArtifactRequest(value: unknown): CreateArtifactRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_REQUEST", "Request body must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== "string" || typeof candidate.slug !== "string" || !["private", "unlisted", "public"].includes(String(candidate.visibility))) {
    throw new DomainError("INVALID_REQUEST", "Create Artifact request is missing valid name, slug, or visibility.");
  }
  return { name: candidate.name, slug: candidate.slug, visibility: candidate.visibility as CreateArtifactRequest["visibility"] };
}

export function parsePublishVersionRequest(value: unknown): PublishVersionRequest {
  const candidate = requireObject(value);
  if (typeof candidate.version !== "string" || candidate.content === null || typeof candidate.content !== "object" || Array.isArray(candidate.content)) {
    throw new DomainError("INVALID_REQUEST", "Publish request requires a version and content object.");
  }
  const dependencies = candidate.dependencies;
  if (dependencies !== undefined && (!Array.isArray(dependencies) || dependencies.some((item) => !isDependencyDeclaration(item)))) {
    throw new DomainError("INVALID_REQUEST", "Dependencies must contain target Artifact IDs and declared ranges.");
  }
  return { version: candidate.version, content: candidate.content as Record<string, unknown>, ...(dependencies ? { dependencies: dependencies as NonNullable<PublishVersionRequest["dependencies"]> } : {}) };
}

export function parseCopyArtifactRequest(value: unknown): CopyArtifactRequest {
  const candidate = requireObject(value);
  if (typeof candidate.name !== "string" || typeof candidate.slug !== "string" || (candidate.sourceVersionId !== undefined && typeof candidate.sourceVersionId !== "string")) {
    throw new DomainError("INVALID_REQUEST", "Copy request requires a name and slug, with an optional source version ID.");
  }
  return { name: candidate.name, slug: candidate.slug, ...(candidate.sourceVersionId === undefined ? {} : { sourceVersionId: candidate.sourceVersionId }) };
}

export function parseImportGitHubRequest(value: unknown): ImportGitHubRequest {
  const candidate = requireObject(value);
  if (typeof candidate.sourceUrl !== "string" || typeof candidate.name !== "string" || typeof candidate.slug !== "string") {
    throw new DomainError("INVALID_REQUEST", "GitHub import requires sourceUrl, name, and slug.");
  }
  return { sourceUrl: candidate.sourceUrl, name: candidate.name, slug: candidate.slug };
}

export function parseCompatibilityReportRequest(value: unknown): CompatibilityReportRequest {
  const candidate = requireObject(value);
  if (typeof candidate.artifactVersionId !== "string" || typeof candidate.status !== "string" || candidate.report === null || typeof candidate.report !== "object" || Array.isArray(candidate.report) || (candidate.targetArtifactVersionId !== undefined && typeof candidate.targetArtifactVersionId !== "string")) {
    throw new DomainError("INVALID_REQUEST", "Compatibility report requires a source version, status, and report object.");
  }
  return {
    artifactVersionId: candidate.artifactVersionId,
    status: candidate.status,
    report: candidate.report as Record<string, unknown>,
    ...(candidate.targetArtifactVersionId === undefined ? {} : { targetArtifactVersionId: candidate.targetArtifactVersionId }),
  };
}

export function toArtifactResponse(artifact: {
  id: string; ownerId: string; name: string; slug: string;
  visibility: CreateArtifactRequest["visibility"]; status: "active" | "tombstone"; createdAt: Date; updatedAt: Date;
}): ArtifactResponse {
  return { ...artifact, createdAt: artifact.createdAt.toISOString(), updatedAt: artifact.updatedAt.toISOString() };
}

export function toApiError(error: DomainError): ApiErrorResponse {
  return { error: { code: error.code, message: error.message, details: error.details } };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_REQUEST", "Request body must be an object.");
  }
  return value as Record<string, unknown>;
}

function isDependencyDeclaration(value: unknown): value is { targetArtifactId: string; declaredRange: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const declaration = value as Record<string, unknown>;
  return typeof declaration.targetArtifactId === "string" && typeof declaration.declaredRange === "string";
}