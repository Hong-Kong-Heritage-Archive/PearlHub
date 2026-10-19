import { afterEach, describe, expect, it, vi } from "vitest";
import { Artifact } from "../../src/domain/artifact.js";
import type { ArtifactDiscoveryPage, ArtifactDiscoveryQuery } from "../../src/domain/discovery.js";
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

function makeApp(
  execute: (input: { actorId: string; name: string; slug: string; visibility: "private" | "unlisted" | "public" }) => Promise<Artifact>,
  listExecute: (input: ArtifactDiscoveryQuery) => Promise<ArtifactDiscoveryPage> = async () => ({ items: [], nextCursor: null }),
  corsOrigins?: string[],
) {
  return createHttpApp({
    createArtifact: { execute },
    listArtifacts: { execute: listExecute },
    authenticator,
    ...(corsOrigins === undefined ? {} : { corsOrigins }),
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
});

describe("GET /api/v1/artifacts", () => {
    it("allows anonymous discovery without the create route's JSON or authentication requirements", async () => {
      const listExecute = vi.fn(async () => ({
        items: [{
          id: "artifact-123",
          name: "Example Pearl",
          slug: "example-pearl",
          visibility: "public" as const,
          tags: ["language-model", "rag"],
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        }],
        nextCursor: null,
      }));
      const response = await makeApp(async () => makeArtifact(), listExecute).request("/api/v1/artifacts?q=%20Pearl%20&tag=language-model&tag=rag");

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({
        items: [{
          id: "artifact-123",
          name: "Example Pearl",
          slug: "example-pearl",
          visibility: "public",
          tags: ["language-model", "rag"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }],
        nextCursor: null,
      });
      expect(listExecute).toHaveBeenCalledWith({
        callerId: null,
        q: "Pearl",
        tags: ["language-model", "rag"],
        limit: 20,
        sort: "createdAt",
        direction: "desc",
      });
});

    it("passes an authenticated owner identity without exposing it in the summary", async () => {
      const listExecute = vi.fn(async () => ({ items: [], nextCursor: null }));
      const response = await makeApp(async () => makeArtifact(), listExecute).request(
        "/api/v1/artifacts?visibility=private",
        { headers: { authorization: `Bearer ${authToken}` } },
      );

      expect(response.status).toBe(200);
      expect(listExecute).toHaveBeenCalledWith({
        callerId: authenticatedUserId,
        tags: [],
        visibility: "private",
        limit: 20,
        sort: "createdAt",
        direction: "desc",
      });
    });

    it.each([
      "/api/v1/artifacts?q=%20%20",
      "/api/v1/artifacts?q=ab&limit=0",
      "/api/v1/artifacts?limit=2&limit=3",
      "/api/v1/artifacts?tag=Bad_Tag",
      "/api/v1/artifacts?unknown=true",
    ])("rejects invalid discovery query %s", async (url) => {
      const listExecute = vi.fn(async () => ({ items: [], nextCursor: null }));
      const response = await makeApp(async () => makeArtifact(), listExecute).request(url);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      expect(listExecute).not.toHaveBeenCalled();
    });
});

describe("POST /api/v1/artifacts additional validation", () => {
  it("returns 401 when authentication fails", async () => {
    const execute = vi.fn(async () => makeArtifact());
    const response = await postArtifact(makeApp(execute), JSON.stringify(requestBody), "");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(execute).not.toHaveBeenCalled();
  });

  describe("Development CORS", () => {
    it("allows the configured frontend origin to preflight API requests", async () => {
      const app = makeApp(async () => makeArtifact(), undefined, ["http://localhost:3000"]);
      const response = await app.request("/api/v1/artifacts", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
      expect(response.headers.get("access-control-allow-methods")).toContain("POST");
      expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    });

    it("does not grant CORS to unconfigured origins and still requires POST authentication", async () => {
      const execute = vi.fn(async () => makeArtifact());
      const app = makeApp(execute, undefined, ["http://localhost:3000"]);
      const preflight = await app.request("/api/v1/artifacts", {
        method: "OPTIONS",
        headers: {
          origin: "https://untrusted.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type",
        },
      });
      const post = await app.request("/api/v1/artifacts", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
      expect(post.status).toBe(401);
      expect(post.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
      expect(execute).not.toHaveBeenCalled();

      const authorizedPost = await app.request("/api/v1/artifacts", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      expect(authorizedPost.status).toBe(201);
      expect(authorizedPost.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
      expect(execute).toHaveBeenCalledOnce();
    });

    it("leaves CORS disabled unless allowed origins are explicitly provided", async () => {
      const response = await makeApp(async () => makeArtifact()).request("/api/v1/artifacts", {
        headers: { origin: "http://localhost:3000" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  it.each([
    ["malformed JSON", "{\"name\":"],
    ["invalid fields", JSON.stringify({ ...requestBody, slug: "Invalid Slug" })],
    ["unexpected owner field", JSON.stringify({ ...requestBody, ownerId: "attacker" })],
    ["unexpected tags field", JSON.stringify({ ...requestBody, tags: ["rag"] })],
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
