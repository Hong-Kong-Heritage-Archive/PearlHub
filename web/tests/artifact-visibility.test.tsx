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
  name: "Artifact",
  slug: "artifact",
  visibility: "public",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

function visibilityAPI(options: {
  userId?: string;
  identityResponse?: () => Promise<Response>;
  patchResponse?: (visibility: string) => Promise<Response>;
} = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/v1/me") {
      return options.identityResponse?.() ?? response({ userId: options.userId ?? "owner-id" });
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { visibility: string };
      return options.patchResponse?.(body.visibility) ?? response({
        ...artifact,
        visibility: body.visibility,
        updatedAt: "2026-01-03T00:00:00.000Z",
      });
    }
    if (url.pathname.endsWith("/lineage")) return response({ parents: [], children: [] });
    return response(artifact);
  });
}

function setup(fetch: ReturnType<typeof visibilityAPI>) {
  vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "http://localhost:8080");
  vi.stubGlobal("fetch", fetch);
  render(<ArtifactDetail artifactId="child-id" />);
}

function loadToken(token: string) {
  fireEvent.change(screen.getByLabelText(/bearer token/i), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "Load with token" }));
}

function canonicalVisibility(): HTMLElement | null {
  return screen.getByText("Visibility", { selector: "dt" }).nextElementSibling as HTMLElement | null;
}

describe("Artifact visibility editor", () => {
  it("renders only for the owner and submits each allowed value using the active token", async () => {
    const fetch = visibilityAPI();
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    setup(fetch);

    expect(await screen.findByText("No visible Fork lineage.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();
    loadToken("owner-token");

    const selector = await screen.findByRole("combobox", { name: "Visibility" });
    expect(Array.from((selector as HTMLSelectElement).options).map((option) => option.value))
      .toEqual(["private", "unlisted", "public"]);

    for (const visibility of ["private", "unlisted", "public"]) {
      fireEvent.change(selector, { target: { value: visibility } });
      fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
      expect(await screen.findByText("Visibility updated.")).toBeInTheDocument();
      expect(selector).toHaveValue(visibility);
      expect(canonicalVisibility()).toHaveTextContent(visibility);
    }

    const patchCalls = fetch.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patchCalls).toHaveLength(3);
    expect(patchCalls.map(([, init]) => JSON.parse(String(init?.body))))
      .toEqual([{ visibility: "private" }, { visibility: "unlisted" }, { visibility: "public" }]);
    expect(patchCalls.every(([, init]) =>
      new Headers(init?.headers).get("authorization") === "Bearer owner-token")).toBe(true);
    expect(patchCalls.every(([input]) =>
      new URL(input instanceof Request ? input.url : String(input)).pathname === "/api/v1/artifacts/child-id")).toBe(true);
    expect(fetch.mock.calls.some(([input]) =>
      new URL(input instanceof Request ? input.url : String(input)).pathname === "/api/v1/drafts")).toBe(false);
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it("hides the editor for a non-owner, anonymous user, failed identity, and pending identity", async () => {
    const fetch = visibilityAPI({ userId: "another-user" });
    setup(fetch);
    expect(await screen.findByText("No visible Fork lineage.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();
    loadToken("non-owner-token");
    await screen.findByText("No visible Fork lineage.");
    expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();

    cleanup();
    const pendingIdentity = new Promise<Response>(() => {});
    setup(visibilityAPI({ identityResponse: () => pendingIdentity }));
    expect(await screen.findByText("No visible Fork lineage.")).toBeInTheDocument();
    loadToken("pending-token");
    expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();

    cleanup();
    setup(visibilityAPI({
      identityResponse: async () => response({
        error: { code: "UNAUTHENTICATED", message: "No.", details: {} },
      }, 401),
    }));
    expect(await screen.findByText("No visible Fork lineage.")).toBeInTheDocument();
    loadToken("invalid-token");
    await screen.findByText("No visible Fork lineage.");
    expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();
  });

  it("clears prior owner visibility immediately when the entered token changes", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/v1/me") {
        const userId = new Headers(init?.headers).get("authorization") === "Bearer owner-token"
          ? "owner-id"
          : "another-user";
        return response({ userId });
      }
      if (url.pathname.endsWith("/lineage")) return response({ parents: [], children: [] });
      return response(artifact);
    });
    setup(fetch);
    expect(await screen.findByText("No visible Fork lineage.")).toBeInTheDocument();
    loadToken("owner-token");
    expect(await screen.findByRole("combobox", { name: "Visibility" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/bearer token/i), { target: { value: "other-token" } });
    expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load with token" }));
    await screen.findByText("No visible Fork lineage.");
    expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();
  });

  it("disables Save while pending and preserves canonical visibility after a failure", async () => {
    let finishPatch: (result: Response) => void = () => {};
    const fetch = visibilityAPI({
      patchResponse: async () => new Promise<Response>((resolve) => { finishPatch = resolve; }),
    });
    setup(fetch);
    expect(await screen.findByText("No visible Fork lineage.")).toBeInTheDocument();
    loadToken("owner-token");
    const selector = await screen.findByRole("combobox", { name: "Visibility" });
    fireEvent.change(selector, { target: { value: "private" } });
    fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    finishPatch(response({
      error: { code: "FORBIDDEN", message: "Not owner.", details: {} },
    }, 403));

    expect(await screen.findByRole("alert")).toHaveTextContent("Only the Artifact owner can change visibility.");
    expect(canonicalVisibility()).toHaveTextContent("public");
    expect(selector).toHaveValue("private");
    expect(screen.getByRole("button", { name: "Save visibility" })).toBeEnabled();
  });
});
