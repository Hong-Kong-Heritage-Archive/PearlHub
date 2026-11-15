import { describe, expect, it, vi } from "vitest";
import type {
  SourceVersionDependencyResolution,
  SourceVersionDependencyResolutionResult,
} from "../../src/application/source-version-dependency-resolution.js";
import type { DraftWorkflow } from "../../src/application/services.js";
import { Artifact } from "../../src/domain/artifact.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import { DomainError } from "../../src/domain/errors.js";
import { createHttpApp } from "../../src/http/app.js";
import type { Authenticator } from "../../src/http/authentication.js";

const createdAt = new Date("2026-11-12T00:00:00.000Z");
const artifact = Artifact.create({
  id: "00000000-0000-4000-8000-000000000001",
  ownerId: "owner-id",
  name: "Test Pearl",
  slug: "test-pearl",
  visibility: "public",
  createdAt,
});
const sourceVersion = ArtifactVersion.create({
  id: "00000000-0000-4000-8000-000000000002",
  artifactId: artifact.id,
  version: "1.2.3",
  contentHash: `sha256:${"a".repeat(64)}`,
  contentLocation: "postgres:test-pearl:1.2.3",
  createdAt,
  publishedAt: createdAt,
});
const result: SourceVersionDependencyResolutionResult = {
  runId: "00000000-0000-4000-8000-000000000003",
  sourceArtifactVersionId: sourceVersion.id,
  createdAt,
  initiatorUserId: "owner-id",
  manifestVersion: 1,
  resolverPolicyVersion: "semver-highest-v1",
  manifestHash: `sha256:${"b".repeat(64)}`,
  dependencies: [{
    id: "00000000-0000-4000-8000-000000000004",
    runId: "00000000-0000-4000-8000-000000000003",
    dependencyId: "00000000-0000-4000-8000-000000000005",
    targetArtifactId: "00000000-0000-4000-8000-000000000006",
    declaredRange: "^2.0.0",
    resolvedArtifactVersionId: "00000000-0000-4000-8000-000000000007",
    resolvedVersion: "2.3.1",
    resolvedContentHash: `sha256:${"c".repeat(64)}`,
    resolvedAt: createdAt,
  }],
};

function makeApp(execute: SourceVersionDependencyResolution["execute"] = vi.fn(async () => result)) {
  const drafts: DraftWorkflow = {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    discard: vi.fn(),
    createWorkCopy: vi.fn(),
    createFork: vi.fn(),
    createClone: vi.fn(),
    publish: vi.fn(),
    getPublishedVersion: vi.fn(async () => ({ artifact, version: sourceVersion })),
    listPublishedVersions: vi.fn(),
  };
  const authenticator: Authenticator = {
    authenticate: async (headers) => {
      if (headers.get("authorization") === "Bearer owner-token") return { userId: "owner-id" };
      if (headers.get("authorization") === "Bearer other-token") return { userId: "other-id" };
      return null;
    },
  };
  return {
    app: createHttpApp({
      drafts,
      resolveSourceVersionDependencies: { execute },
      listArtifacts: { execute: async () => ({ items: [], nextCursor: null }) },
      authenticator,
    }),
    drafts,
    execute,
  };
}

describe("POST /api/v1/artifacts/{artifactId}/versions/{version}/dependency-resolutions", () => {
  const path = `/api/v1/artifacts/${artifact.id}/versions/${sourceVersion.version}/dependency-resolutions`;

  it("creates and returns the exact persisted direct-dependency manifest", async () => {
    const { app, drafts, execute } = makeApp();
    const response = await app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer owner-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runId: result.runId,
      sourceArtifactVersionId: sourceVersion.id,
      createdAt: createdAt.toISOString(),
      manifestVersion: 1,
      resolverPolicyVersion: "semver-highest-v1",
      manifestHash: result.manifestHash,
      dependencies: [{
        dependencyId: result.dependencies[0]?.dependencyId,
        targetArtifactId: result.dependencies[0]?.targetArtifactId,
        declaredRange: "^2.0.0",
        resolvedArtifactVersionId: result.dependencies[0]?.resolvedArtifactVersionId,
        resolvedVersion: "2.3.1",
        resolvedContentHash: `sha256:${"c".repeat(64)}`,
        resolvedAt: createdAt.toISOString(),
      }],
    });
    expect(drafts.getPublishedVersion).toHaveBeenCalledWith({
      actorId: "owner-id",
      artifactId: artifact.id,
      version: sourceVersion.version,
    });
    expect(execute).toHaveBeenCalledWith({
      actorId: "owner-id",
      sourceArtifactVersionId: sourceVersion.id,
    });
  });

  it("requires authentication before reading or resolving the source", async () => {
    const { app, drafts, execute } = makeApp();
    const response = await app.request(path, { method: "POST" });

    expect(response.status).toBe(401);
    expect(drafts.getPublishedVersion).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves source write authorization and generic unresolved-target errors", async () => {
    const execute = vi.fn(async ({ actorId }: { actorId: string; sourceArtifactVersionId: string }) => {
      if (actorId !== "owner-id") throw new DomainError("FORBIDDEN", "Actor cannot resolve dependencies for this source Artifact.");
      throw new DomainError("DEPENDENCY_RESOLUTION_FAILED", "A dependency could not be resolved.");
    });
    const { app } = makeApp(execute);

    const forbidden = await app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer other-token" },
    });
    expect(forbidden.status).toBe(403);

    const failed = await app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer owner-token" },
    });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toMatchObject({
      error: { code: "DEPENDENCY_RESOLUTION_FAILED", message: "A dependency could not be resolved." },
    });
  });
});
