import { describe, expect, it } from "vitest";
import {
  buildLaunchPackage,
  buildProviderLaunchTarget,
  EXTERNAL_AI_PROVIDERS,
  LAUNCH_PACKAGE_CLIPBOARD_MAX_BYTES,
  launchPackageSizeInBytes,
  makeLaunchPackageFilename,
  PROVIDER_PREFILL_MAX_URL_BYTES,
  serializeLaunchPackageMarkdown,
} from "../lib/external-playground";
import type {
  DependencyResolutionManifestEntry,
  DependencyResolutionRun,
  PublishedVersion,
} from "../lib/drafts";

const source = makePublishedVersion({
  artifactId: "source-artifact",
  name: "Source Pearl",
  versionId: "source-version",
  version: "1.0.0",
  contentHash: `sha256:${"a".repeat(64)}`,
  instructions: "Canonical Skill instructions.\nDo not paraphrase.",
  knowledgeFiles: [{ path: "guide.md", content: "Source reference content.", contentHash: `sha256:${"b".repeat(64)}` }],
  dependencies: [{ targetArtifactId: "dependency-artifact", declaredRange: "^2.0.0" }],
});

const dependencyManifest: DependencyResolutionManifestEntry = {
  dependencyId: "dependency-record",
  targetArtifactId: "dependency-artifact",
  declaredRange: "^2.0.0",
  resolvedArtifactVersionId: "dependency-version",
  resolvedVersion: "2.3.1",
  resolvedContentHash: `sha256:${"c".repeat(64)}`,
  resolvedAt: "2026-11-15T00:00:00.000Z",
};

const dependencyVersion = makePublishedVersion({
  artifactId: dependencyManifest.targetArtifactId,
  name: "Dependency Pearl",
  versionId: dependencyManifest.resolvedArtifactVersionId,
  version: dependencyManifest.resolvedVersion,
  contentHash: dependencyManifest.resolvedContentHash,
  instructions: "Dependency Skill instructions.",
  knowledgeFiles: [{ path: "dependency.txt", content: "Dependency reference content.", contentHash: `sha256:${"d".repeat(64)}` }],
  dependencies: [],
});

const resolutionRun: DependencyResolutionRun = {
  runId: "resolution-run",
  sourceArtifactVersionId: "source-version",
  createdAt: "2026-11-15T00:00:00.000Z",
  manifestVersion: 1,
  resolverPolicyVersion: "semver-highest-v1",
  manifestHash: `sha256:${"e".repeat(64)}`,
  dependencies: [dependencyManifest],
};

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
      createdAt: "2026-11-15T00:00:00.000Z",
      updatedAt: "2026-11-15T00:00:00.000Z",
    },
    version: {
      id: input.versionId,
      artifactId: input.artifactId,
      version: input.version,
      contentHash: input.contentHash,
      publishedAt: "2026-11-15T00:00:00.000Z",
      content: {
        instructions: input.instructions,
        knowledgeFiles: input.knowledgeFiles,
        dependencies: input.dependencies,
      },
    },
  };
}

