import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../../src/http/app.js";
import { DevelopmentOnlyFakeAuthenticator } from "../../src/http/testing/development-fake-authenticator.js";

function makeApp(readinessCheck?: () => Promise<void>) {
  return createHttpApp({
    listArtifacts: { execute: async () => ({ items: [], nextCursor: null }) },
    authenticator: new DevelopmentOnlyFakeAuthenticator("health-user", "health-token"),
    ...(readinessCheck === undefined ? {} : { readinessCheck }),
  });
}

describe("health endpoints", () => {
  it("reports liveness without exposing configuration", async () => {
    const response = await makeApp().request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("reports readiness when the dependency check succeeds", async () => {
    const readinessCheck = vi.fn(async () => {});
    const response = await makeApp(readinessCheck).request("/readyz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
    expect(readinessCheck).toHaveBeenCalledOnce();
  });

  it("returns a generic unavailable response when readiness fails", async () => {
    const readinessCheck = vi.fn(async () => {
      throw new Error("postgres://user:password@private-host/database");
    });
    const response = await makeApp(readinessCheck).request("/readyz");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });
});
