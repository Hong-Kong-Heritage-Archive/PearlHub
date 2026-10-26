import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../../src/http/app.js";
import { DevelopmentOnlyFakeAuthenticator } from "../../src/http/testing/development-fake-authenticator.js";

describe("GET /api/v1/me", () => {
  it("returns only the authenticated principal's user ID", async () => {
    const authenticate = vi.fn(async () => ({ userId: "internal-user-42" }));
    const app = createHttpApp({
      listArtifacts: { execute: async () => ({ items: [], nextCursor: null }) },
      authenticator: { authenticate },
    });

    const response = await app.request("/api/v1/me", {
      headers: { authorization: "Bearer secret-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ userId: "internal-user-42" });
    expect(body).not.toContain("secret-token");
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it("rejects anonymous callers with the standard error envelope", async () => {
    const app = createHttpApp({
      listArtifacts: { execute: async () => ({ items: [], nextCursor: null }) },
      authenticator: new DevelopmentOnlyFakeAuthenticator("internal-user-42", "valid-token"),
    });

    const response = await app.request("/api/v1/me");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
        details: {},
      },
    });
  });
});
