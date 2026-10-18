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
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/v1/artifacts`;
  url.search = "";
  url.hash = "";

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
