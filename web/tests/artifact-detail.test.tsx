import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ArtifactDetail from "../components/artifact-detail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const artifact = {
  id: "child-id",
  ownerId: "owner-id",
  name: "Forked Artifact",
  slug: "forked-artifact",
  visibility: "public",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("Artifact detail page", () => {
  it("renders detail and lineage from the actual API responses", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/lineage")) {
        return response({
          parents: [{
            id: "edge-id",
            parentArtifactId: "parent-id",
            childArtifactId: "child-id",
            sourceVersionId: "source-version-id",
            relationshipType: "fork",
            createdAt: "2026-01-03T00:00:00.000Z",
            artifact: { ...artifact, id: "parent-id", name: "Parent Artifact", slug: "parent-artifact" },
          }],
          children: [],
        });
      }
      return response(artifact);
    });
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "http://localhost:8080");
    vi.stubGlobal("fetch", fetch);

    render(<ArtifactDetail artifactId="child-id" />);

    expect(await screen.findByRole("heading", { name: "Forked Artifact" })).toBeInTheDocument();
    expect(screen.getByText(/Parent Artifact \(parent-artifact\)/)).toBeInTheDocument();
    expect(screen.getByText(/source Version ID: source-version-id/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)).pathname))
      .toEqual(expect.arrayContaining([
        "/api/v1/artifacts/child-id",
        "/api/v1/artifacts/child-id/lineage",
      ]));
  });

  it("shows empty lineage and never fabricates details after a tombstone response", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/lineage")) return response({ parents: [], children: [] });
      return response({ error: { code: "ARTIFACT_GONE", message: "Artifact has been tombstoned.", details: {} } }, 410);
    });
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "http://localhost:8080");
    vi.stubGlobal("fetch", fetch);

    render(<ArtifactDetail artifactId="child-id" />);

    expect(await screen.findByText(/has been tombstoned/)).toBeInTheDocument();
    expect(screen.queryByText("Forked Artifact")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Fork lineage" })).not.toBeInTheDocument();
  });

  it("uses the in-memory bearer token for owner-authorized reads and supports retry", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!new Headers(init?.headers).has("authorization")) {
        return response({ error: { code: "ARTIFACT_NOT_FOUND", message: "Not visible.", details: {} } }, 404);
      }
      const url = new URL(_input instanceof Request ? _input.url : String(_input));
      return url.pathname.endsWith("/lineage")
        ? response({ parents: [], children: [] })
        : response(artifact);
    });
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "http://localhost:8080");
    vi.stubGlobal("fetch", fetch);

    render(<ArtifactDetail artifactId="child-id" />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/bearer token/i), { target: { value: "temporary-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load with token" }));

    expect(await screen.findByRole("heading", { name: "Forked Artifact" })).toBeInTheDocument();
    expect(await screen.findByText("No visible Fork lineage.")).toBeInTheDocument();
    expect(fetch.mock.calls.some(([, init]) =>
      new Headers(init?.headers).get("authorization") === "Bearer temporary-token")).toBe(true);
  });
});
