import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Playground from "../components/playground";

const sourceVersion = makePublishedVersion({
  artifactId: "source-artifact",
  artifactName: "Source Pearl",
  versionId: "source-version",
  version: "1.0.0",
  instructions: "Source Skill instructions.\nAsk clarifying questions over multiple turns.",
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
  createdAt: "2026-11-15T00:00:00.000Z",
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
    resolvedAt: "2026-11-15T00:00:00.000Z",
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
      createdAt: "2026-11-15T00:00:00.000Z",
      updatedAt: "2026-11-15T00:00:00.000Z",
    },
    version: {
      id: input.versionId,
      artifactId: input.artifactId,
      version: input.version,
      contentHash: `sha256:${(input.artifactId === "target-artifact" ? "b" : "c").repeat(64)}`,
      publishedAt: "2026-11-15T00:00:00.000Z",
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
  sourceUnavailable?: boolean;
  targetUnavailable?: boolean;
  largeInstructions?: boolean;
} = {}) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const source = options.largeInstructions
    ? {
      ...sourceVersion,
      version: {
        ...sourceVersion.version,
        content: {
          ...sourceVersion.version.content,
          instructions: "Large canonical Skill content. ".repeat(3_000),
        },
      },
    }
    : sourceVersion;
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    if (url.pathname.endsWith("/dependency-resolutions")) {
      return options.resolveStatus
        ? jsonResponse({
          error: {
            code: options.resolveStatus === 403 ? "FORBIDDEN" : "DEPENDENCY_RESOLUTION_FAILED",
            message: "Request failed.",
            details: {},
          },
        }, options.resolveStatus)
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

function setClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

let originalClipboard: PropertyDescriptor | undefined;
let originalCreateObjectURL: PropertyDescriptor | undefined;
let originalRevokeObjectURL: PropertyDescriptor | undefined;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
});

beforeEach(() => {
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
});

async function startPreparing(options: Parameters<typeof stubPlaygroundApi>[0] = {}) {
  const api = stubPlaygroundApi(options);
  render(<Playground artifactId="source-artifact" version="1.0.0" />);
  fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "owner-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Prepare Launch Package" }));
  return api;
}

async function preparePackage(options: Parameters<typeof stubPlaygroundApi>[0] = {}) {
  const api = await startPreparing(options);
  const packageText = await screen.findByLabelText(/Complete Launch Package/) as HTMLTextAreaElement;
  return { api, packageText };
}

