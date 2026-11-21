import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ArtifactDetail from "../components/artifact-detail";
import { FirebaseSessionContext, type FirebaseSession } from "../components/firebase-auth-provider";
import { getCurrentFirebaseIdToken } from "../lib/firebase-auth";

const signedInSession: FirebaseSession = {
  status: "signed-in",
  user: { uid: "firebase-uid", email: "owner@example.test" },
  error: null,
  signInWithGoogle: async () => {},
  signInWithEmail: async () => {},
  createAccount: async () => {},
  signOut: async () => {},
};

const signedOutSession: FirebaseSession = {
  ...signedInSession,
  status: "signed-out",
  user: null,
};

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

function setup(
  fetch: ReturnType<typeof visibilityAPI>,
  session: FirebaseSession = signedInSession,
  idToken = "owner-token",
) {
  vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "http://localhost:8080");
  vi.stubGlobal("fetch", fetch);
  vi.mocked(getCurrentFirebaseIdToken).mockResolvedValue(session.user ? idToken : null);
  return render(
    <FirebaseSessionContext.Provider value={session}>
      <ArtifactDetail artifactId="child-id" />
    </FirebaseSessionContext.Provider>,
  );
}

function canonicalVisibility(): HTMLElement | null {
  return screen.getByText("Visibility", { selector: "dt" }).nextElementSibling as HTMLElement | null;
}

describe("Artifact visibility editor", () => {
  it("renders only for the owner and submits each allowed value using the Firebase session", async () => {
    const fetch = visibilityAPI();
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    setup(fetch);

    expect(await screen.findByText("No visible Fork lineage.")).toBeInTheDocument();

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

    cleanup();
    setup(visibilityAPI(), signedOutSession);
    expect(await screen.findByText("No visible Fork lineage.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();

    cleanup();
    const pendingIdentity = new Promise<Response>(() => {});
    setup(visibilityAPI({ identityResponse: () => pendingIdentity }));
    expect(await screen.findByText("No visible Fork lineage.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();

    cleanup();
    setup(visibilityAPI({
      identityResponse: async () => response({
        error: { code: "UNAUTHENTICATED", message: "No.", details: {} },
      }, 401),
      }));
      expect(await screen.findByText("No visible Fork lineage.")).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();
  });

  it("clears owner visibility when the Firebase session signs out", async () => {
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
    const view = setup(fetch, signedInSession, "owner-token");
    expect(await screen.findByText("No visible Fork lineage.")).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Visibility" })).toBeInTheDocument();

    view.rerender(
      <FirebaseSessionContext.Provider value={signedOutSession}>
        <ArtifactDetail artifactId="child-id" />
      </FirebaseSessionContext.Provider>,
    );
    expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();
  });

  it("disables Save while pending and preserves canonical visibility after a failure", async () => {
    let finishPatch: (result: Response) => void = () => {};
    const fetch = visibilityAPI({
      patchResponse: async () => new Promise<Response>((resolve) => { finishPatch = resolve; }),
    });
    setup(fetch);
    expect(await screen.findByText("No visible Fork lineage.")).toBeInTheDocument();
    const selector = await screen.findByRole("combobox", { name: "Visibility" });
    fireEvent.change(selector, { target: { value: "private" } });
    fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    finishPatch(response({
      error: { code: "FORBIDDEN", message: "Not owner.", details: {} },
    }, 403));

    expect(await screen.findByRole("alert")).toHaveTextContent("Only the Artifact owner can change visibility.");
    expect(canonicalVisibility()).toHaveTextContent("public");
    expect(selector).toHaveValue("private");
    expect(screen.getByRole("button", { name: "Save visibility" })).toBeEnabled();
  });
});
