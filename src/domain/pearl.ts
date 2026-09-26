import { DomainError } from "./errors.js";
import { parseSemVer } from "./semver.js";

export interface PearlContent {
  version: string;
  skill: Record<string, unknown>;
  knowledge: unknown[];
  [key: string]: unknown;
}

export function parsePearlContent(value: unknown): PearlContent {
  if (!isRecord(value) || typeof value.version !== "string" || !isRecord(value.skill) || !Array.isArray(value.knowledge) || !isJsonValue(value)) {
    throw new DomainError("IMPORT_INVALID_FORMAT", "Pearl content must be a JSON object with a SemVer version, Skill object, and Knowledge array.");
  }
  parseSemVer(value.version);
  return value as PearlContent;
}

function isJsonValue(value: unknown, ancestors = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from(value).every((item) => isJsonValue(item, ancestors))
    : isRecord(value) && Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}