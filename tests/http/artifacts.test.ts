import { afterEach, describe, expect, it, vi } from "vitest";
import { Artifact } from "../../src/domain/artifact.js";
import { DomainError } from "../../src/domain/errors.js";
import { createHttpApp } from "../../src/http/app.js";
import { DevelopmentOnlyFakeAuthenticator } from "../../src/http/testing/development-fake-authenticator.js";

const authenticatedUserId = "internal-user-42";
const authToken = "phase-b-test-token";
const authenticator = new DevelopmentOnlyFakeAuthenticator(authenticatedUserId, authToken);
const requestBody = {
  name: "Example Pearl",
  slug: "example-pearl",
  visibility: "public",
};

function makeArtifact(overrides: Partial<{ id: string; ownerId: string; name: string; slug: string }> = {}) {
  return Artifact.create({
    id: overrides.id ?? "artifact-123",
    ownerId: overrides.ownerId ?? authenticatedUserId,
    name: overrides.name ?? requestBody.name,
    slug: overrides.slug ?? requestBody.slug,
    visibility: "public",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

function makeApp(execute: (input: { actorId: string; name: string; slug: string; visibility: "private" | "unlisted" | "public" }) => Promise<Artifact>) {
  return createHttpApp({
    createArtifact: { execute },
    authenticator,
  });
}

function postArtifact(app: ReturnType<typeof createHttpApp>, body: string, token = authToken) {
  return app.request("/api/v1/artifacts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/v1/artifacts", () => {
  it("creates an Artifact through the Application use case", async () => {
    const execute = vi.fn(async () => makeArtifact());
    const response = await postArtifact(makeApp(execute), JSON.stringify(requestBody));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: "artifact-123",
      ownerId: authenticatedUserId,
      name: "Example Pearl",
      slug: "example-pearl",
      visibility: "public",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(execute).toHaveBeenCalledWith({
      actorId: authenticatedUserId,
      name: "Example Pearl",
      slug: "example-pearl",
      visibility: "public",
    });
  });

  it("returns 401 when authentication fails", async () => {
    const execute = vi.fn(async () => makeArtifact());
    const response = await postArtifact(makeApp(execute), JSON.stringify(requestBody), "");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{\"name\":"],
    ["invalid fields", JSON.stringify({ ...requestBody, slug: "Invalid Slug" })],
    ["unexpected owner field", JSON.stringify({ ...requestBody, ownerId: "attacker" })],
  ])("rejects %s at the HTTP boundary", async (_description, body) => {
    const execute = vi.fn(async () => makeArtifact());
    const response = await postArtifact(makeApp(execute), body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns 409 for a slug conflict reported by the Application layer", async () => {
    const execute = vi.fn(async () => {
      throw new DomainError("ARTIFACT_SLUG_CONFLICT", "Artifact slug is already used by this owner.", { slug: requestBody.slug });
    });
    const response = await postArtifact(makeApp(execute), JSON.stringify(requestBody));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "ARTIFACT_SLUG_CONFLICT" } });
  });

  it("maps unexpected errors to a generic response without exposing internals", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const execute = vi.fn(async () => {
      throw new Error("SQLSTATE 23505 constraint artifacts_owner_slug_key; secret-value");
    });
    const response = await postArtifact(makeApp(execute), JSON.stringify(requestBody));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toBe(JSON.stringify({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
        details: {},
      },
    }));
    expect(body).not.toMatch(/SQLSTATE|constraint|secret-value|Error:|at /);
    expect(log).toHaveBeenCalledOnce();
  });

  it("serves an OpenAPI 3.1 contract consistent with the runtime route", async () => {
    const app = makeApp(async () => makeArtifact());
    const response = await app.request("/openapi.json");
    const document = await response.json() as {
      openapi: string;
      paths: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> }; responses?: Record<string, unknown>; security?: unknown }>>;
      components?: { schemas?: Record<string, { properties?: Record<string, unknown>; additionalProperties?: unknown }>; securitySchemes?: Record<string, unknown> };
    };
    const operation = document.paths["/api/v1/artifacts"]?.post;
    const requestSchemaRef = operation?.requestBody?.content?.["application/json"]?.schema?.$ref;
    const requestSchemaName = requestSchemaRef?.split("/").at(-1);

    expect(response.status).toBe(200);
    expect(document.openapi).toBe("3.1.0");
    expect(operation?.responses).toHaveProperty("201");
    expect(operation?.responses).toHaveProperty("400");
    expect(operation?.responses).toHaveProperty("401");
    expect(operation?.responses).toHaveProperty("409");
    expect(operation?.responses).toHaveProperty("500");
    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    expect(document.components?.securitySchemes).toHaveProperty("BearerAuth");
    expect(document.components?.schemas?.[requestSchemaName ?? ""]?.properties).toHaveProperty("name");
    expect(document.components?.schemas?.[requestSchemaName ?? ""]?.properties).not.toHaveProperty("ownerId");
    expect(document.components?.schemas?.[requestSchemaName ?? ""]?.additionalProperties).toBe(false);
  });
});
