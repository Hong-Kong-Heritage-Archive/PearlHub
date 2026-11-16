import type {
  DependencyResolutionManifestEntry,
  DependencyResolutionRun,
  PublishedVersion,
} from "./drafts";

export const LAUNCH_PACKAGE_CLIPBOARD_MAX_BYTES = 64 * 1024;
export const PROVIDER_PREFILL_MAX_URL_BYTES = 8 * 1024;
const packageFormatVersion = 1;
const textContentType = "text/plain; charset=utf-8";

export interface ExternalAIProviderConfig {
  id: string;
  name: string;
  entryPoint: string;
  prefillStatus: "not-offered" | "unverified" | "enabled";
  prefillCandidate?: string;
  prefillParameter?: string;
}

export const EXTERNAL_AI_PROVIDERS = {
  gemini: {
    id: "gemini",
    name: "Gemini",
    entryPoint: "https://gemini.google.com/",
    prefillStatus: "not-offered",
  },
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    entryPoint: "https://chatgpt.com/",
    prefillStatus: "unverified",
    prefillCandidate: "prompt",
  },
  claude: {
    id: "claude",
    name: "Claude",
    entryPoint: "https://claude.ai/new",
    prefillStatus: "enabled",
    prefillParameter: "q",
  },
  grok: {
    id: "grok",
    name: "Grok",
    entryPoint: "https://grok.com/",
    prefillStatus: "enabled",
    prefillParameter: "q",
  },
} as const satisfies Record<"gemini" | "chatgpt" | "claude" | "grok", ExternalAIProviderConfig>;

export type ExternalAIProvider = keyof typeof EXTERNAL_AI_PROVIDERS;

export interface ProviderLaunchTarget {
  url: string;
  promptPrefilled: boolean;
}

export function buildProviderLaunchTarget(
  provider: ExternalAIProvider,
  prompt: string,
): ProviderLaunchTarget {
  const adapter: ExternalAIProviderConfig = EXTERNAL_AI_PROVIDERS[provider];
  if (!adapter.prefillParameter) {
    return { url: adapter.entryPoint, promptPrefilled: false };
  }

  return buildPromptPrefillTarget(adapter.entryPoint, adapter.prefillParameter, prompt);
}

export function buildPromptPrefillTarget(
  entryPoint: string,
  parameter: string,
  prompt: string,
): ProviderLaunchTarget {
  const url = new URL(entryPoint);
  url.searchParams.set(parameter, prompt);
  const target = url.toString();
  if (launchPackageSizeInBytes(target) > PROVIDER_PREFILL_MAX_URL_BYTES) {
    return { url: entryPoint, promptPrefilled: false };
  }

  return { url: target, promptPrefilled: true };
}

export interface LaunchPackageKnowledgeFile {
  path: string;
  contentType: string;
  contentHash: string;
  content: string;
}

export interface LaunchPackageDependency {
  manifest: DependencyResolutionManifestEntry;
  skillName: string;
  instructions: string;
  knowledgeFiles: LaunchPackageKnowledgeFile[];
}

export interface LaunchPackageManifest {
  format: "pearlhub-launch-package";
  formatVersion: number;
  createdAt: string;
  source: {
    platform: "PearlHub";
    artifactId: string;
    artifactName: string;
    artifactSlug: string;
    artifactVersionId: string;
    version: string;
    contentHash: string;
    skillName: string;
  };
  resolution: {
    runId: string;
    manifestVersion: number;
    resolverPolicyVersion: string;
    manifestHash: string;
    dependencies: DependencyResolutionManifestEntry[];
  };
}

export interface LaunchPackage {
  manifest: LaunchPackageManifest;
  sessionBootstrap: string;
  skillInstructions: string;
  knowledgeFiles: LaunchPackageKnowledgeFile[];
  dependencies: LaunchPackageDependency[];
}

export class LaunchPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchPackageError";
  }
}

export function buildLaunchPackage(
  source: PublishedVersion,
  resolution: DependencyResolutionRun,
  resolvedDependencies: Array<{ manifest: DependencyResolutionManifestEntry; published: PublishedVersion }>,
  createdAt = new Date(),
): LaunchPackage {
  if (!source.version.content.instructions.trim()) {
    throw new LaunchPackageError("The selected Artifact Version has empty Skill instructions.");
  }
  if (resolution.sourceArtifactVersionId !== source.version.id) {
    throw new LaunchPackageError("The resolution manifest does not belong to the selected Artifact Version.");
  }

  assertManifestMatchesDeclarations(source, resolution.dependencies);
  if (resolution.dependencies.length !== resolvedDependencies.length) {
    throw new LaunchPackageError("The Launch Package is incomplete because required dependency content is unavailable.");
  }

  const dependencies = resolution.dependencies.map((manifest, index) => {
    const resolved = resolvedDependencies[index];
    if (!resolved || !sameManifestEntry(manifest, resolved.manifest)) {
      throw new LaunchPackageError("The Launch Package dependency content does not match the resolution manifest.");
    }
    assertResolvedContentMatchesManifest(manifest, resolved.published);
    return {
      manifest: { ...manifest },
      skillName: resolved.published.artifact.name,
      instructions: resolved.published.version.content.instructions,
      knowledgeFiles: copyKnowledgeFiles(resolved.published),
    };
  });

  return {
    manifest: {
      format: "pearlhub-launch-package",
      formatVersion: packageFormatVersion,
      createdAt: createdAt.toISOString(),
      source: {
        platform: "PearlHub",
        artifactId: source.artifact.id,
        artifactName: source.artifact.name,
        artifactSlug: source.artifact.slug,
        artifactVersionId: source.version.id,
        version: source.version.version,
        contentHash: source.version.contentHash,
        skillName: source.artifact.name,
      },
      resolution: {
        runId: resolution.runId,
        manifestVersion: resolution.manifestVersion,
        resolverPolicyVersion: resolution.resolverPolicyVersion,
        manifestHash: resolution.manifestHash,
        dependencies: resolution.dependencies.map((entry) => ({ ...entry })),
      },
    },
    sessionBootstrap,
    skillInstructions: source.version.content.instructions,
    knowledgeFiles: copyKnowledgeFiles(source),
    dependencies,
  };
}

