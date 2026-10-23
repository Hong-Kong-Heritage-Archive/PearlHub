import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PublishedVersionView from "../components/published-version";

const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  routerPush.mockReset();
});

describe("published version view", () => {
  it("renders immutable content and creates a work-copy from the selected version", async () => {
    const mock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/versions/0.1.0") && init.method === "GET") {
        return new Response(JSON.stringify({
          artifact: { id: "artifact-1", ownerId: "owner-1", name: "Pearl", slug: "pearl", visibility: "public", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
          version: { id: "version-1", artifactId: "artifact-1", version: "0.1.0", contentHash: `sha256:${"a".repeat(64)}`, publishedAt: "2026-01-01T00:00:00.000Z", content: { instructions: "Original immutable instructions", knowledgeFiles: [{ path: "guide.md", content: "Read-only file", contentHash: `sha256:${"b".repeat(64)}` }], dependencies: [{ targetArtifactId: "dependency-1", declaredRange: "^2.1.0" }] } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "draft-copy", ownerId: "owner-1", artifactId: "artifact-1", baseVersionId: "version-1",
        name: "Pearl", slug: "pearl", visibility: "public",
        content: { instructions: "Original immutable instructions", knowledgeFiles: [{ path: "guide.md", content: "Read-only file" }], dependencies: [{ targetArtifactId: "dependency-1", declaredRange: "^2.1.0" }] },
        state: "active", revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }), { status: 201, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", mock);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    render(<PublishedVersionView artifactId="artifact-1" version="0.1.0" />);
    fireEvent.change(screen.getByLabelText(/bearer token/), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load published version" }));

    expect(await screen.findByRole("heading", { name: "Pearl — 0.1.0" })).toBeInTheDocument();
    expect(screen.getByText("Original immutable instructions")).toBeInTheDocument();
    expect(screen.getByText("Read-only file")).toBeInTheDocument();
    expect(screen.getByText("dependency-1 ^2.1.0")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Instructions/)).not.toBeInTheDocument();

    const workCopyButton = screen.getByRole("button", { name: "Create work-copy from this version" });
    act(() => {
      fireEvent.click(workCopyButton);
      fireEvent.click(workCopyButton);
    });
    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith("/draft/draft-copy"));
    expect(mock).toHaveBeenCalledTimes(2);
    const [url, init = {}] = mock.mock.calls[1]!;
    expect(new URL(url instanceof Request ? url.url : String(url)).pathname).toBe("/api/v1/artifacts/artifact-1/versions/0.1.0/work-copy");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("tombstones an Artifact only after confirmation and reports success", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({ url, init });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({
        artifact: { id: "artifact-1", ownerId: "owner-1", name: "Pearl", slug: "pearl", visibility: "public", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        version: { id: "version-1", artifactId: "artifact-1", version: "0.1.0", contentHash: `sha256:${"a".repeat(64)}`, publishedAt: "2026-01-01T00:00:00.000Z", content: { instructions: "Instructions", knowledgeFiles: [], dependencies: [] } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    render(<PublishedVersionView artifactId="artifact-1" version="0.1.0" />);
    fireEvent.change(screen.getByLabelText(/bearer token/), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load published version" }));
    expect(await screen.findByRole("heading", { name: "Pearl — 0.1.0" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tombstone Artifact" }));
    expect(screen.getByText(/make the Artifact unavailable for normal use/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Confirm tombstone" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Artifact tombstoned");
    expect(screen.queryByRole("heading", { name: "Pearl — 0.1.0" })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requests[1]?.url.pathname).toBe("/api/v1/artifacts/artifact-1");
    expect(requests[1]?.init.method).toBe("DELETE");
    expect(new Headers(requests[1]?.init.headers).get("authorization")).toMatch(/^Bearer\s+\S+$/);
  });
});
