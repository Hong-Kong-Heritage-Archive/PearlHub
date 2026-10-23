import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImportForm from "../components/import-form";
import PublishedVersionView from "../components/published-version";

const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));

const publishedResponse = {
  artifact: {
    id: "source-artifact", ownerId: "owner-1", name: "Source Pearl", slug: "source-pearl",
    visibility: "public", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  },
  version: {
    id: "source-version-id", artifactId: "source-artifact", version: "2.3.1",
    contentHash: `sha256:${"a".repeat(64)}`, publishedAt: "2026-01-01T00:00:00.000Z",
    content: { instructions: "Source content", knowledgeFiles: [], dependencies: [] },
  },
};

function draftResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft-123", ownerId: "owner-1", artifactId: null, baseVersionId: null,
    name: "Imported Pearl", slug: "imported-pearl", visibility: "private",
    content: { instructions: "# Imported\n", knowledgeFiles: [], dependencies: [] },
    forkOrigin: null, provenance: null, state: "active", revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  routerPush.mockReset();
});

describe("Fork and Import Thin UI", () => {
  it("creates a Draft from the explicitly selected published Version", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ url, init });
      if (init.method === "GET") return mockResponse(publishedResponse);
      return mockResponse(draftResponse({
        name: "Fork Pearl",
        slug: "fork-pearl",
        forkOrigin: { artifactId: "source-artifact", versionId: "source-version-id" },
      }), 201);
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    render(<PublishedVersionView artifactId="source-artifact" version="2.3.1" />);

    fireEvent.change(screen.getByLabelText(/bearer token/i), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load published version" }));
    expect(await screen.findByRole("heading", { name: "Source Pearl — 2.3.1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fork this version" }));
    expect(screen.getByText("Fork source:")).toHaveTextContent("Source Pearl — version 2.3.1");
    fireEvent.change(screen.getByLabelText("New Artifact name"), { target: { value: "Fork Pearl" } });
    fireEvent.change(screen.getByLabelText("New Artifact slug"), { target: { value: "fork-pearl" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Fork Draft" }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith("/draft/draft-123"));
    expect(calls[1]?.url.pathname).toBe("/api/v1/artifacts/source-artifact/fork");
    expect(calls[1]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      sourceVersion: "2.3.1", name: "Fork Pearl", slug: "fork-pearl", visibility: "private",
    });
    expect(routerPush).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["pasted", { sourceType: "pasted", content: "# Exact pasted content\n\nKeep spaces.\n" }],
    ["github", { sourceType: "github", sourceUrl: "https://raw.githubusercontent.com/acme/pearls/main/SKILL.md" }],
  ] as const)("creates a %s Import Draft from the actual API response", async (mode, requestFields) => {
    let requestBody: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === "POST") requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return mockResponse(draftResponse({
        provenance: mode === "github" ? {
          sourceType: "github",
          sourceUrl: "https://raw.githubusercontent.com/acme/pearls/main/SKILL.md",
          sourceRef: "main",
          importedAt: "2026-01-01T00:00:00.000Z",
        } : null,
      }), init.method === "POST" ? 201 : 200);
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    render(<ImportForm />);
    fireEvent.change(screen.getByLabelText(/developer bearer token/i), { target: { value: "importer-token" } });
    fireEvent.change(screen.getByLabelText("Artifact name"), { target: { value: "Imported Pearl" } });
    fireEvent.change(screen.getByLabelText("Artifact slug"), { target: { value: "imported-pearl" } });

    if (mode === "pasted") {
      fireEvent.change(screen.getByRole("textbox", { name: /Markdown\/Skill content/ }), { target: { value: requestFields.content } });
    } else {
      fireEvent.click(screen.getByRole("radio", { name: "GitHub raw URL" }));
      fireEvent.change(screen.getByRole("textbox", { name: /Supported GitHub raw URL/ }), { target: { value: requestFields.sourceUrl } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Create Import Draft" }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith("/draft/draft-123"));
    expect(new URL(String(fetch.mock.calls.at(-1)?.[0])).pathname).toBe("/api/v1/imports/github");
    expect(requestBody).toEqual({
      ...requestFields,
      name: "Imported Pearl",
      slug: "imported-pearl",
      visibility: "private",
    });
    expect(routerPush).toHaveBeenCalledTimes(1);
  });

  it("does not navigate or report success for a malformed Import response", async () => {
    const fetch = vi.fn(async () => mockResponse({ id: "" }, 201));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    render(<ImportForm />);
    fireEvent.change(screen.getByLabelText(/developer bearer token/i), { target: { value: "token" } });
    fireEvent.change(screen.getByLabelText("Artifact name"), { target: { value: "Imported Pearl" } });
    fireEvent.change(screen.getByLabelText("Artifact slug"), { target: { value: "imported-pearl" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Markdown\/Skill content/ }), { target: { value: "Markdown" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Import Draft" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("unexpected Draft response");
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("prevents duplicate Import requests while the API is pending", async () => {
    let resolveResponse: (response: Response) => void = () => {};
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    render(<ImportForm />);
    fireEvent.change(screen.getByLabelText(/developer bearer token/i), { target: { value: "token" } });
    fireEvent.change(screen.getByLabelText("Artifact name"), { target: { value: "Imported Pearl" } });
    fireEvent.change(screen.getByLabelText("Artifact slug"), { target: { value: "imported-pearl" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Markdown\/Skill content/ }), { target: { value: "Markdown" } });

    const submit = screen.getByRole("button", { name: "Create Import Draft" });
    act(() => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => resolveResponse(mockResponse(draftResponse(), 201)));
    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledTimes(1));
  });
});