export function serializeLaunchPackageMarkdown(launchPackage: LaunchPackage): string {
  const sections = [
    "# PearlHub External AI Launch Package",
    "Paste this complete package into a regular conversation with the external AI provider. PearlHub does not submit it for you.",
    "## Provenance and exact dependency manifest",
    markdownFence(JSON.stringify(launchPackage.manifest, null, 2), "json"),
    "## Conversation guidance",
    launchPackage.sessionBootstrap,
    "## Selected Skill instructions (canonical content, verbatim)",
    markdownFence(launchPackage.skillInstructions, "text"),
    ...launchPackage.knowledgeFiles.flatMap((file, index) => [
      `## Source Knowledge file ${index + 1}`,
      `Path: ${JSON.stringify(file.path)}  \nContent type: ${file.contentType}  \nContent hash: ${file.contentHash}`,
      markdownFence(file.content, "text"),
    ]),
    ...launchPackage.dependencies.flatMap((dependency, dependencyIndex) => [
      `## Direct dependency ${dependencyIndex + 1}: ${JSON.stringify(dependency.skillName)}`,
      "Exact resolution entry:",
      markdownFence(JSON.stringify(dependency.manifest, null, 2), "json"),
      "Dependency Skill instructions (canonical content, verbatim):",
      markdownFence(dependency.instructions, "text"),
      ...dependency.knowledgeFiles.flatMap((file, fileIndex) => [
        `### Dependency Knowledge file ${fileIndex + 1}`,
        `Path: ${JSON.stringify(file.path)}  \nContent type: ${file.contentType}  \nContent hash: ${file.contentHash}`,
        markdownFence(file.content, "text"),
      ]),
    ]),
  ];

  return `${sections.join("\n\n")}\n`;
}

export function launchPackageSizeInBytes(markdown: string): number {
  return new TextEncoder().encode(markdown).byteLength;
}

export function makeLaunchPackageFilename(source: PublishedVersion): string {
  const safeSlug = source.artifact.slug.replace(/[^a-zA-Z0-9._-]/g, "-") || "pearl";
  const safeVersion = source.version.version.replace(/[^a-zA-Z0-9._-]/g, "-") || "version";
  return `${safeSlug}-${safeVersion}-launch-package.md`;
}

function assertManifestMatchesDeclarations(
  source: PublishedVersion,
  manifest: DependencyResolutionManifestEntry[],
): void {
  const declared = source.version.content.dependencies
    .map(({ targetArtifactId, declaredRange }) => `${targetArtifactId}\u0000${declaredRange}`)
    .sort();
  const resolved = manifest
    .map(({ targetArtifactId, declaredRange }) => `${targetArtifactId}\u0000${declaredRange}`)
    .sort();
  if (declared.length !== resolved.length || declared.some((declaration, index) => declaration !== resolved[index])) {
    throw new LaunchPackageError("The resolution manifest does not match the selected Artifact Version's direct dependency declarations.");
  }
}

function assertResolvedContentMatchesManifest(
  manifest: DependencyResolutionManifestEntry,
  published: PublishedVersion,
): void {
  if (published.version.id !== manifest.resolvedArtifactVersionId
    || published.version.artifactId !== manifest.targetArtifactId
    || published.version.version !== manifest.resolvedVersion
    || published.version.contentHash !== manifest.resolvedContentHash
  ) {
    throw new LaunchPackageError("A dependency's loaded content does not match the exact Version recorded in the resolution manifest.");
  }
}

function sameManifestEntry(left: DependencyResolutionManifestEntry, right: DependencyResolutionManifestEntry): boolean {
  return left.dependencyId === right.dependencyId
    && left.targetArtifactId === right.targetArtifactId
    && left.declaredRange === right.declaredRange
    && left.resolvedArtifactVersionId === right.resolvedArtifactVersionId
    && left.resolvedVersion === right.resolvedVersion
    && left.resolvedContentHash === right.resolvedContentHash
    && left.resolvedAt === right.resolvedAt;
}

function copyKnowledgeFiles(published: PublishedVersion): LaunchPackageKnowledgeFile[] {
  return published.version.content.knowledgeFiles.map((file) => ({
    path: file.path,
    contentType: textContentType,
    contentHash: file.contentHash,
    content: file.content,
  }));
}

function markdownFence(content: string, language: string): string {
  let longestRun = 0;
  for (const match of content.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}`;
}

const sessionBootstrap = [
  "Treat the included Skill instructions as the task specification for this conversation. Follow the Skill's own instructions and priority rules; do not rewrite or weaken them.",
  "Use the included Knowledge files and resolved dependency material as reference context.",
  "Conduct a multi-turn interaction when useful, retain relevant context and answers in this provider conversation, and do not assume all required information was supplied in the first message.",
  "Ask focused clarifying questions rather than guessing when essential information is missing.",
  "For quizzes, choices, scoring, forms or similar interactions, use this provider's native interactive or rich-response capabilities when supported. If they are unavailable, use clear conversational text and numbered choices.",
  "This package does not install or permanently save the Skill. Do not claim that it has been installed or saved.",
].join("\n");
