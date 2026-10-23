import type { ApiErrorResponse } from "../contracts/dto.js";
import { DomainError } from "../domain/errors.js";

export type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 500 | 502 | 503 | 504;

export interface MappedHttpError {
  status: HttpErrorStatus;
  body: ApiErrorResponse;
}

export function mapHttpError(error: unknown): MappedHttpError {
  if (error instanceof DomainError) {
    switch (error.code) {
      case "INVALID_REQUEST":
      case "INVALID_SEMVER":
      case "INVALID_SEMVER_RANGE":
      case "IMPORT_INVALID_FORMAT":
      case "IMPORT_SOURCE_INVALID":
      case "IMPORT_CONTENT_TOO_LARGE":
      case "ARTIFACT_NAME_IMMUTABLE":
      case "ARTIFACT_SLUG_IMMUTABLE":
      case "ARTIFACT_OWNER_IMMUTABLE":
      case "LINEAGE_INVALID":
      case "DEPENDENCY_RESOLUTION_FAILED":
        return { status: 400, body: toErrorResponse(error) };
      case "UNAUTHENTICATED":
        return { status: 401, body: toErrorResponse(error) };
      case "FORBIDDEN":
        return { status: 403, body: toErrorResponse(error) };
      case "ARTIFACT_NOT_FOUND":
      case "VERSION_NOT_FOUND":
      case "DRAFT_NOT_FOUND":
        return { status: 404, body: toErrorResponse(error) };
      case "ARTIFACT_GONE":
        return { status: 410, body: toErrorResponse(error) };
      case "ARTIFACT_SLUG_CONFLICT":
      case "VERSION_ALREADY_EXISTS":
      case "VERSION_IMMUTABLE":
      case "DRAFT_ALREADY_ACTIVE":
      case "DRAFT_NOT_ACTIVE":
      case "DRAFT_REVISION_CONFLICT":
      case "VERSION_CONTENT_UNAVAILABLE":
        return { status: 409, body: toErrorResponse(error) };
      case "ARTIFACT_CREATION_REQUIRES_DRAFT":
        return { status: 410, body: toErrorResponse(error) };
      case "DISCOVERY_NOT_READY":
        return { status: 503, body: toErrorResponse(error) };
      case "IMPORT_SOURCE_UNAVAILABLE":
        return { status: 502, body: toErrorResponse(error) };
      case "IMPORT_SOURCE_TIMEOUT":
        return { status: 504, body: toErrorResponse(error) };
    }
  }

  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
        details: {},
      },
    },
  };
}

function toErrorResponse(error: DomainError): ApiErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: {},
    },
  };
}
