import { describe, expect, it } from "vitest";
import {
  buildLaunchPackage,
  buildPromptPrefillTarget,
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

  it("enables only manually approved provider parameters and opens exact entry points", () => {
    expect(EXTERNAL_AI_PROVIDERS.gemini.entryPoint).toBe("https://gemini.google.com/");
    expect(EXTERNAL_AI_PROVIDERS.chatgpt.entryPoint).toBe("https://chatgpt.com/");
    expect(EXTERNAL_AI_PROVIDERS.claude.entryPoint).toBe("https://claude.ai/new");
    expect(EXTERNAL_AI_PROVIDERS.grok.entryPoint).toBe("https://grok.com/");
    expect(EXTERNAL_AI_PROVIDERS.chatgpt.prefillStatus).toBe("unverified");
    expect(EXTERNAL_AI_PROVIDERS.chatgpt.prefillCandidate).toBe("prompt");
    expect(EXTERNAL_AI_PROVIDERS.claude.prefillStatus).toBe("enabled");
    expect(EXTERNAL_AI_PROVIDERS.claude.prefillParameter).toBe("q");
    expect(EXTERNAL_AI_PROVIDERS.grok.prefillStatus).toBe("enabled");
    expect(EXTERNAL_AI_PROVIDERS.grok.prefillParameter).toBe("q");

    const prompt = "Complete Launch Package";
    for (const provider of ["gemini", "chatgpt"] as const) {
      const adapter = EXTERNAL_AI_PROVIDERS[provider];
      expect("prefillParameter" in adapter).toBe(false);
      const target = buildProviderLaunchTarget(provider, prompt);
      expect(target).toEqual({ url: adapter.entryPoint, promptPrefilled: false });
      expect(new URL(target.url).search).toBe("");
    }

    for (const provider of ["claude", "grok"] as const) {
      const target = buildProviderLaunchTarget(provider, prompt);
      const url = new URL(target.url);

      expect(target.promptPrefilled).toBe(true);
      expect(url.searchParams.get("q")).toBe(prompt);
      expect([...url.searchParams.keys()]).toEqual(["q"]);
    }
  });

  it("round-trips candidate prefill values with special characters through URL construction", () => {
    const prompt = [
      "PEARLHUB-PREFILL-QA-2026-11",
      "Second line",
      "香港 · 雪",
      `Literal & ? # % " '`,
      "```markdown",
      "Harmless marker only",
      "```",
    ].join("\n");
    const candidates = [
      { entryPoint: EXTERNAL_AI_PROVIDERS.chatgpt.entryPoint, parameter: "prompt" },
      { entryPoint: EXTERNAL_AI_PROVIDERS.claude.entryPoint, parameter: "q" },
      { entryPoint: EXTERNAL_AI_PROVIDERS.grok.entryPoint, parameter: "q" },
    ];

    for (const { entryPoint, parameter } of candidates) {
      const target = buildPromptPrefillTarget(entryPoint, parameter, prompt);
      const url = new URL(target.url);

      expect(target.promptPrefilled).toBe(true);
      expect(url.searchParams.get(parameter)).toBe(prompt);
      expect([...url.searchParams.keys()]).toEqual([parameter]);
      expect(launchPackageSizeInBytes(target.url)).toBeLessThanOrEqual(PROVIDER_PREFILL_MAX_URL_BYTES);
    }
  });

  it("checks UTF-8 bytes for the full URL and falls back without prompt content when over limit", () => {
    const entryPoint = EXTERNAL_AI_PROVIDERS.chatgpt.entryPoint;
    const prompt = "香港".repeat(1_000);
    const attemptedUrl = new URL(entryPoint);
    attemptedUrl.searchParams.set("prompt", prompt);

    expect(launchPackageSizeInBytes(attemptedUrl.toString())).toBeGreaterThan(PROVIDER_PREFILL_MAX_URL_BYTES);
    expect(prompt.length).toBeLessThan(PROVIDER_PREFILL_MAX_URL_BYTES);

    expect(buildPromptPrefillTarget(entryPoint, "prompt", prompt)).toEqual({
      url: entryPoint,
      promptPrefilled: false,
    });
  });

  it("keeps a serialized Launch Package just under the URL limit and falls back just over it", () => {
    const entryPoint = EXTERNAL_AI_PROVIDERS.chatgpt.entryPoint;
    const packageForInstructions = (instructions: string) => serializeLaunchPackageMarkdown(
      buildLaunchPackage(
        {
          ...source,
          version: {
            ...source.version,
            content: { ...source.version.content, instructions },
          },
        },
        resolutionRun,
        [{ manifest: dependencyManifest, published: dependencyVersion }],
      ),
    );

    let low = 0;
    let high = PROVIDER_PREFILL_MAX_URL_BYTES;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const target = buildPromptPrefillTarget(
        entryPoint,
        "prompt",
        packageForInstructions("x".repeat(middle)),
      );
      if (target.promptPrefilled) low = middle;
      else high = middle - 1;
    }

    const withinLimit = buildPromptPrefillTarget(
      entryPoint,
      "prompt",
      packageForInstructions("x".repeat(low)),
    );
    const overLimit = buildPromptPrefillTarget(
      entryPoint,
      "prompt",
      packageForInstructions("x".repeat(low + 1)),
    );

    expect(withinLimit.promptPrefilled).toBe(true);
    expect(launchPackageSizeInBytes(withinLimit.url)).toBeLessThanOrEqual(PROVIDER_PREFILL_MAX_URL_BYTES);
    expect(overLimit).toEqual({ url: entryPoint, promptPrefilled: false });
  });
});
