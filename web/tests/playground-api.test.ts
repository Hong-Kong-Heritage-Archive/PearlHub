import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVersionDependencies } from "../lib/drafts";
import { getCurrentFirebaseIdToken } from "../lib/firebase-auth";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const manifest = {
  runId: "run-1",
  sourceArtifactVersionId: "source-version",
  createdAt: "2026-11-12T00:00:00.000Z",
  manifestVersion: 1,
  resolverPolicyVersion: "semver-highest-v1",
  manifestHash: `sha256:${"a".repeat(64)}`,
  dependencies: [{
    dependencyId: "dependency-1",
    targetArtifactId: "target-artifact",
    declaredRange: "^2.0.0",
    resolvedArtifactVersionId: "target-version",
    resolvedVersion: "2.3.1",
    resolvedContentHash: `sha256:${"b".repeat(64)}`,
    resolvedAt: "2026-11-12T00:00:00.000Z",
  }],
};

describe("Playground dependency resolution client", () => {
  it("posts a bodyless request and validates the exact resolution manifest", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    vi.mocked(getCurrentFirebaseIdToken).mockResolvedValue("firebase-id-token");

    await expect(resolveVersionDependencies("source-artifact", "1.0.0")).resolves.toEqual(manifest);
    const [input, options] = fetch.mock.calls[0]!;
    expect(new URL(input instanceof Request ? input.url : String(input)).pathname)
      .toBe("/api/v1/artifacts/source-artifact/versions/1.0.0/dependency-resolutions");
    expect(options?.method).toBe("POST");
    expect(options?.body).toBeUndefined();
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer firebase-id-token");
  });

  it("rejects malformed or incomplete resolution manifests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...manifest,
      dependencies: [{
        ...manifest.dependencies[0],
        resolvedContentHash: "not-a-content-hash",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");

    await expect(resolveVersionDependencies("source-artifact", "1.0.0"))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("retrieves the current ID token for every API request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    vi.mocked(getCurrentFirebaseIdToken)
      .mockReset()
      .mockResolvedValueOnce("refreshed-id-token-1")
      .mockResolvedValueOnce("refreshed-id-token-2");

    await resolveVersionDependencies("source-artifact", "1.0.0");
    await resolveVersionDependencies("source-artifact", "1.0.0");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization"))
      .toBe("Bearer refreshed-id-token-1");
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get("authorization"))
      .toBe("Bearer refreshed-id-token-2");
    expect(getCurrentFirebaseIdToken).toHaveBeenCalledTimes(2);
  });

  it("surfaces API authorization and resolver errors without successful fallbacks", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "UNAUTHENTICATED", message: "Authentication is required.", details: {} },
      }), { status: 401, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "DEPENDENCY_RESOLUTION_FAILED", message: "A dependency could not be resolved.", details: {} },
      }), { status: 400, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");

    await expect(resolveVersionDependencies("source-artifact", "1.0.0"))
      .rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    await expect(resolveVersionDependencies("source-artifact", "1.0.0"))
      .rejects.toMatchObject({ status: 400, code: "DEPENDENCY_RESOLUTION_FAILED" });
  });
});