describe("External AI Playground", () => {
  it("prepares a complete version-pinned package and only opens providers after an explicit click", async () => {
    const writeText = setClipboard(vi.fn().mockResolvedValue(undefined));
    const { api, packageText } = await preparePackage();
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    expect(packageText.value).toContain("Source Skill instructions.");
    expect(packageText.value).toContain("Source Knowledge content");
    expect(packageText.value).toContain("Dependency Skill instructions");
    expect(packageText.value).toContain("Dependency Knowledge content");
    expect(packageText.value).toContain('"declaredRange": "^2.0.0"');
    expect(packageText.value).toContain('"resolvedVersion": "2.3.1"');
    expect(packageText.value).toContain('"resolvedArtifactVersionId": "target-version"');
    expect(packageText.value).toContain("Ask clarifying questions");
    expect(screen.getByText("Knowledge files: 2")).toBeInTheDocument();
    expect(screen.getByText("Direct dependencies: 1")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Gemini API key/)).not.toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();

    const immutablePackage = packageText.value;
    fireEvent.click(screen.getByRole("button", { name: "Launch in Gemini" }));
    expect(open).toHaveBeenLastCalledWith("https://gemini.google.com/", "_blank", "noopener,noreferrer");
    expect(writeText).toHaveBeenLastCalledWith(immutablePackage);
    expect(await screen.findByText(/Launch Package copied/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Launch in ChatGPT" }));
    await waitFor(() => expect(open).toHaveBeenLastCalledWith("https://chatgpt.com/", "_blank", "noopener,noreferrer"));
    expect(writeText).toHaveBeenLastCalledWith(immutablePackage);
    expect(api.calls.filter(({ url }) => url.pathname.endsWith("/dependency-resolutions"))).toHaveLength(1);
    expect(api.calls.every(({ url, init }) =>
      !url.search && !url.pathname.includes("gemini") && !url.pathname.includes("chatgpt")
      && !String(init.body ?? "").includes("Source Skill instructions."))).toBe(true);
    expect(screen.getByText(/does not create a Custom GPT/)).toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("keeps the complete package available for manual copy after clipboard denial", async () => {
    const writeText = setClipboard(vi.fn().mockRejectedValue(new Error("clipboard permission denied")));
    const { packageText } = await preparePackage();
    vi.spyOn(window, "open").mockReturnValue(null);

    fireEvent.click(screen.getByRole("button", { name: "Launch in Gemini" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Clipboard access failed/);
    expect(packageText.value).toContain("Source Knowledge content");

    writeText.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Copy Launch Package" }));
    expect(await screen.findByText(/Launch Package copied/)).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("downloads oversized content without truncation and skips automatic clipboard transfer", async () => {
    const writeText = setClipboard(vi.fn().mockResolvedValue(undefined));
    const { packageText } = await preparePackage({ largeInstructions: true });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const createObjectURL = vi.fn().mockReturnValue("blob:launch-package");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent(/exceeds the 65,536-byte clipboard threshold/);
    expect(warning).toHaveTextContent(/automatic clipboard copy is skipped/i);
    expect(warning).toHaveTextContent(/manually copy and paste the complete contents/i);
    const originalPackage = packageText.value;
    expect(originalPackage).toContain("Large canonical Skill content.");
    expect(originalPackage).toContain('"manifestHash"');

    fireEvent.click(screen.getByRole("button", { name: "Launch in ChatGPT" }));
    expect(open).toHaveBeenCalledWith("https://chatgpt.com/", "_blank", "noopener,noreferrer");
    expect(writeText).not.toHaveBeenCalled();
    expect(await screen.findByText(/manually copy and paste its full contents/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download Launch Package" }));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalled();
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(await blob.text()).toBe(originalPackage);
    expect(await screen.findByText(/download started/)).toBeInTheDocument();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:launch-package"));
  });

  it("does not prepare a package when dependency history is redacted", async () => {
    const api = await startPreparing({ historyState: "redacted" });

    expect(await screen.findByRole("alert")).toHaveTextContent(/access is redacted/);
    expect(screen.queryByRole("heading", { name: "Launch Package ready" })).not.toBeInTheDocument();
    expect(api.calls.some(({ url }) => url.pathname.endsWith("/dependency-resolutions"))).toBe(false);
    expect(screen.getByText("Prior resolved versions are withheld.")).toBeInTheDocument();
    expect(screen.queryByText("target-version")).not.toBeInTheDocument();
  });

  it("blocks failed or inaccessible dependencies without leaking resolved target details", async () => {
    const api = await startPreparing({ targetUnavailable: true });

    expect(await screen.findByRole("alert")).toHaveTextContent(/source or a required Artifact Version is not currently available/);
    expect(screen.queryByRole("heading", { name: "Launch Package ready" })).not.toBeInTheDocument();
    expect(screen.queryByText("target-version")).not.toBeInTheDocument();
    expect(api.calls.some(({ url }) => url.pathname.endsWith("/dependency-resolutions"))).toBe(true);
  });

  it("reports resolver authorization and resolution failures without preparing a package", async () => {
    const forbidden = await startPreparing({ resolveStatus: 403 });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Only the source Artifact owner/);
    expect(screen.queryByRole("heading", { name: "Launch Package ready" })).not.toBeInTheDocument();

    cleanup();
    stubPlaygroundApi({ resolveStatus: 400 });
    render(<Playground artifactId="source-artifact" version="1.0.0" />);
    fireEvent.change(screen.getByLabelText(/Developer bearer token/), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare Launch Package" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no Launch Package was prepared/i);
    expect(screen.queryByText("target-version")).not.toBeInTheDocument();
    expect(forbidden.calls.some(({ url }) => url.pathname.endsWith("/dependency-resolutions"))).toBe(true);
  });
});
