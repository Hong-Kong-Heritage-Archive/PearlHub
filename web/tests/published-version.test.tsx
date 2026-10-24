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
  it("loads a public published Version without sending a bearer token", async () => {
    const requests: Array<{ input: RequestInfo | URL; init: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
      artifact: { id: "public-artifact", ownerId: "owner-1", name: "Public Pearl", slug: "public-pearl", visibility: "public", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      version: { id: "public-version", artifactId: "public-artifact", version: "1.0.0", contentHash: `sha256:${"a".repeat(64)}`, publishedAt: "2026-01-01T00:00:00.000Z", content: { instructions: "Public instructions", knowledgeFiles: [], dependencies: [] } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    render(<PublishedVersionView artifactId="public-artifact" version="1.0.0" />);

    fireEvent.click(screen.getByRole("button", { name: "Load published version" }));

    expect(await screen.findByRole("heading", { name: "Public Pearl — 1.0.0" })).toBeInTheDocument();
    expect(new URL(requests[0]!.input instanceof Request ? requests[0]!.input.url : String(requests[0]!.input)).pathname)
      .toBe("/api/v1/artifacts/public-artifact/versions/1.0.0");
    expect(new Headers(requests[0]!.init.headers).has("authorization")).toBe(false);
  });

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

  it("creates a Clone Draft from the selected immutable Version and navigates to it", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const mock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({ url, init });
      if (init.method === "POST") {
        return new Response(JSON.stringify({
          id: "clone-draft", ownerId: "cloner", artifactId: null, baseVersionId: null,
          name: "Independent Pearl", slug: "independent-pearl", visibility: "public",
          content: { instructions: "Source snapshot", knowledgeFiles: [], dependencies: [] },
          forkOrigin: null, provenance: null, state: "active", revision: 1,
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        artifact: { id: "source-id", ownerId: "owner-id", name: "Source", slug: "source", visibility: "public", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        version: { id: "source-version-id", artifactId: "source-id", version: "2.3.1", contentHash: `sha256:${"a".repeat(64)}`, publishedAt: "2026-01-01T00:00:00.000Z", content: { instructions: "Source snapshot", knowledgeFiles: [], dependencies: [] } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", mock);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    render(<PublishedVersionView artifactId="source-id" version="2.3.1" />);
    fireEvent.change(screen.getByLabelText(/bearer token/i), { target: { value: "cloner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load published version" }));
    expect(await screen.findByRole("heading", { name: "Source — 2.3.1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clone this version" }));
    expect(screen.getByText(/Clone creates no PearlHub lineage/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New Artifact name"), { target: { value: "Independent Pearl" } });
    fireEvent.change(screen.getByLabelText("New Artifact slug"), { target: { value: "independent-pearl" } });
    fireEvent.change(screen.getByLabelText("Visibility after publication"), { target: { value: "public" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Clone Draft" }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith("/draft/clone-draft"));
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url.pathname).toBe("/api/v1/artifacts/source-id/clone");
    expect(requests[1]?.init.method).toBe("POST");
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      sourceVersion: "2.3.1",
      name: "Independent Pearl",
      slug: "independent-pearl",
      visibility: "public",
    });
    expect(routerPush).toHaveBeenCalledTimes(1);
  });

  it("does not navigate or report Clone success when the API rejects the request", async () => {
    const mock = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => init.method === "POST"
      ? new Response(JSON.stringify({
        error: { code: "VERSION_CONTENT_UNAVAILABLE", message: "Source snapshot unavailable.", details: {} },
      }), { status: 409, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({
        artifact: { id: "source-id", ownerId: "owner-id", name: "Source", slug: "source", visibility: "public", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        version: { id: "source-version-id", artifactId: "source-id", version: "1.0.0", contentHash: `sha256:${"a".repeat(64)}`, publishedAt: "2026-01-01T00:00:00.000Z", content: { instructions: "Source snapshot", knowledgeFiles: [], dependencies: [] } },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", mock);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    render(<PublishedVersionView artifactId="source-id" version="1.0.0" />);
    fireEvent.change(screen.getByLabelText(/bearer token/i), { target: { value: "cloner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load published version" }));
    expect(await screen.findByRole("heading", { name: "Source — 1.0.0" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clone this version" }));
    fireEvent.change(screen.getByLabelText("New Artifact name"), { target: { value: "Clone" } });
    fireEvent.change(screen.getByLabelText("New Artifact slug"), { target: { value: "clone" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Clone Draft" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Source snapshot unavailable.");
    expect(routerPush).not.toHaveBeenCalled();
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