describe("External AI Launch Package", () => {
  it("contains immutable source and exact dependency provenance and preserves canonical content", () => {
    const sourceSnapshot = structuredClone(source);
    const launchPackage = buildLaunchPackage(
      sourceSnapshot,
      resolutionRun,
      [{ manifest: dependencyManifest, published: dependencyVersion }],
      new Date("2026-11-15T12:00:00.000Z"),
    );
    const markdown = serializeLaunchPackageMarkdown(launchPackage);

    expect(launchPackage.manifest).toMatchObject({
      format: "pearlhub-launch-package",
      formatVersion: 1,
      createdAt: "2026-11-15T12:00:00.000Z",
      source: {
        platform: "PearlHub",
        artifactId: "source-artifact",
        artifactVersionId: "source-version",
        version: "1.0.0",
        skillName: "Source Pearl",
      },
      resolution: {
        runId: "resolution-run",
        manifestHash: resolutionRun.manifestHash,
        dependencies: [dependencyManifest],
      },
    });
    expect(launchPackage.skillInstructions).toBe(sourceSnapshot.version.content.instructions);
    expect(launchPackage.knowledgeFiles[0]).toMatchObject({
      path: "guide.md",
      content: "Source reference content.",
      contentHash: sourceSnapshot.version.content.knowledgeFiles[0]?.contentHash,
    });
    expect(launchPackage.dependencies[0]).toMatchObject({
      manifest: dependencyManifest,
      skillName: "Dependency Pearl",
      instructions: "Dependency Skill instructions.",
      knowledgeFiles: [{ path: "dependency.txt", content: "Dependency reference content." }],
    });
    expect(markdown).toContain("Canonical Skill instructions.\nDo not paraphrase.");
    expect(markdown).toContain("dependency.txt");
    expect(markdown).toContain('"declaredRange": "^2.0.0"');
    expect(markdown).toContain('"resolvedVersion": "2.3.1"');
    expect(markdown).toContain('"resolvedArtifactVersionId": "dependency-version"');
    expect(markdown).toContain("multi-turn");
    expect(markdown).toContain("native interactive");
    expect(markdown).toContain("numbered choices");

    sourceSnapshot.version.content.instructions = "Changed after package construction.";
    sourceSnapshot.version.content.knowledgeFiles[0]!.content = "Changed reference.";
    expect(markdown).toContain("Canonical Skill instructions.\nDo not paraphrase.");
    expect(markdown).toContain("Source reference content.");
    expect(markdown).not.toContain("Changed after package construction.");
  });

  it("rejects incomplete or mismatched dependency content instead of creating a partial package", () => {
    expect(() => buildLaunchPackage(source, resolutionRun, []))
      .toThrow(/incomplete because required dependency content is unavailable/);
    expect(() => buildLaunchPackage(source, {
      ...resolutionRun,
      sourceArtifactVersionId: "another-version",
    }, [{ manifest: dependencyManifest, published: dependencyVersion }]))
      .toThrow(/does not belong to the selected Artifact Version/);
    expect(() => buildLaunchPackage(source, {
      ...resolutionRun,
      dependencies: [{ ...dependencyManifest, resolvedVersion: "2.3.2" }],
    }, [{ manifest: dependencyManifest, published: dependencyVersion }]))
      .toThrow(/does not match the resolution manifest/);
    expect(() => buildLaunchPackage(source, {
      ...resolutionRun,
      dependencies: [{ ...dependencyManifest, resolvedContentHash: `sha256:${"f".repeat(64)}` }],
    }, [{
      manifest: { ...dependencyManifest, resolvedContentHash: `sha256:${"f".repeat(64)}` },
      published: dependencyVersion,
    }])).toThrow(/does not match the exact Version/);
  });

  it("keeps all large content and reports its UTF-8 byte size for download fallback", () => {
    const largeInstructions = `${"large instructions ".repeat(5_000)}\nEnd of canonical instructions.`;
    const largeSource = {
      ...source,
      version: {
        ...source.version,
        content: { ...source.version.content, instructions: largeInstructions },
      },
    };
    const emptyResolution = { ...resolutionRun, dependencies: [] };
    const noDependencies = {
      ...largeSource,
      version: {
        ...largeSource.version,
        content: { ...largeSource.version.content, dependencies: [] },
      },
    };
    const markdown = serializeLaunchPackageMarkdown(buildLaunchPackage(noDependencies, emptyResolution, []));

    expect(launchPackageSizeInBytes(markdown)).toBeGreaterThan(LAUNCH_PACKAGE_CLIPBOARD_MAX_BYTES);
    expect(markdown).toContain(largeInstructions);
    expect(markdown).toContain("End of canonical instructions.");
    expect(makeLaunchPackageFilename(source)).toBe("source-artifact-1.0.0-launch-package.md");
  });

  it("builds encoded prefill URLs for ChatGPT, Claude, and Grok", () => {
    expect(EXTERNAL_AI_PROVIDERS.gemini.entryPoint).toBe("https://gemini.google.com/");
    expect(EXTERNAL_AI_PROVIDERS.chatgpt.entryPoint).toBe("https://chatgpt.com/");
    expect(Object.values(EXTERNAL_AI_PROVIDERS).every(({ entryPoint }) => new URL(entryPoint).search === "")).toBe(true);

    const prompt = "Skill instructions & Knowledge\nKeep this exact: 雪";
    for (const provider of ["chatgpt", "claude", "grok"] as const) {
      const target = buildProviderLaunchTarget(provider, prompt);
      const url = new URL(target.url);

      expect(target.promptPrefilled).toBe(true);
      expect(url.searchParams.get("q")).toBe(prompt);
      expect(launchPackageSizeInBytes(target.url)).toBeLessThanOrEqual(PROVIDER_PREFILL_MAX_URL_BYTES);
    }

    expect(EXTERNAL_AI_PROVIDERS.claude.entryPoint).toBe("https://claude.ai/new");
    expect(EXTERNAL_AI_PROVIDERS.grok.entryPoint).toBe("https://grok.com/");
    expect(buildProviderLaunchTarget("gemini", prompt)).toEqual({
      url: EXTERNAL_AI_PROVIDERS.gemini.entryPoint,
      promptPrefilled: false,
    });
  });

  it("opens without prefill when the complete provider URL exceeds the safe URL limit", () => {
    const target = buildProviderLaunchTarget(
      "chatgpt",
      "x".repeat(PROVIDER_PREFILL_MAX_URL_BYTES),
    );

    expect(target).toEqual({
      url: EXTERNAL_AI_PROVIDERS.chatgpt.entryPoint,
      promptPrefilled: false,
    });
  });
});
