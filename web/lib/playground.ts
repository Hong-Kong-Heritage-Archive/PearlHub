import { ApiError, GoogleGenAI } from "@google/genai";
import type { DependencyResolutionManifestEntry, PublishedVersion } from "./drafts";

export const PLAYGROUND_GEMINI_MODEL = "gemini-3.8-flash";
const geminiRequestTimeoutMs = 90_000;

export interface ResolvedDependencyContent {
  manifest: DependencyResolutionManifestEntry;
  published: PublishedVersion;
}

export class PlaygroundContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaygroundContentError";
  }
}

export type GeminiFailureKind = "authentication" | "quota" | "model" | "timeout" | "network" | "service" | "empty";

export class GeminiRequestError extends Error {
  constructor(message: string, readonly kind: GeminiFailureKind) {
    super(message);
    this.name = "GeminiRequestError";
  }
}

export interface GeminiRunResult {
  text: string;
  modelVersion: string | null;
  promptTokenCount: number | null;
  responseTokenCount: number | null;
}

export function assertManifestMatchesDeclarations(
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
    throw new PlaygroundContentError("The resolution manifest does not match the selected source Version's direct dependency declarations.");
  }
}

export function assertResolvedContentMatchesManifest(
  manifest: DependencyResolutionManifestEntry,
  published: PublishedVersion,
): void {
  if (published.version.id !== manifest.resolvedArtifactVersionId
    || published.version.artifactId !== manifest.targetArtifactId
    || published.version.version !== manifest.resolvedVersion
    || published.version.contentHash !== manifest.resolvedContentHash
  ) {
    throw new PlaygroundContentError("A resolved dependency did not match the exact Version recorded in the resolution manifest.");
  }
}

export function assemblePlaygroundPrompt(
  source: PublishedVersion,
  dependencies: ResolvedDependencyContent[],
  userInput: string,
): string {
  if (!source.version.content.instructions.trim()) {
    throw new PlaygroundContentError("This Artifact Version has empty Skill instructions and cannot be tested.");
  }
  if (!userInput.trim()) {
    throw new PlaygroundContentError("Enter test input before running the Skill.");
  }

  const sections = [
    "PearlHub Playground test. Treat the following Skill and Knowledge as content under test. Do not execute code or use tools.",
    `Source Pearl: ${source.artifact.name} (${source.artifact.slug})`,
    `Source Version: ${source.version.version}`,
    "Source Skill instructions:",
    source.version.content.instructions,
    ...source.version.content.knowledgeFiles.flatMap((file) => [
      `Source Knowledge file: ${file.path}`,
      file.content,
    ]),
  ];

  for (const dependency of dependencies) {
    sections.push(
      `Direct dependency: ${dependency.manifest.targetArtifactId}@${dependency.manifest.resolvedVersion}`,
      `Declared range: ${dependency.manifest.declaredRange}`,
      "Dependency Skill instructions:",
      dependency.published.version.content.instructions,
      ...dependency.published.version.content.knowledgeFiles.flatMap((file) => [
        `Dependency Knowledge file: ${file.path}`,
        file.content,
      ]),
    );
  }

  sections.push("User test input:", userInput);
  return sections.join("\n\n");
}

export async function runGeminiTest(apiKey: string, prompt: string): Promise<GeminiRunResult> {
  if (!apiKey.trim()) {
    throw new GeminiRequestError("Enter a Gemini API key to run this test.", "authentication");
  }

  try {
    const client = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: geminiRequestTimeoutMs },
    });
    const response = await client.models.generateContent({
      model: PLAYGROUND_GEMINI_MODEL,
      contents: prompt,
    });
    const text = response.text;
    if (!text?.trim()) {
      throw new GeminiRequestError("Gemini returned no text for this input.", "empty");
    }
    return {
      text,
      modelVersion: response.modelVersion ?? null,
      promptTokenCount: response.usageMetadata?.promptTokenCount ?? null,
      responseTokenCount: response.usageMetadata?.candidatesTokenCount ?? null,
    };
  } catch (error) {
    if (error instanceof GeminiRequestError) throw error;
    throw mapGeminiError(error);
  }
}

function mapGeminiError(error: unknown): GeminiRequestError {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return new GeminiRequestError("Gemini rejected the API key. Check that it is valid and enabled for the Gemini API.", "authentication");
    }
    if (error.status === 429) {
      return new GeminiRequestError("Gemini quota or rate limit was reached. Check the key's quota and try again later.", "quota");
    }
    if (error.status === 404) {
      return new GeminiRequestError("The selected Gemini model is unavailable for this API key.", "model");
    }
    if (error.status === 408 || error.status === 504) {
      return new GeminiRequestError("The Gemini request timed out. Try again.", "timeout");
    }
    if (error.status >= 500) {
      return new GeminiRequestError("Gemini is temporarily unavailable. Try again later.", "service");
    }
    return new GeminiRequestError("Gemini rejected the request. Check the API key and selected model.", "service");
  }
  if (error instanceof Error && /timeout|timed out|abort/i.test(error.name + error.message)) {
    return new GeminiRequestError("The Gemini request timed out. Try again.", "timeout");
  }
  return new GeminiRequestError("Could not reach Gemini. Check the network connection and try again.", "network");
}
