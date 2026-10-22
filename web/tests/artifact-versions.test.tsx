import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ArtifactVersions from "../components/artifact-versions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Artifact versions", () => {
  it("loads published versions from the selected Artifact and links to the requested version", async () => {
    const requestedUrls: URL[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(new URL(input instanceof Request ? input.url : String(input)));
      return new Response(JSON.stringify([{
        artifact: {
          id: "artifact-1",
          ownerId: "owner-1",
          name: "Pearl",
          slug: "pearl",
          visibility: "public",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        version: {
          id: "version-1",
          artifactId: "artifact-1",
          version: "0.1.0",
          contentHash: `sha256:${"a".repeat(64)}`,
          publishedAt: "2026-01-01T00:00:00.000Z",
          content: { instructions: "Read-only", knowledgeFiles: [], dependencies: [] },
        },
      }]), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    vi.stubGlobal("fetch", fetch);

    render(<ArtifactVersions artifactId="artifact-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Load versions" }));

    const versionLink = await screen.findByRole("link", { name: "Pearl — 0.1.0" });
    expect(versionLink).toHaveAttribute("href", "/artifacts/artifact-1/versions/0.1.0");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestedUrls[0]?.pathname)
      .toBe("/api/v1/artifacts/artifact-1/versions");
  });
});
