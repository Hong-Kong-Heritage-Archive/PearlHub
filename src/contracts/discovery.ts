import { DomainError } from "../domain/errors.js";
import type {
  ArtifactDiscoveryQuery,
  DiscoveryDirection,
  DiscoverySort,
  DiscoveryVisibility,
} from "../domain/discovery.js";
import { normalizePearlTags } from "../domain/discovery.js";

const allowedParameters = new Set(["q", "tag", "limit", "cursor", "sort", "order", "visibility"]);

export function parseArtifactDiscoveryQuery(params: URLSearchParams, callerId: string | null): ArtifactDiscoveryQuery {
  for (const key of params.keys()) {
    if (!allowedParameters.has(key)) {
      throw new DomainError("INVALID_REQUEST", "Unsupported discovery query parameter.", { field: key });
    }
  }

  const qValue = single(params, "q");
  const q = qValue?.trim();
  if (q !== undefined && (q.length < 1 || q.length > 100)) {
    throw new DomainError("INVALID_REQUEST", "Search query must contain 1 to 100 characters.", { field: "q" });
  }

  const tagValues = params.getAll("tag");
  const tags = normalizePearlTags(tagValues);
  const limitValue = single(params, "limit");
  let limit = 20;
  if (limitValue !== undefined) {
    if (!/^[0-9]+$/.test(limitValue)) {
      throw new DomainError("INVALID_REQUEST", "Limit must be an integer from 1 to 100.", { field: "limit" });
    }
    limit = Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError("INVALID_REQUEST", "Limit must be an integer from 1 to 100.", { field: "limit" });
    }
  }

  const cursor = single(params, "cursor");
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 1024)) {
    throw new DomainError("INVALID_REQUEST", "Cursor must contain 1 to 1024 characters.", { field: "cursor" });
  }

  const sortValue = single(params, "sort") ?? "createdAt";
  if (!["createdAt", "updatedAt", "name"].includes(sortValue)) {
    throw new DomainError("INVALID_REQUEST", "Unsupported discovery sort.", { field: "sort" });
  }
  const directionValue = single(params, "order") ?? "desc";
  if (!["asc", "desc"].includes(directionValue)) {
    throw new DomainError("INVALID_REQUEST", "Order must be asc or desc.", { field: "order" });
  }
  const visibilityValue = single(params, "visibility");
  if (visibilityValue !== undefined && !["public", "unlisted", "private"].includes(visibilityValue)) {
    throw new DomainError("INVALID_REQUEST", "Unsupported visibility filter.", { field: "visibility" });
  }

  return {
    callerId,
    ...(q === undefined ? {} : { q }),
    tags,
    ...(visibilityValue === undefined ? {} : { visibility: visibilityValue as DiscoveryVisibility }),
    limit,
    sort: sortValue as DiscoverySort,
    direction: directionValue as DiscoveryDirection,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function single(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) {
    throw new DomainError("INVALID_REQUEST", `Query parameter ${name} may only be provided once.`, { field: name });
  }
  return values[0];
}
