export type ArtifactVisibility = "private" | "unlisted" | "public";

export interface DraftContent {
  instructions: string;
  knowledgeFiles: Array<{ path: string; content: string }>;
  dependencies: Array<{ targetArtifactId: string; declaredRange: string }>;
  tags?: string[];
}

export interface DraftInput {
  name: string;
  slug: string;
  visibility: ArtifactVisibility;
  content: DraftContent;
}

export interface Draft extends DraftInput {
  id: string;
  ownerId: string;
  artifactId: string | null;
  baseVersionId: string | null;
  forkOrigin?: { artifactId: string; versionId: string } | null;
  provenance?: {
    sourceType: string;
    sourceUrl: string;
    sourceRef: string;
    importedAt: string;
  } | null;
  state: "active" | "published" | "discarded";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DraftSummary {
  id: string;
  artifactId: string | null;
  baseVersionId: string | null;
  name: string;
  slug: string;
  visibility: ArtifactVisibility;
  state: "active";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublishedContent extends Omit<DraftContent, "knowledgeFiles"> {
  knowledgeFiles: Array<{ path: string; content: string; contentHash: string }>;
}

export interface PublishedVersion {
  artifact: {
    id: string;
    ownerId: string;
    name: string;
    slug: string;
    visibility: ArtifactVisibility;
    status: "active" | "tombstone";
    createdAt: string;
    updatedAt: string;
  };
  version: {
    id: string;
    artifactId: string;
    version: string;
    contentHash: string;
    publishedAt: string;
    content: PublishedContent;
  };
}

export interface ArtifactMetadata {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  visibility: ArtifactVisibility;
  status: "active" | "tombstone";
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactLineageEntry {
  id: string;
  parentArtifactId: string;
  childArtifactId: string;
  sourceVersionId: string | null;
  relationshipType: "fork";
  createdAt: string;
  artifact: ArtifactMetadata;
}

export interface ArtifactLineage {
  parents: ArtifactLineageEntry[];
  children: ArtifactLineageEntry[];
}

export class DraftRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "DraftRequestError";
  }
}

export async function createDraft(input: DraftInput, token: string, signal?: AbortSignal): Promise<Draft> {
  const response = await request("/drafts", "POST", input, token, signal);
  return readDraft(response);
}

export async function createForkDraft(
  artifactId: string,
  input: { sourceVersion: string; name: string; slug: string; visibility: ArtifactVisibility },
  token: string,
): Promise<Draft> {
  return readDraft(await request(`/artifacts/${encodeURIComponent(artifactId)}/fork`, "POST", input, token));
}

export async function createCloneDraft(
  artifactId: string,
  input: { sourceVersion: string; name: string; slug: string; visibility: ArtifactVisibility },
  token: string,
): Promise<Draft> {
  return readDraft(await request(`/artifacts/${encodeURIComponent(artifactId)}/clone`, "POST", input, token));
}

export async function createImportDraft(
  input:
    | { sourceType: "pasted"; name: string; slug: string; visibility: ArtifactVisibility; content: string }
    | { sourceType: "github"; name: string; slug: string; visibility: ArtifactVisibility; sourceUrl: string },
  token: string,
): Promise<Draft> {
  return readDraft(await request("/imports/github", "POST", input, token));
}

export async function getDraft(draftId: string, token: string, signal?: AbortSignal): Promise<Draft> {
  return readDraft(await request(`/drafts/${encodeURIComponent(draftId)}`, "GET", undefined, token, signal));
}

export async function listDrafts(token: string, signal?: AbortSignal): Promise<DraftSummary[]> {
  const response = await request("/drafts", "GET", undefined, token, signal);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DraftRequestError("The API returned an invalid Draft list response.", response.status, "INVALID_RESPONSE");
  }
  if (!Array.isArray(payload) || !payload.every(isDraftSummary)) {
    throw new DraftRequestError("The API returned an unexpected Draft list response.", response.status, "INVALID_RESPONSE");
  }
  return payload;
}

export async function updateDraft(draft: DraftInput & { revision: number; id: string }, token: string, signal?: AbortSignal): Promise<Draft> {
  const { id, ...body } = draft;
  return readDraft(await request(`/drafts/${encodeURIComponent(id)}`, "PUT", body, token, signal));
}

export async function discardDraft(draft: Pick<Draft, "id" | "revision">, token: string): Promise<void> {
  const response = await request(`/drafts/${encodeURIComponent(draft.id)}?revision=${draft.revision}`, "DELETE", undefined, token);
  if (response.status !== 204) throw await readError(response);
}

