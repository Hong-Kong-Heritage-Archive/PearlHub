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

export class DiscoveryRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DiscoveryRequestError";
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

export async function requestArtifacts(
  filters: DiscoveryFilters,
  cursor: string | null,
  signal: AbortSignal,
  token?: string,
): Promise<ArtifactDiscoveryPage> {
  const baseUrl = process.env.NEXT_PUBLIC_PEARLHUB_API_BASE_URL;
  if (!baseUrl?.trim()) {
    throw new DiscoveryRequestError("The PearlHub API base URL is not configured.", 0);
  }
  const headers = new Headers({ Accept: "application/json" });
  if (token?.trim()) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(buildDiscoveryUrl(baseUrl, filters, cursor), {
    headers,
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
    if (response.status === 401) {
      throw new DiscoveryRequestError("The bearer token was rejected. Check it and try again.", 401);
    }
    if (response.status === 403) {
      throw new DiscoveryRequestError("You do not have permission to view these Artifacts.", 403);
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
