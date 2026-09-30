import * as semver from "semver";
import { DomainError } from "./errors.js";

export function parseSemVer(version: string): semver.SemVer {
  const parsed = semver.parse(version, { loose: false });
  const canonical = parsed
    ? `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease.length ? `-${parsed.prerelease.join(".")}` : ""}${parsed.build.length ? `+${parsed.build.join(".")}` : ""}`
    : null;
  if (!parsed || canonical !== version) {
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