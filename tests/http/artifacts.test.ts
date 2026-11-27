import { afterEach, describe, expect, it, vi } from "vitest";
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

function makeApp(
  listExecute: (input: ArtifactDiscoveryQuery) => Promise<ArtifactDiscoveryPage> = async () => ({ items: [], nextCursor: null }),
  corsOrigins?: string[],
) {
  return createHttpApp({
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

describe("deployment health endpoints", () => {
  it("returns process liveness without dependencies", async () => {
    const response = await makeApp().request("/health");
    expect(response.status).toBe(200);
  });

  it("returns readiness success when PostgreSQL is reachable", async () => {
    const app = createHttpApp({
      listArtifacts: { execute: async () => ({ items: [], nextCursor: null }) },
      authenticator,
      readinessCheck: async () => {},
    });
    const response = await app.request("/readyz");
    expect(response.status).toBe(200);
  });

  it("returns generic readiness failure when PostgreSQL is unreachable", async () => {
    const app = createHttpApp({
      listArtifacts: { execute: async () => ({ items: [], nextCursor: null }) },
      authenticator,
      readinessCheck: async () => { throw new Error("database details must stay private"); },
    });
    const response = await app.request("/readyz");
    expect(response.status).toBe(503);
  });
});

describe("POST /api/v1/artifacts", () => {
  it("retires direct Artifact creation so all new identities publish atomically", async () => {
    const response = await postArtifact(makeApp(), JSON.stringify(requestBody));

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: "ARTIFACT_CREATION_REQUIRES_DRAFT" } });
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
      const response = await makeApp(listExecute).request("/api/v1/artifacts?q=%20Pearl%20&tag=language-model&tag=rag");

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
      const response = await makeApp(listExecute).request(
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

    it("logs useful diagnostics for unexpected errors without logging credentials or query values", async () => {
      const error = Object.assign(new Error("Database query failed"), { code: "XX000" });
      const logError = vi.spyOn(console, "error").mockImplementation(() => {});
      const listExecute = vi.fn(async () => {
        throw error;
      });
      const response = await makeApp(listExecute).request(
        "/api/v1/artifacts?q=private-query-value&limit=20&sort=createdAt&order=desc",
        { headers: { authorization: `Bearer ${authToken}` } },
      );

      expect(response.status).toBe(500);
      expect(logError).toHaveBeenCalledWith("Unhandled HTTP error", expect.objectContaining({
        method: "GET",
        path: "/api/v1/artifacts",
        errorName: "Error",
        errorCode: "XX000",
        message: "Database query failed",
      }));
      const loggedDetails = JSON.stringify(logError.mock.calls);
      expect(loggedDetails).not.toContain(authToken);
      expect(loggedDetails).not.toContain("private-query-value");
    });

    it.each([
      "/api/v1/artifacts?q=%20%20",
      "/api/v1/artifacts?q=ab&limit=0",
      "/api/v1/artifacts?limit=2&limit=3",
      "/api/v1/artifacts?tag=Bad_Tag",
      "/api/v1/artifacts?unknown=true",
    ])("rejects invalid discovery query %s", async (url) => {
      const listExecute = vi.fn(async () => ({ items: [], nextCursor: null }));
      const response = await makeApp(listExecute).request(url);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      expect(listExecute).not.toHaveBeenCalled();
    });
});

describe("POST /api/v1/artifacts additional validation", () => {
  it("returns 401 when authentication fails", async () => {
    const response = await postArtifact(makeApp(), JSON.stringify(requestBody), "");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  describe("Development CORS", () => {
    it("allows the configured frontend origin to preflight API requests", async () => {
      const app = makeApp(undefined, ["http://localhost:3000"]);
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
      const app = makeApp(undefined, ["http://localhost:3000"]);
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
      const authorizedPost = await app.request("/api/v1/artifacts", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      expect(authorizedPost.status).toBe(410);
      expect(authorizedPost.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    });

    it("leaves CORS disabled unless allowed origins are explicitly provided", async () => {
      const response = await makeApp().request("/api/v1/artifacts", {
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
    const response = await postArtifact(makeApp(), body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("serves an OpenAPI 3.1 contract consistent with the runtime route", async () => {
    const app = makeApp();
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
    expect(operation?.responses).toHaveProperty("410");
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
