import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Playground from "../components/playground";

const gemini = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
      this.name = "ApiError";
    }
  }
  return {
    generateContent: vi.fn(),
    constructor: vi.fn(),
    MockApiError,
  };
});

vi.mock("@google/genai", () => ({
  ApiError: gemini.MockApiError,
  GoogleGenAI: class {
    models = { generateContent: gemini.generateContent };

    constructor(options: unknown) {
      gemini.constructor(options);
    }
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  gemini.generateContent.mockReset();
  gemini.constructor.mockReset();
  vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
});

const sourceVersion = makePublishedVersion({
  artifactId: "source-artifact",
  artifactName: "Source Pearl",
  versionId: "source-version",
  version: "1.0.0",
  instructions: "Source Skill instructions",
  knowledgeFiles: [{ path: "source.md", content: "Source Knowledge content", contentHash: `sha256:${"d".repeat(64)}` }],
  dependencies: [{ targetArtifactId: "target-artifact", declaredRange: "^2.0.0" }],
});

const targetVersion = makePublishedVersion({
  artifactId: "target-artifact",
  artifactName: "Target Pearl",
  versionId: "target-version",
  version: "2.3.1",
  instructions: "Dependency Skill instructions",
  knowledgeFiles: [{ path: "dependency.md", content: "Dependency Knowledge content", contentHash: `sha256:${"e".repeat(64)}` }],
  dependencies: [],
});

const manifest = {
  runId: "resolution-run",
  sourceArtifactVersionId: "source-version",
  createdAt: "2026-11-12T00:00:00.000Z",
  manifestVersion: 1,
  resolverPolicyVersion: "semver-highest-v1",
  manifestHash: `sha256:${"a".repeat(64)}`,
  dependencies: [{
    dependencyId: "dependency-row",
    targetArtifactId: "target-artifact",
    declaredRange: "^2.0.0",
    resolvedArtifactVersionId: "target-version",
    resolvedVersion: "2.3.1",
    resolvedContentHash: targetVersion.version.contentHash,
    resolvedAt: "2026-11-12T00:00:00.000Z",
  }],
};

function makePublishedVersion(input: {
  artifactId: string;
  artifactName: string;
  versionId: string;
  version: string;
  instructions: string;
  knowledgeFiles: Array<{ path: string; content: string; contentHash: string }>;
  dependencies: Array<{ targetArtifactId: string; declaredRange: string }>;
}) {
  return {
    artifact: {
      id: input.artifactId,
      ownerId: "owner-id",
      name: input.artifactName,
      slug: input.artifactId,
      visibility: "public",
      status: "active",
      createdAt: "2026-11-12T00:00:00.000Z",
      updatedAt: "2026-11-12T00:00:00.000Z",
    },
    version: {
      id: input.versionId,
      artifactId: input.artifactId,
      version: input.version,
      contentHash: `sha256:${(input.artifactId === "target-artifact" ? "b" : "c").repeat(64)}`,
      publishedAt: "2026-11-12T00:00:00.000Z",
      content: {
        instructions: input.instructions,
        knowledgeFiles: input.knowledgeFiles,
        dependencies: input.dependencies,
      },
    },
  };
}

function stubPlaygroundApi(options: {
  historyState?: "none" | "available" | "redacted";
  resolveStatus?: number;
  emptyInstructions?: boolean;
  sourceUnavailable?: boolean;
  targetUnavailable?: boolean;
} = {}) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const source = options.emptyInstructions
    ? { ...sourceVersion, version: { ...sourceVersion.version, content: { ...sourceVersion.version.content, instructions: "" } } }
    : sourceVersion;
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    if (url.pathname.endsWith("/dependency-resolutions")) {
      return options.resolveStatus
        ? jsonResponse({ error: { code: options.resolveStatus === 403 ? "FORBIDDEN" : "DEPENDENCY_RESOLUTION_FAILED", message: "Request failed.", details: {} } }, options.resolveStatus)
        : jsonResponse(manifest);
    }
    if (url.pathname.endsWith("/dependencies")) {
      return jsonResponse({
        artifactId: "source-artifact",
        version: "1.0.0",
        dependencies: [{
          targetArtifactId: "target-artifact",
          declaredRange: "^2.0.0",
          resolutionState: options.historyState ?? "none",
          resolutions: [],
        }],
      });
    }
    if (url.pathname === "/api/v1/artifacts/target-artifact/versions/2.3.1") {
      return options.targetUnavailable
        ? jsonResponse({ error: { code: "NOT_FOUND", message: "Not found.", details: {} } }, 404)
        : jsonResponse(targetVersion);
    }
    if (url.pathname === "/api/v1/artifacts/source-artifact/versions/1.0.0") {
      return options.sourceUnavailable
        ? jsonResponse({ error: { code: "NOT_FOUND", message: "Not found.", details: {} } }, 404)
        : jsonResponse(source);
    }
    return jsonResponse({ error: { code: "NOT_FOUND", message: "Not found.", details: {} } }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

describe("Playground ThinUI", () => {
  it("loads immutable content, resolves exact direct dependencies, and sends the key only to Gemini", async () => {
    const { calls } = stubPlaygroundApi();
    gemini.generateContent.mockResolvedValue({
      text: "Gemini test response",
      modelVersion: "gemini-3.8-flash",
      usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 45 },
    });
    render(<Playground artifactId="source-artifact" version="1.0.0" />);

    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load source and resolve dependencies" }));

    expect(await screen.findByText("Dependency Knowledge content")).toBeInTheDocument();
    expect(screen.getByText("Resolved Version:")).toBeInTheDocument();
    expect(screen.getByText("2.3.1")).toBeInTheDocument();
    expect(screen.getByText(/Manifest hash:/)).toHaveTextContent(manifest.manifestHash);

    fireEvent.change(screen.getByLabelText(/Gemini API key/), { target: { value: "user-gemini-secret" } });
    fireEvent.change(screen.getByLabelText(/Test input/), { target: { value: "Test this Skill." } });
    fireEvent.click(screen.getByRole("button", { name: "Run Skill test" }));

    expect(await screen.findByText("Gemini test response")).toBeInTheDocument();
    expect(gemini.constructor).toHaveBeenCalledWith({
      apiKey: "user-gemini-secret",
      httpOptions: { timeout: 90_000 },
    });
    expect(gemini.generateContent).toHaveBeenCalledWith(expect.objectContaining({
      model: "gemini-3.8-flash",
      contents: expect.stringContaining("Source Knowledge content"),
    }));
    const prompt = gemini.generateContent.mock.calls[0]?.[0].contents as string;
    expect(prompt).toContain("Dependency Skill instructions");
    expect(prompt).toContain("Dependency Knowledge content");
    expect(prompt).toContain("Test this Skill.");
    expect(prompt).not.toContain("user-gemini-secret");
    expect(calls.map(({ url }) => url.pathname)).toContain(
      "/api/v1/artifacts/source-artifact/versions/1.0.0/dependency-resolutions",
    );
    expect(calls.every(({ init }) =>
      new Headers(init.headers).get("authorization") !== "Bearer user-gemini-secret"
      && !String(init.body ?? "").includes("user-gemini-secret"))).toBe(true);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(screen.getByText(/Prompt tokens:/)).toHaveTextContent("123");
    expect(screen.getByText(/Response tokens:/)).toHaveTextContent("45");
  });

  it("blocks execution when stored dependency history is redacted", async () => {
    const { calls } = stubPlaygroundApi({ historyState: "redacted" });
    render(<Playground artifactId="source-artifact" version="1.0.0" />);
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load source and resolve dependencies" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/prior resolution history is currently redacted/);
    expect(screen.getByText("Prior resolution state: redacted")).toBeInTheDocument();
    expect(screen.getByText("Prior resolved versions are withheld.")).toBeInTheDocument();
    expect(calls.some(({ url }) => url.pathname.endsWith("/dependency-resolutions"))).toBe(false);
    expect(screen.getByRole("button", { name: "Run Skill test" })).toBeDisabled();
  });

  it("does not display hidden target details when resolution is forbidden", async () => {
    stubPlaygroundApi({ resolveStatus: 400 });
    render(<Playground artifactId="source-artifact" version="1.0.0" />);
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load source and resolve dependencies" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be resolved or is not currently readable/);
    expect(screen.queryByText("target-version")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Skill test" })).toBeDisabled();
  });

  it("shows owner-access failures without exposing dependency identities", async () => {
    stubPlaygroundApi({ resolveStatus: 403 });
    render(<Playground artifactId="source-artifact" version="1.0.0" />);
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "other-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load source and resolve dependencies" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Only the source Artifact owner/);
    expect(screen.queryByText("target-version")).not.toBeInTheDocument();
  });

  it("blocks unavailable source or dependency snapshots without exposing resolved target details", async () => {
    stubPlaygroundApi({ sourceUnavailable: true });
    render(<Playground artifactId="source-artifact" version="1.0.0" />);
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load source and resolve dependencies" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/source or a required Artifact Version is not currently available/);

    cleanup();
    const { calls } = stubPlaygroundApi({ targetUnavailable: true });
    render(<Playground artifactId="source-artifact" version="1.0.0" />);
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load source and resolve dependencies" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/source or a required Artifact Version is not currently available/);
    expect(screen.queryByText("target-version")).not.toBeInTheDocument();
    expect(calls.some(({ url }) => url.pathname.endsWith("/dependency-resolutions"))).toBe(true);
    expect(screen.getByRole("button", { name: "Run Skill test" })).toBeDisabled();
  });

  it("keeps a Gemini quota error generic and clears the key and result on request", async () => {
    stubPlaygroundApi();
    gemini.generateContent.mockRejectedValue(new gemini.MockApiError(429, "quota error user-gemini-secret"));
    render(<Playground artifactId="source-artifact" version="1.0.0" />);
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load source and resolve dependencies" }));
    await screen.findByText("Dependency Knowledge content");
    fireEvent.change(screen.getByLabelText(/Gemini API key/), { target: { value: "user-gemini-secret" } });
    fireEvent.change(screen.getByLabelText(/Test input/), { target: { value: "Run." } });
    fireEvent.click(screen.getByRole("button", { name: "Run Skill test" }));

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent(/quota or rate limit/);
    expect(error).not.toHaveTextContent("user-gemini-secret");
    fireEvent.click(screen.getByRole("button", { name: "Clear Gemini API key" }));
    expect(screen.getByLabelText(/Gemini API key/)).toHaveValue("");
    expect(screen.getByRole("button", { name: "Run Skill test" })).toBeDisabled();
  });

  it("prevents running an Artifact Version with empty Skill instructions", async () => {
    stubPlaygroundApi({ emptyInstructions: true });
    render(<Playground artifactId="source-artifact" version="1.0.0" />);
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load source and resolve dependencies" }));

    expect(await screen.findByText(/empty Skill instructions/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Gemini API key/), { target: { value: "user-gemini-secret" } });
    fireEvent.change(screen.getByLabelText(/Test input/), { target: { value: "Run." } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Skill test" })).toBeDisabled());
  });
});
