import { afterEach, describe, expect, it, vi } from "vitest";
import { getVersionCompatibilityReports, getVersionDependencies } from "../lib/drafts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Artifact Version read API", () => {
  it("validates dependency declarations and each resolution state", async () => {
    const dependencies = {
      artifactId: "source-artifact",
      version: "1.2.3",
      dependencies: [
        { targetArtifactId: "none-target", declaredRange: "^1.0.0", resolutionState: "none", resolutions: [] },
        {
          targetArtifactId: "available-target",
          declaredRange: "~2.0.0",
          resolutionState: "available",
          resolutions: [{ version: "2.0.4", resolvedAt: "2026-10-01T10:00:00.000Z" }],
        },
        { targetArtifactId: "redacted-target", declaredRange: ">=3.0.0", resolutionState: "redacted", resolutions: [] },
      ],
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, options: RequestInit) => {
      expect(input).toBeInstanceOf(URL);
      expect(options.method).toBe("GET");
      return jsonResponse(dependencies);
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");

    await expect(getVersionDependencies("source-artifact", "1.2.3", "temporary-token")).resolves.toEqual(dependencies);
    const [url, options] = fetch.mock.calls[0]!;
    expect(new URL(url instanceof Request ? url.url : String(url)).pathname)
      .toBe("/api/v1/artifacts/source-artifact/versions/1.2.3/dependencies");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer temporary-token");
  });

  it("accepts an empty dependency list and rejects malformed dependency data", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ artifactId: "source-artifact", version: "1.2.3", dependencies: [] }))
      .mockResolvedValueOnce(jsonResponse({
        artifactId: "source-artifact",
        version: "1.2.3",
        dependencies: [{ targetArtifactId: "target", declaredRange: "*", resolutionState: "hidden", resolutions: [] }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        artifactId: "source-artifact",
        version: "1.2.3",
        dependencies: [{
          targetArtifactId: "target",
          declaredRange: "*",
          resolutionState: "redacted",
          resolutions: [{ version: "hidden-version", resolvedAt: "2026-10-01T10:00:00.000Z" }],
        }],
      }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");

    await expect(getVersionDependencies("source-artifact", "1.2.3")).resolves.toEqual({
      artifactId: "source-artifact",
      version: "1.2.3",
      dependencies: [],
    });
    await expect(getVersionDependencies("source-artifact", "1.2.3"))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(getVersionDependencies("source-artifact", "1.2.3"))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("accepts available and redacted compatibility reports without treating redaction as persisted status", async () => {
    const reports = [
      {
        id: "available-report",
        artifactVersionId: "source-version",
        targetArtifactVersionId: "visible-target-version",
        status: "unavailable",
        report: { reason: "Test evidence" },
        createdAt: "2026-10-01T10:00:00.000Z",
        availability: "available",
      },
      {
        id: "redacted-report",
        artifactVersionId: "source-version",
        targetArtifactVersionId: null,
        status: "unavailable",
        report: {},
        createdAt: "2026-10-02T10:00:00.000Z",
        availability: "redacted",
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(reports)));
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");

    await expect(getVersionCompatibilityReports("source-artifact", "1.2.3")).resolves.toEqual(reports);
  });

  it("accepts empty compatibility reports and rejects malformed or leaking redacted reports", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{
        id: "bad-report",
        artifactVersionId: "source-version",
        targetArtifactVersionId: "hidden-target-version",
        status: "unavailable",
        report: {},
        createdAt: "2026-10-02T10:00:00.000Z",
        availability: "redacted",
      }]))
      .mockResolvedValueOnce(jsonResponse([{
        id: "bad-report",
        artifactVersionId: "source-version",
        targetArtifactVersionId: null,
        status: "unavailable",
        report: { hidden: "target-derived detail" },
        createdAt: "2026-10-02T10:00:00.000Z",
        availability: "redacted",
      }]));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");

    await expect(getVersionCompatibilityReports("source-artifact", "1.2.3")).resolves.toEqual([]);
    await expect(getVersionCompatibilityReports("source-artifact", "1.2.3"))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(getVersionCompatibilityReports("source-artifact", "1.2.3"))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([401, 403])("preserves HTTP %i authorization errors", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      error: { code: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", message: "Request denied.", details: {} },
    }, status)));
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");

    await expect(getVersionDependencies("source-artifact", "1.2.3"))
      .rejects.toMatchObject({ status });
  });
});
