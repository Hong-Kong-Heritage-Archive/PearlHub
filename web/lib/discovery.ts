export type ArtifactVisibility = "public" | "private" | "unlisted";
export type ArtifactSort = "createdAt" | "updatedAt" | "name";
export type ArtifactOrder = "asc" | "desc";

export interface DiscoveryFilters {
  q: string;
  tags: string[];
  sort: ArtifactSort;
  order: ArtifactOrder;
  limit: number;
  visibility: ArtifactVisibility | "";
}

export interface ArtifactSummary {
  id: string;
  name: string;
  slug: string;
  visibility: ArtifactVisibility;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactDiscoveryPage {
  items: ArtifactSummary[];
  nextCursor: string | null;
}

export interface CreateArtifactInput {
  name: string;
  slug: string;
  visibility: ArtifactVisibility;
}

export interface CreatedArtifact {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  visibility: ArtifactVisibility;
  status: "active" | "tombstone";
  createdAt: string;
  updatedAt: string;
}

export class DiscoveryRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DiscoveryRequestError";
  }
}

export class CreateArtifactRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: "name" | "slug" | "visibility",
  ) {
    super(message);
    this.name = "CreateArtifactRequestError";
  }
}

export function buildDiscoveryUrl(
  baseUrl: string,
  filters: DiscoveryFilters,
  cursor?: string | null,
): URL {
  const url = buildArtifactsEndpointUrl(baseUrl);

  const params = url.searchParams;
  const query = filters.q.trim();
  if (query) params.set("q", query);
  for (const tag of filters.tags) params.append("tag", tag);
  params.set("limit", String(filters.limit));
  params.set("sort", filters.sort);
  params.set("order", filters.order);
  if (filters.visibility) params.set("visibility", filters.visibility);
  if (cursor) params.set("cursor", cursor);

  return url;
}

export async function createArtifact(
  input: CreateArtifactInput,
  token: string,
  signal?: AbortSignal,
): Promise<CreatedArtifact> {
  const baseUrl = process.env.NEXT_PUBLIC_PEARLHUB_API_BASE_URL ?? "http://localhost:8080";
  const response = await fetch(buildArtifactsEndpointUrl(baseUrl), {
    method: "POST",
    redirect: "error",
    ...(signal ? { signal } : {}),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: input.name,
      slug: input.slug,
      visibility: input.visibility,
    }),
  });

  if (response.status !== 201) {
    throw await toCreateArtifactError(response);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CreateArtifactRequestError(
      "The API response could not be confirmed. Check the Artifact before trying again.",
      response.status,
    );
  }
  if (!isCreatedArtifact(payload)) {
    throw new CreateArtifactRequestError(
      "The API returned an unexpected response. The Artifact may have been created; verify before retrying.",
      response.status,
    );
  }
  return payload;
}

export async function requestArtifacts(
  filters: DiscoveryFilters,
  cursor: string | null,
  signal: AbortSignal,
): Promise<ArtifactDiscoveryPage> {
  const baseUrl = process.env.NEXT_PUBLIC_PEARLHUB_API_BASE_URL ?? "http://localhost:8080";
  const response = await fetch(buildDiscoveryUrl(baseUrl, filters, cursor), {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    const apiMessage = await readApiErrorMessage(response);
    if (response.status === 400) {
      throw new DiscoveryRequestError(apiMessage ?? "Check the search filters and try again.", 400);
    }
    if (response.status === 503) {
      throw new DiscoveryRequestError("Artifact discovery is temporarily unavailable. Please try again.", 503);
    }
    throw new DiscoveryRequestError("Unable to load Artifacts. Please try again.", response.status);
  }

  const payload: unknown = await response.json();
  if (!isDiscoveryPage(payload)) {
    throw new Error("The discovery response has an unexpected format.");
  }
  return payload;
}

function buildArtifactsEndpointUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("The PearlHub API base URL is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("The PearlHub API base URL must use HTTP(S) and must not include credentials.");
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/api/v1/artifacts")) {
    url.pathname = path;
  } else if (path.endsWith("/api/v1")) {
    url.pathname = `${path}/artifacts`;
  } else {
    url.pathname = `${path}/api/v1/artifacts`;
  }
  url.search = "";
  url.hash = "";
  return url;
}

export function isDiscoveryPage(value: unknown): value is ArtifactDiscoveryPage {
  if (!isRecord(value) || !Array.isArray(value.items)) return false;
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") return false;
  return value.items.every(isArtifactSummary);
}

function isCreatedArtifact(value: unknown): value is CreatedArtifact {
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

async function toCreateArtifactError(response: Response): Promise<CreateArtifactRequestError> {
  if (response.status === 401) {
    return new CreateArtifactRequestError(
      "Authentication failed. Enter a valid bearer token issued for the PearlHub API.",
      response.status,
    );
  }

  const apiError = await readApiError(response);
  if (response.status === 400) {
    return new CreateArtifactRequestError(
      apiError?.message ?? "The API rejected the Artifact details. Review the fields and try again.",
      response.status,
      apiError?.field,
    );
  }
  if (response.status === 409) {
    return new CreateArtifactRequestError(
      apiError?.message ?? "An Artifact with this slug already exists for this owner.",
      response.status,
      apiError?.field,
    );
  }
  return new CreateArtifactRequestError(
    `The API could not create this Artifact (HTTP ${response.status}). Please try again.`,
    response.status,
  );
}

async function readApiError(
  response: Response,
): Promise<{ message: string; field?: "name" | "slug" | "visibility" } | null> {
  try {
    const value: unknown = await response.json();
    if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string") return null;
    const field = isRecord(value.error.details) ? value.error.details.field : undefined;
    return {
      message: value.error.message,
      ...(field === "name" || field === "slug" || field === "visibility" ? { field } : {}),
    };
  } catch {
    return null;
  }
}

async function readApiErrorMessage(response: Response): Promise<string | null> {
  try {
    const value: unknown = await response.json();
    if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string") return null;
    return value.error.message;
  } catch {
    return null;
  }
}

function isArtifactSummary(value: unknown): value is ArtifactSummary {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.slug === "string"
    && isVisibility(value.visibility)
    && Array.isArray(value.tags)
    && value.tags.every((tag) => typeof tag === "string")
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string";
}

function isVisibility(value: unknown): value is ArtifactVisibility {
  return value === "public" || value === "private" || value === "unlisted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