export async function tombstoneArtifact(artifactId: string, token: string): Promise<void> {
  const response = await request(`/artifacts/${encodeURIComponent(artifactId)}`, "DELETE", undefined, token);
  if (response.status !== 204) throw await readError(response);
}

export async function publishDraft(draft: Pick<Draft, "id" | "revision">, token: string): Promise<PublishedVersion> {
  const response = await request(`/drafts/${encodeURIComponent(draft.id)}/publish`, "POST", { revision: draft.revision }, token);
  return readPublishedVersion(response);
}

export async function listVersions(artifactId: string, token?: string): Promise<PublishedVersion[]> {
  const response = await request(`/artifacts/${encodeURIComponent(artifactId)}/versions`, "GET", undefined, token);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DraftRequestError("The API returned an invalid versions response.", response.status, "INVALID_RESPONSE");
  }
  if (!Array.isArray(payload) || !payload.every(isPublishedVersion)) {
    throw new DraftRequestError("The API returned an unexpected versions response.", response.status, "INVALID_RESPONSE");
  }
  return payload;
}

export async function getPublishedVersion(artifactId: string, version: string, token?: string): Promise<PublishedVersion> {
  return readPublishedVersion(await request(`/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(version)}`, "GET", undefined, token));
}

export async function getArtifact(artifactId: string, token?: string, signal?: AbortSignal): Promise<ArtifactMetadata> {
  const response = await request(`/artifacts/${encodeURIComponent(artifactId)}`, "GET", undefined, token, signal);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DraftRequestError("The API returned an invalid Artifact response.", response.status, "INVALID_RESPONSE");
  }
  if (!isArtifactMetadata(payload)) {
    throw new DraftRequestError("The API returned an unexpected Artifact response.", response.status, "INVALID_RESPONSE");
  }
  return payload;
}

export async function getArtifactLineage(artifactId: string, token?: string, signal?: AbortSignal): Promise<ArtifactLineage> {
  const response = await request(`/artifacts/${encodeURIComponent(artifactId)}/lineage`, "GET", undefined, token, signal);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DraftRequestError("The API returned an invalid lineage response.", response.status, "INVALID_RESPONSE");
  }
  if (!isArtifactLineage(payload)) {
    throw new DraftRequestError("The API returned an unexpected lineage response.", response.status, "INVALID_RESPONSE");
  }
  return payload;
}

export async function createWorkCopy(artifactId: string, version: string, token: string): Promise<Draft> {
  return readDraft(await request(`/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(version)}/work-copy`, "POST", undefined, token));
}

