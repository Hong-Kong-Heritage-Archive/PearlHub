import * as semver from "semver";
import { DomainError } from "./errors.js";

export function parseSemVer(version: string): semver.SemVer {
  const parsed = semver.parse(version, { loose: false });
  if (!parsed || parsed.version !== version) {
    throw new DomainError("INVALID_SEMVER", `Invalid SemVer version: ${version}`, { version });
  }
  return parsed;
}

export function validateSemVerRange(range: string): string {
  if (range.trim().length === 0 || semver.validRange(range, { loose: false }) === null) {
    throw new DomainError("INVALID_SEMVER_RANGE", `Invalid SemVer range: ${range}`, { range });
  }
  return range;
}

export function satisfiesSemVer(version: string, range: string): boolean {
  parseSemVer(version);
  validateSemVerRange(range);
  return semver.satisfies(version, range, { includePrerelease: false });
}