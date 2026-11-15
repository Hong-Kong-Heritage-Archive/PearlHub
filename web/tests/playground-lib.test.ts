import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@google/genai";
import {
  assertManifestMatchesDeclarations,
  assertResolvedContentMatchesManifest,
  assemblePlaygroundPrompt,
  runGeminiTest,
} from "../lib/playground";
import type { DependencyResolutionManifestEntry, PublishedVersion } from "../lib/drafts";

const gemini = vi.hoisted(() => ({ generateContent: vi.fn(), constructor: vi.fn() }));
vi.mock("@google/genai", () => ({
  ApiError: class extends Error {
    readonly status: number;

    constructor(options: { status: number; message: string }) {
      super(options.message);
      this.name = "ApiError";
      this.status = options.status;
    }
  },
  GoogleGenAI: class {
    models = { generateContent: gemini.generateContent };

    constructor(options: unknown) {
      gemini.constructor(options);
    }
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  gemini.generateContent.mockReset();
  gemini.constructor.mockReset();
});

const targetHash = `sha256:${"b".repeat(64)}`;
const manifest: DependencyResolutionManifestEntry = {
  dependencyId: "dependency-row",
  targetArtifactId: "target-artifact",
  declaredRange: "^2.0.0",
  resolvedArtifactVersionId: "target-version",
  resolvedVersion: "2.3.1",
  resolvedContentHash: targetHash,
  resolvedAt: "2026-11-12T00:00:00.000Z",
};

const source = makePublishedVersion({
  artifactId: "source-artifact",
  name: "Source Pearl",
  versionId: "source-version",
  version: "1.0.0",
  contentHash: `sha256:${"c".repeat(64)}`,
  instructions: "Source Skill.",
  knowledgeFiles: [{ path: "source.md", content: "Source knowledge.", contentHash: targetHash }],
  dependencies: [{ targetArtifactId: manifest.targetArtifactId, declaredRange: manifest.declaredRange }],
});

const dependency = makePublishedVersion({
  artifactId: manifest.targetArtifactId,
  name: "Target Pearl",
  versionId: manifest.resolvedArtifactVersionId,
  version: manifest.resolvedVersion,
  contentHash: manifest.resolvedContentHash,
  instructions: "Dependency Skill.",
  knowledgeFiles: [{ path: "dependency.md", content: "Dependency knowledge.", contentHash: targetHash }],
  dependencies: [],
});

function makePublishedVersion(input: {
  artifactId: string;
  name: string;
  versionId: string;
  version: string;
  contentHash: string;
  instructions: string;
  knowledgeFiles: PublishedVersion["version"]["content"]["knowledgeFiles"];
  dependencies: PublishedVersion["version"]["content"]["dependencies"];
}): PublishedVersion {
  return {
    artifact: {
      id: input.artifactId,
      ownerId: "owner-id",
      name: input.name,
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
      contentHash: input.contentHash,
      publishedAt: "2026-11-12T00:00:00.000Z",
      content: {
        instructions: input.instructions,
        knowledgeFiles: input.knowledgeFiles,
        dependencies: input.dependencies,
      },
    },
  };
}

describe("Playground content and Gemini helpers", () => {
  it("checks source declarations and exact dependency content against the persisted manifest", () => {
    expect(() => assertManifestMatchesDeclarations(source, [manifest])).not.toThrow();
    expect(() => assertManifestMatchesDeclarations(source, [])).toThrow(/does not match/);
    expect(() => assertResolvedContentMatchesManifest(manifest, dependency)).not.toThrow();
    expect(() => assertResolvedContentMatchesManifest(manifest, {
      ...dependency,
      version: { ...dependency.version, contentHash: `sha256:${"f".repeat(64)}` },
    })).toThrow(/did not match the exact Version/);
  });

  it("assembles source, knowledge, exact dependencies, then test input in deterministic order", () => {
    const prompt = assemblePlaygroundPrompt(
      source,
      [{ manifest, published: dependency }],
      "Test input.",
    );
    expect(prompt.indexOf("Source Skill.")).toBeLessThan(prompt.indexOf("Source knowledge."));
    expect(prompt.indexOf("Source knowledge.")).toBeLessThan(prompt.indexOf("Dependency Skill."));
    expect(prompt.indexOf("Dependency Skill.")).toBeLessThan(prompt.indexOf("Dependency knowledge."));
    expect(prompt.indexOf("Dependency knowledge.")).toBeLessThan(prompt.indexOf("User test input:"));
    expect(prompt).toContain("target-artifact@2.3.1");
    expect(prompt).toContain("Declared range: ^2.0.0");
    expect(() => assemblePlaygroundPrompt(
      { ...source, version: { ...source.version, content: { ...source.version.content, instructions: " " } } },
      [],
      "Test input.",
    )).toThrow(/empty Skill instructions/);
  });

  it("requires a key and reports Gemini auth, quota, model, timeout, service, network and empty-response errors safely", async () => {
    await expect(runGeminiTest("", "prompt")).rejects.toMatchObject({ kind: "authentication" });
    expect(gemini.constructor).not.toHaveBeenCalled();

    const cases: Array<[number, string]> = [
      [401, "authentication"],
      [429, "quota"],
      [404, "model"],
      [408, "timeout"],
      [503, "service"],
    ];
    for (const [status, kind] of cases) {
      gemini.generateContent.mockRejectedValueOnce(new ApiError({ status, message: "provider detail" }));
      await expect(runGeminiTest("private-key", "prompt")).rejects.toMatchObject({
        kind,
        message: expect.not.stringContaining("provider detail"),
      });
    }

    gemini.generateContent.mockRejectedValueOnce(new Error("network timeout"));
    await expect(runGeminiTest("private-key", "prompt")).rejects.toMatchObject({ kind: "timeout" });
    gemini.generateContent.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(runGeminiTest("private-key", "prompt")).rejects.toMatchObject({ kind: "network" });
    gemini.generateContent.mockResolvedValueOnce({ text: " " });
    await expect(runGeminiTest("private-key", "prompt")).rejects.toMatchObject({ kind: "empty" });
  });
});
