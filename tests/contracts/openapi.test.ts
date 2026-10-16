import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Artifact } from "../../src/domain/artifact.js";
import { createHttpApp } from "../../src/http/app.js";
import { DevelopmentOnlyFakeAuthenticator } from "../../src/http/testing/development-fake-authenticator.js";

interface OpenApiSchema {
  type?: string;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
  enum?: string[];
  readOnly?: boolean;
  $ref?: string;
}

interface OpenApiOperation {
  security?: Array<Record<string, string[]>>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: OpenApiSchema }>;
  };
  responses?: Record<string, {
    content?: Record<string, { schema?: OpenApiSchema }>;
  }>;
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, { post?: OpenApiOperation }>;
  components: {
    schemas: Record<string, OpenApiSchema>;
    securitySchemes: Record<string, Record<string, unknown>>;
  };
}

const canonicalDocument = parse(readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8")) as OpenApiDocument;

function resolveSchema(document: OpenApiDocument, schema: OpenApiSchema | undefined): OpenApiSchema | undefined {
  const schemaName = schema?.$ref?.match(/^#\/components\/schemas\/(.+)$/)?.[1];
  return schemaName ? document.components.schemas[schemaName] : schema;
}

function createRuntimeApp() {
  const ownerId = "internal-user-42";
  return createHttpApp({
    createArtifact: {
      execute: async (input) => Artifact.create({
        id: "artifact-123",
        ownerId: input.actorId,
        name: input.name,
        slug: input.slug,
        visibility: input.visibility,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    },
    authenticator: new DevelopmentOnlyFakeAuthenticator(ownerId, "contract-test-token"),
  });
}

describe("canonical OpenAPI contract", () => {
  it("defines only the implemented Artifact creation operation under /api/v1", () => {
    expect(canonicalDocument.openapi).toBe("3.1.0");
    expect(canonicalDocument.info.title).toBe("PearlHub API");
    expect(canonicalDocument.paths).toHaveProperty("/api/v1/artifacts");
    expect(canonicalDocument.paths).not.toHaveProperty("/api/v1/pearls");
    expect(Object.keys(canonicalDocument.paths)).toEqual(["/api/v1/artifacts"]);
    expect(canonicalDocument.paths["/api/v1/artifacts"]?.post).toBeDefined();
  });

  it("strictly describes create identity, visibility, and response fields", () => {
    const requestSchema = canonicalDocument.components.schemas.CreateArtifactRequest;
    const artifactSchema = canonicalDocument.components.schemas.Artifact;

    expect(requestSchema?.additionalProperties).toBe(false);
    expect(Object.keys(requestSchema?.properties ?? {}).sort()).toEqual(["name", "slug", "visibility"]);
    expect(requestSchema?.required?.slice().sort()).toEqual(["name", "slug", "visibility"]);
    expect(requestSchema?.properties?.visibility?.enum).toEqual(["private", "unlisted", "public"]);

    expect(Object.keys(artifactSchema?.properties ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "name",
      "ownerId",
      "slug",
      "status",
      "updatedAt",
      "visibility",
    ]);
    for (const immutableField of ["id", "name", "slug", "ownerId"]) {
      expect(artifactSchema?.properties?.[immutableField]?.readOnly).toBe(true);
    }
    expect(artifactSchema?.properties?.visibility?.enum).toEqual(["private", "unlisted", "public"]);
    expect(artifactSchema?.properties?.status?.enum).toEqual(["active", "tombstone"]);
  });

  it("documents bearer authentication, runtime response statuses, and the stable error envelope", () => {
    const operation = canonicalDocument.paths["/api/v1/artifacts"]?.post;
    const responseCodes = Object.keys(operation?.responses ?? {}).sort();
    const errorSchema = canonicalDocument.components.schemas.ApiError;
    const errorObject = errorSchema?.properties?.error;

    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    expect(canonicalDocument.components.securitySchemes.BearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(responseCodes).toEqual(["201", "400", "401", "409", "500"]);
    expect(Object.keys(errorObject?.properties ?? {}).sort()).toEqual(["code", "details", "message"]);
    expect(errorSchema?.required).toContain("error");
    expect(errorObject?.required?.slice().sort()).toEqual(["code", "details", "message"]);
    expect(errorObject?.properties?.details?.type).toBe("object");
  });

  it("matches the canonical create contract to the runtime-generated /openapi.json", async () => {
    const response = await createRuntimeApp().request("/openapi.json");
    const runtimeDocument = parse(await response.text()) as OpenApiDocument;
    const canonicalOperation = canonicalDocument.paths["/api/v1/artifacts"]?.post;
    const runtimeOperation = runtimeDocument.paths["/api/v1/artifacts"]?.post;
    const canonicalRequest = resolveSchema(
      canonicalDocument,
      canonicalOperation?.requestBody?.content?.["application/json"]?.schema,
    );
    const runtimeRequest = resolveSchema(
      runtimeDocument,
      runtimeOperation?.requestBody?.content?.["application/json"]?.schema,
    );

    expect(response.status).toBe(200);
    expect(runtimeDocument.openapi).toBe("3.1.0");
    expect(runtimeOperation).toBeDefined();
    expect(runtimeOperation?.security).toEqual(canonicalOperation?.security);
    expect(Object.keys(runtimeOperation?.responses ?? {}).sort()).toEqual(
      Object.keys(canonicalOperation?.responses ?? {}).sort(),
    );
    expect(runtimeRequest?.additionalProperties).toBe(false);
    expect(Object.keys(runtimeRequest?.properties ?? {}).sort()).toEqual(
      Object.keys(canonicalRequest?.properties ?? {}).sort(),
    );
    expect(runtimeRequest?.required?.slice().sort()).toEqual(canonicalRequest?.required?.slice().sort());

    const canonicalResponse = resolveSchema(
      canonicalDocument,
      canonicalOperation?.responses?.["201"]?.content?.["application/json"]?.schema,
    );
    const runtimeResponse = resolveSchema(
      runtimeDocument,
      runtimeOperation?.responses?.["201"]?.content?.["application/json"]?.schema,
    );
    expect(Object.keys(runtimeResponse?.properties ?? {}).sort()).toEqual(
      Object.keys(canonicalResponse?.properties ?? {}).sort(),
    );
    expect(runtimeResponse?.required?.slice().sort()).toEqual(canonicalResponse?.required?.slice().sort());

    const canonicalError = resolveSchema(
      canonicalDocument,
      canonicalOperation?.responses?.["400"]?.content?.["application/json"]?.schema,
    );
    const runtimeError = resolveSchema(
      runtimeDocument,
      runtimeOperation?.responses?.["400"]?.content?.["application/json"]?.schema,
    );
    expect(Object.keys(runtimeError?.properties ?? {}).sort()).toEqual(
      Object.keys(canonicalError?.properties ?? {}).sort(),
    );
    expect(Object.keys(runtimeError?.properties?.error?.properties ?? {}).sort()).toEqual(
      Object.keys(canonicalError?.properties?.error?.properties ?? {}).sort(),
    );
    expect(runtimeError?.required?.slice().sort()).toEqual(canonicalError?.required?.slice().sort());
    expect(runtimeError?.properties?.error?.required?.slice().sort()).toEqual(
      canonicalError?.properties?.error?.required?.slice().sort(),
    );
  });
});
