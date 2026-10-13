import type { ApiErrorResponse } from "../contracts/dto.js";
import { DomainError } from "../domain/errors.js";

export type HttpErrorStatus = 400 | 401 | 409 | 500;

export interface MappedHttpError {
  status: HttpErrorStatus;
  body: ApiErrorResponse;
}

export function mapHttpError(error: unknown): MappedHttpError {
  if (error instanceof DomainError) {
    switch (error.code) {
      case "INVALID_REQUEST":
        return { status: 400, body: toErrorResponse(error) };
      case "UNAUTHENTICATED":
        return { status: 401, body: toErrorResponse(error) };
      case "ARTIFACT_SLUG_CONFLICT":
        return { status: 409, body: toErrorResponse(error) };
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
      details: error.details,
    },
  };
}
