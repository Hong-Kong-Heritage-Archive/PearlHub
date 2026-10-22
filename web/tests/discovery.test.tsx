import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ArtifactDiscovery from "../components/artifact-discovery";
import {
  buildDiscoveryUrl,
  type ArtifactSummary,
  type DiscoveryFilters,
} from "../lib/discovery";

const filters: DiscoveryFilters = {
  q: "Pearl",
  tags: ["rag", "language-model"],
  sort: "updatedAt",
  order: "asc",
  limit: 50,
  visibility: "public",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function artifact(id: string, name = `Pearl ${id}`): ArtifactSummary {
  return {
    id,
    name,
    slug: `pearl-${id}`,
    visibility: "public",
    tags: ["rag"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) =>
    handler(new URL(input instanceof Request ? input.url : String(input)), init));
  vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("buildDiscoveryUrl", () => {
  it("uses the documented endpoint, preserves repeated tags, and serializes every filter", () => {
    const url = buildDiscoveryUrl("http://localhost:8080/", filters, "opaque==cursor");

    expect(url.pathname).toBe("/api/v1/artifacts");
    expect(url.searchParams.getAll("tag")).toEqual(["rag", "language-model"]);
    expect(url.searchParams.get("q")).toBe("Pearl");
    expect(url.searchParams.get("sort")).toBe("updatedAt");
    expect(url.searchParams.get("order")).toBe("asc");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("visibility")).toBe("public");
    expect(url.searchParams.get("cursor")).toBe("opaque==cursor");
    expect([...url.searchParams.keys()].sort()).toEqual(
      ["cursor", "limit", "order", "q", "sort", "tag", "tag", "visibility"].sort(),
    );
    expect(buildDiscoveryUrl("https://api.example.test/api/v1", filters).pathname).toBe("/api/v1/artifacts");
  });
});

describe("Artifact discovery page", () => {
  it("renders API summaries without owner IDs and calls only the documented route", async () => {
    installFetch(() => jsonResponse({
      items: [{ ...artifact("1"), ownerId: "must-not-render" }],
      nextCursor: null,
    }));

    render(<ArtifactDiscovery />);

    expect(await screen.findByRole("heading", { name: "Pearl 1" })).toBeInTheDocument();
    expect(screen.getByText("pearl-1")).toBeInTheDocument();
    expect(screen.getByText("rag")).toBeInTheDocument();
    expect(screen.queryByText("must-not-render")).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 1 Artifact in this API page/)).toBeInTheDocument();
    const [requestedUrl] = vi.mocked(fetch).mock.calls[0]!;
    expect(new URL(String(requestedUrl)).pathname).toBe("/api/v1/artifacts");
  });

  it("shows an empty state for an empty page", async () => {
    installFetch(() => jsonResponse({ items: [], nextCursor: null }));
    render(<ArtifactDiscovery />);

    expect(await screen.findByRole("heading", { name: "No Artifacts found" })).toBeInTheDocument();
    expect(screen.queryByText(/total results/i)).not.toBeInTheDocument();
  });

  it("uses an optional owner token to list private Artifacts", async () => {
    const mock = installFetch((_url, init) => new Headers(init.headers).has("authorization")
      ? jsonResponse({
        items: [{ ...artifact("owner-private", "My private Pearl"), visibility: "private" }],
        nextCursor: null,
      })
      : jsonResponse({ items: [], nextCursor: null }));
    render(<ArtifactDiscovery />);
    expect(await screen.findByRole("heading", { name: "No Artifacts found" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply bearer token" }));

    expect(await screen.findByRole("heading", { name: "My private Pearl" })).toBeInTheDocument();
    const ownerRequest = mock.mock.calls.find(([, init]) =>
      new Headers(init?.headers).get("authorization") === "Bearer owner-token");
    expect(ownerRequest).toBeDefined();
    expect(screen.getByLabelText(/Developer bearer token/)).toHaveAttribute("type", "password");
  });

  it("lists an owner's unlisted Artifacts only when the owner token and Unlisted filter are applied", async () => {
    const mock = installFetch((url, init) => {
      const isOwner = new Headers(init.headers).get("authorization") === "Bearer owner-token";
      if (isOwner && url.searchParams.get("visibility") === "unlisted") {
        return jsonResponse({
          items: [{ ...artifact("owner-unlisted", "My unlisted Pearl"), visibility: "unlisted" }],
          nextCursor: null,
        });
      }
      return jsonResponse({ items: [], nextCursor: null });
    });
    render(<ArtifactDiscovery />);
    expect(await screen.findByRole("heading", { name: "No Artifacts found" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Show my unlisted Artifacts" }));
    expect(await screen.findByRole("heading", { name: "My unlisted Pearl" })).toBeInTheDocument();
    expect(mock.mock.calls.some(([input, init]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.searchParams.get("visibility") === "unlisted"
        && new Headers(init?.headers).get("authorization") === "Bearer owner-token";
    })).toBe(true);
  });

  it("explains rejected owner tokens", async () => {
    installFetch(() => jsonResponse({
      error: { code: "UNAUTHENTICATED", message: "Authentication is required.", details: {} },
    }, 401));
    render(<ArtifactDiscovery />);
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "invalid-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply bearer token" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The bearer token was rejected.");
  });

  it("shows a useful API validation message for a 400 response", async () => {
    installFetch(() => jsonResponse({
      error: { code: "INVALID_REQUEST", message: "Search query must contain 1 to 100 characters.", details: {} },
    }, 400));
    render(<ArtifactDiscovery />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Search query must contain 1 to 100 characters.");
  });

  it("announces loading and shows a concise retryable network error", async () => {
    const mock = vi.fn().mockRejectedValue(new TypeError("network detail must not be shown"));
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    vi.stubGlobal("fetch", mock);
    render(<ArtifactDiscovery />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading Artifacts");
    expect(await screen.findByRole("heading", { name: "We couldn’t load Artifacts" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load Artifacts. Please try again.");
    expect(screen.queryByText("network detail must not be shown")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("shows the discovery-unavailable state for a 503 response and retries", async () => {
    const mock = installFetch(() => jsonResponse({
      error: { code: "DISCOVERY_UNAVAILABLE", message: "internal detail", details: {} },
    }, 503));
    render(<ArtifactDiscovery />);

    expect(await screen.findByRole("heading", { name: "Discovery is temporarily unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Artifact discovery is temporarily unavailable.");
    expect(screen.queryByText("internal detail")).not.toBeInTheDocument();

    mock.mockImplementation(() => Promise.resolve(jsonResponse({ items: [artifact("retry")], nextCursor: null })));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Pearl retry" })).toBeInTheDocument();
  });

  it("resets the cursor and previous results when search filters change", async () => {
    const mock = installFetch((url) => {
      if (url.searchParams.has("q")) {
        return jsonResponse({ items: [artifact("new", "New result")], nextCursor: null });
      }
      return jsonResponse({ items: [artifact("first")], nextCursor: "cursor-page-2" });
    });
    render(<ArtifactDiscovery />);

    expect(await screen.findByRole("heading", { name: "Pearl first" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search by name or slug" }), {
      target: { value: "new" },
    });

    expect(await screen.findByRole("heading", { name: "New result" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pearl first" })).not.toBeInTheDocument();
    const urls = mock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.some((url) => url.searchParams.has("cursor"))).toBe(false);
    expect(urls.at(-1)?.searchParams.get("q")).toBe("new");
  });

  it("ignores a stale response even when the fetch implementation does not abort", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const mock = installFetch((url) => {
      if (url.searchParams.has("q")) {
        return jsonResponse({ items: [artifact("current", "Current result")], nextCursor: null });
      }
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    });
    render(<ArtifactDiscovery />);
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search by name or slug" }), {
      target: { value: "current" },
    });
    expect(await screen.findByRole("heading", { name: "Current result" })).toBeInTheDocument();
    await act(async () => {
      resolveFirst?.(jsonResponse({ items: [artifact("stale", "Stale result")], nextCursor: null }));
    });
    expect(screen.queryByRole("heading", { name: "Stale result" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current result" })).toBeInTheDocument();
  });

  it("loads more with the same filters and opaque cursor, appending unique IDs only", async () => {
    let failedLoadMore = false;
    const mock = installFetch((url) => {
      if (url.searchParams.has("cursor")) {
        if (!failedLoadMore) {
          failedLoadMore = true;
          return jsonResponse({
            error: { code: "DISCOVERY_UNAVAILABLE", message: "Unavailable", details: {} },
          }, 503);
        }
        return jsonResponse({ items: [artifact("2"), artifact("1")], nextCursor: null });
      }
      return jsonResponse({ items: [artifact("1")], nextCursor: "next/opaque?cursor" });
    });
    render(<ArtifactDiscovery />);

    expect(await screen.findByRole("heading", { name: "Pearl 1" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search by name or slug" }), {
      target: { value: "pearl search" },
    });
    fireEvent.change(screen.getByLabelText("Filter by tags"), { target: { value: "rag, language-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tags" }));
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "name" } });
    fireEvent.change(screen.getByLabelText("Direction"), { target: { value: "asc" } });
    fireEvent.change(screen.getByLabelText("Per page"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Visibility filter"), { target: { value: "public" } });
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("heading", { name: "Pearl 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Artifact discovery is temporarily unavailable.");
    expect(screen.getByRole("heading", { name: "Pearl 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading more" }));
    expect(await screen.findByRole("heading", { name: "Pearl 2" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Pearl 1" })).toHaveLength(1);
    const urls = mock.mock.calls.map(([url]) => new URL(String(url)));
    const pageTwo = urls.at(-1)!;
    expect(pageTwo.pathname).toBe("/api/v1/artifacts");
    expect(pageTwo.searchParams.get("cursor")).toBe("next/opaque?cursor");
    expect(pageTwo.searchParams.get("q")).toBe("pearl search");
    expect(pageTwo.searchParams.getAll("tag")).toEqual(["rag", "language-model"]);
    expect(pageTwo.searchParams.get("sort")).toBe("name");
    expect(pageTwo.searchParams.get("order")).toBe("asc");
    expect(pageTwo.searchParams.get("limit")).toBe("50");
    expect(pageTwo.searchParams.get("visibility")).toBe("public");
    expect(screen.getByRole("list", { name: "Artifact results" }).querySelectorAll(":scope > li")).toHaveLength(2);
  });

  it("validates invalid and excessive tag filters before requesting them", async () => {
    const mock = installFetch(() => jsonResponse({ items: [], nextCursor: null }));
    render(<ArtifactDiscovery />);
    await screen.findByRole("heading", { name: "No Artifacts found" });
    const input = screen.getByLabelText("Filter by tags");

    fireEvent.change(input, { target: { value: "not valid" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tags" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Tags must use lowercase letters");
    expect(mock).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: "one,two,three,four,five,six,seven,eight,nine,ten,eleven" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tags" }));
    expect(screen.getByRole("alert")).toHaveTextContent("at most 10 tags");
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
