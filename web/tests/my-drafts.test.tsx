import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MyDrafts from "../components/my-drafts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("My Drafts", () => {
  it("loads private Draft summaries with the bearer token and links to the editor", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(JSON.stringify([{
      id: "draft-123",
      artifactId: null,
      baseVersionId: null,
      name: "Private Pearl",
      slug: "private-pearl",
      visibility: "private",
      state: "active",
      revision: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      }]), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");

    render(<MyDrafts />);
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "temporary-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load My Drafts" }));

    expect(await screen.findByRole("heading", { name: "Private Pearl" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Draft" })).toHaveAttribute("href", "/draft/draft-123");
    expect(fetch).toHaveBeenCalledTimes(1);
    const { input: url, init } = requests[0]!;
    expect(new URL(url instanceof Request ? url.url : String(url)).pathname).toBe("/api/v1/drafts");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer temporary-token");
  });

  it("reports an empty owner-scoped list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    render(<MyDrafts />);
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load My Drafts" }));

    expect(await screen.findByRole("status")).toHaveTextContent("No active Drafts found");
  });
});