async function request(path: string, method: string, body: unknown, token?: string, signal?: AbortSignal): Promise<Response> {
  const url = buildApiUrl(path);
  const headers = new Headers({ Accept: "application/json" });
  if (token?.trim()) headers.set("Authorization", `Bearer ${token.trim()}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new DraftRequestError("Could not reach the PearlHub API. Check your connection and try again.", 0, "NETWORK_ERROR");
  }
  if (!response.ok) throw await readError(response);
  return response;
}

function buildApiUrl(path: string): URL {
  const base = process.env.NEXT_PUBLIC_PEARLHUB_API_BASE_URL;
  if (!base?.trim()) {
    throw new DraftRequestError("The PearlHub API base URL is not configured.", 0, "API_URL_NOT_CONFIGURED");
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new DraftRequestError("The PearlHub API base URL is invalid.", 0, "INVALID_API_URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new DraftRequestError("The PearlHub API base URL must use HTTP(S) and must not include credentials.", 0, "INVALID_API_URL");
  }
  const root = url.pathname.replace(/\/+$/, "");
  const apiRoot = root.endsWith("/api/v1") ? root : `${root}/api/v1`;
  return new URL(`${apiRoot}${path}`, url.origin);
}

async function readDraft(response: Response): Promise<Draft> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DraftRequestError("The API returned an invalid Draft response.", response.status, "INVALID_RESPONSE");
  }
  if (!isDraft(payload)) throw new DraftRequestError("The API returned an unexpected Draft response.", response.status, "INVALID_RESPONSE");
  return payload;
}

async function readPublishedVersion(response: Response): Promise<PublishedVersion> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DraftRequestError("The API returned an invalid published-version response.", response.status, "INVALID_RESPONSE");
  }
  if (!isPublishedVersion(payload)) throw new DraftRequestError("The API returned an unexpected published-version response.", response.status, "INVALID_RESPONSE");
  return payload;
}

async function readError(response: Response): Promise<DraftRequestError> {
  let message: string | undefined;
  let code = "API_ERROR";
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && isRecord(payload.error)) {
      if (typeof payload.error.message === "string") message = payload.error.message;
      if (typeof payload.error.code === "string") code = payload.error.code;
    }
  } catch {
    message = undefined;
  }
  if (response.status >= 500) message = "PearlHub could not complete the request. Try again.";
  return new DraftRequestError(message ?? `The PearlHub API returned HTTP ${response.status}.`, response.status, code);
}

function isDraft(value: unknown): value is Draft {
  return isRecord(value)
    && typeof value.id === "string" && value.id.length > 0 && typeof value.ownerId === "string"
    && (typeof value.artifactId === "string" || value.artifactId === null)
    && (typeof value.baseVersionId === "string" || value.baseVersionId === null)
    && typeof value.name === "string" && typeof value.slug === "string"
    && isVisibility(value.visibility) && isDraftContent(value.content)
    && (value.forkOrigin === undefined || value.forkOrigin === null || (
      isRecord(value.forkOrigin) && typeof value.forkOrigin.artifactId === "string" && typeof value.forkOrigin.versionId === "string"
    ))
    && (value.provenance === undefined || value.provenance === null || (
      isRecord(value.provenance) && typeof value.provenance.sourceType === "string"
      && typeof value.provenance.sourceUrl === "string" && typeof value.provenance.sourceRef === "string"
      && typeof value.provenance.importedAt === "string"
    ))
    && ["active", "published", "discarded"].includes(String(value.state))
    && Number.isInteger(value.revision) && typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}

function isDraftSummary(value: unknown): value is DraftSummary {
  return isRecord(value)
    && typeof value.id === "string"
    && (typeof value.artifactId === "string" || value.artifactId === null)
    && (typeof value.baseVersionId === "string" || value.baseVersionId === null)
    && typeof value.name === "string" && typeof value.slug === "string"
    && isVisibility(value.visibility) && value.state === "active"
    && Number.isInteger(value.revision)
    && typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}

function isPublishedVersion(value: unknown): value is PublishedVersion {
  if (!isRecord(value) || !isRecord(value.artifact) || !isRecord(value.version)) return false;
  return typeof value.artifact.id === "string" && typeof value.artifact.name === "string"
    && typeof value.artifact.slug === "string" && isVisibility(value.artifact.visibility)
    && typeof value.version.id === "string" && typeof value.version.artifactId === "string"
    && typeof value.version.version === "string" && typeof value.version.contentHash === "string"
    && typeof value.version.publishedAt === "string" && isPublishedContent(value.version.content);
}

function isArtifactMetadata(value: unknown): value is ArtifactMetadata {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.ownerId === "string"
    && typeof value.name === "string"
    && typeof value.slug === "string"
    && isVisibility(value.visibility)
    && (value.status === "active" || value.status === "tombstone")
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string";
}

function isArtifactLineageEntry(value: unknown): value is ArtifactLineageEntry {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.parentArtifactId === "string"
    && typeof value.childArtifactId === "string"
    && (typeof value.sourceVersionId === "string" || value.sourceVersionId === null)
    && value.relationshipType === "fork"
    && typeof value.createdAt === "string"
    && isArtifactMetadata(value.artifact);
}

function isArtifactLineage(value: unknown): value is ArtifactLineage {
  return isRecord(value)
    && Array.isArray(value.parents)
    && value.parents.every(isArtifactLineageEntry)
    && Array.isArray(value.children)
    && value.children.every(isArtifactLineageEntry);
}

function isDraftContent(value: unknown): value is DraftContent {
  return isRecord(value) && typeof value.instructions === "string"
    && (value.tags === undefined || (Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string")))
    && Array.isArray(value.knowledgeFiles) && value.knowledgeFiles.every((file) => isRecord(file) && typeof file.path === "string" && typeof file.content === "string")
    && Array.isArray(value.dependencies) && value.dependencies.every((dependency) => isRecord(dependency) && typeof dependency.targetArtifactId === "string" && typeof dependency.declaredRange === "string");
}

function isPublishedContent(value: unknown): value is PublishedContent {
  return isRecord(value) && typeof value.instructions === "string"
    && (value.tags === undefined || (Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string")))
    && Array.isArray(value.knowledgeFiles) && value.knowledgeFiles.every((file) => isRecord(file) && typeof file.path === "string" && typeof file.content === "string" && typeof file.contentHash === "string")
    && Array.isArray(value.dependencies) && value.dependencies.every((dependency) => isRecord(dependency) && typeof dependency.targetArtifactId === "string" && typeof dependency.declaredRange === "string");
}

function isVisibility(value: unknown): value is ArtifactVisibility {
  return value === "private" || value === "unlisted" || value === "public";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
