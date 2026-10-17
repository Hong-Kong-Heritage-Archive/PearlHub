import { DomainError } from "./errors.js";

export const maximumPearlTags = 10;
export const maximumPearlTagLength = 50;

const tagPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type DiscoverySort = "createdAt" | "updatedAt" | "name";
export type DiscoveryDirection = "asc" | "desc";
export type DiscoveryVisibility = "public" | "unlisted" | "private";

export interface ArtifactSummary {
  id: string;
  name: string;
  slug: string;
  visibility: DiscoveryVisibility;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ArtifactDiscoveryQuery {
  callerId: string | null;
  q?: string;
  tags: string[];
  visibility?: DiscoveryVisibility;
  limit: number;
  sort: DiscoverySort;
  direction: DiscoveryDirection;
  cursor?: string;
}

export interface ArtifactDiscoveryCursorPosition {
  sortValue: string;
  id: string;
}

export interface ArtifactDiscoveryPageRow {
  item: ArtifactSummary;
  sortValue: string;
}

export interface ArtifactDiscoveryPage {
  items: ArtifactSummary[];
  nextCursor: string | null;
}

export function normalizePearlTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > maximumPearlTags) {
    throw invalidTags("Pearl tags must be an array containing no more than 10 tags.");
  }

  const tags: string[] = [];
  const seen = new Set<string>();
  for (const valueTag of value) {
    if (typeof valueTag !== "string") {
      throw invalidTags("Each Pearl tag must be a string.");
    }
    const tag = valueTag.trim().toLowerCase();
    if (tag.length === 0 || tag.length > maximumPearlTagLength || !tagPattern.test(tag)) {
      throw invalidTags("Pearl tags must be 1 to 50 lowercase letters or numbers, with single hyphens between segments.");
    }
    if (seen.has(tag)) {
      throw invalidTags("Pearl tags must be unique after normalization.");
    }
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

export function normalizePearlContent<T extends Record<string, unknown>>(content: T): T {
  if (!Object.prototype.hasOwnProperty.call(content, "tags")) return content;
  return { ...content, tags: normalizePearlTags(content.tags) };
}

export function readPearlTags(content: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DomainError("INVALID_REQUEST", "Stored Pearl content is not valid JSON.");
    }
    throw error;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_REQUEST", "Stored Pearl content must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, "tags") ? normalizePearlTags(record.tags) : [];
}

function invalidTags(message: string): DomainError {
  return new DomainError("INVALID_REQUEST", message, { field: "tags" });
}
