export const errorCodes = [
  "ARTIFACT_NOT_FOUND",
  "VERSION_NOT_FOUND",
  "DEPENDENCY_NOT_FOUND",
  "ARTIFACT_NAME_IMMUTABLE",
  "ARTIFACT_SLUG_IMMUTABLE",
  "ARTIFACT_OWNER_IMMUTABLE",
  "VERSION_IMMUTABLE",
  "INVALID_SEMVER",
  "INVALID_SEMVER_RANGE",
  "INVALID_REQUEST",
  "IMPORT_INVALID_FORMAT",
  "VERSION_ALREADY_EXISTS",
  "LINEAGE_INVALID",
  "DEPENDENCY_RESOLUTION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "ARTIFACT_SLUG_CONFLICT",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DomainError";
  }
}