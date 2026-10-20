import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DraftEditor from "../components/draft-editor";

const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  routerPush.mockReset();
});

function draftResponse(input: Record<string, unknown>, revision = 1) {
  return {
    id: "draft-123",
    ownerId: "owner-456",
    artifactId: null,
    baseVersionId: null,
    name: input.name,
    slug: input.slug,
    visibility: input.visibility,
    content: input.content,
    state: "active",
    revision,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function response(body: unknown, status = 201): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetch() {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url, init });
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.pathname.endsWith("/drafts") && init.method === "POST") return response(draftResponse(body));
    if (url.pathname.endsWith("/draft-123") && init.method === "PUT") return response(draftResponse(body, Number(body.revision) + 1), 200);
    if (url.pathname.endsWith("/draft-123/publish")) {
      return response({
        artifact: { id: "artifact-1", ownerId: "owner-456", name: "Pearl", slug: "pearl", visibility: "public", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        version: { id: "version-1", artifactId: "artifact-1", version: "0.1.0", contentHash: `sha256:${"a".repeat(64)}`, publishedAt: "2026-01-01T00:00:00.000Z", content: { ...(body.content as object ?? {}), instructions: "Instructions", knowledgeFiles: [], dependencies: [] } },
      });
    }
    throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
  });
  vi.stubGlobal("fetch", mock);
  vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
  return { mock, requests };
}

describe("Draft editor", () => {
  it("creates, edits, previews, then publishes with one Publish API request", async () => {
    const { mock, requests } = installFetch();
    render(<DraftEditor />);
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "temporary-token" } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Pearl" } });
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: "pearl" } });
    fireEvent.change(screen.getByLabelText(/Instructions/), { target: { value: "Instructions" } });
    fireEvent.click(screen.getByRole("button", { name: "Add knowledge file" }));
    fireEvent.change(screen.getByLabelText("Relative path"), { target: { value: "guide.md" } });
    fireEvent.change(screen.getByLabelText("File content"), { target: { value: "Knowledge" } });
    fireEvent.click(screen.getByRole("button", { name: "Add dependency" }));
    fireEvent.change(screen.getByLabelText("Target Artifact ID"), { target: { value: "target-id" } });
    fireEvent.change(screen.getByLabelText("Declared SemVer range"), { target: { value: "^2.1.0" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Draft" }));

    expect(await screen.findByRole("button", { name: "Save Draft" })).toBeInTheDocument();
    expect(screen.getByText("Draft — not published")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Preview Draft content"));
    expect(screen.getByText("guide.md")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Instructions/), { target: { value: "Updated instructions" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    await waitFor(() => expect(requests.some(({ init }) => init.method === "PUT")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Publish Draft" }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/artifacts/artifact-1/versions/0.1.0"));
    expect(mock).toHaveBeenCalledTimes(3);
    expect(requests.map(({ init }) => init.method)).toEqual(["POST", "PUT", "POST"]);
    expect(requests[0]?.url.pathname).toBe("/api/v1/drafts");
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe("Bearer temporary-token");
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      name: "Pearl", slug: "pearl", visibility: "private",
      content: { instructions: "Instructions", knowledgeFiles: [{ path: "guide.md", content: "Knowledge" }], dependencies: [{ targetArtifactId: "target-id", declaredRange: "^2.1.0" }] },
    });
    expect(requests[2]?.url.pathname).toBe("/api/v1/drafts/draft-123/publish");
    expect(JSON.parse(String(requests[2]?.init.body))).toEqual({ revision: 2 });
  });

  it("preserves Draft fields when the server reports a stale revision", async () => {
    const initial = draftResponse({
      name: "Pearl", slug: "pearl", visibility: "private",
      content: { instructions: "Original", knowledgeFiles: [], dependencies: [] },
    });
    const fetch = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => init.method === "GET"
      ? response(initial, 200)
      : response({ error: { code: "DRAFT_REVISION_CONFLICT", message: "stale", details: {} } }, 409));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    render(<DraftEditor draftId="draft-123" />);
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load Draft" }));
    fireEvent.change(await screen.findByLabelText(/Instructions/), { target: { value: "Unsaved change" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere");
    expect(screen.getByLabelText(/Instructions/)).toHaveValue("Unsaved change");
    expect(screen.getByLabelText(/Developer bearer token/)).toHaveValue("token");
  });
});
