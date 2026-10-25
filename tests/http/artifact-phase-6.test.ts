import { describe, expect, it, vi } from "vitest";
import type { DraftWorkflowService, UpdateArtifactMetadataService } from "../../src/application/services.js";
import { Artifact } from "../../src/domain/artifact.js";
import { DomainError } from "../../src/domain/errors.js";
import { createHttpApp } from "../../src/http/app.js";
import { DevelopmentOnlyFakeAuthenticator } from "../../src/http/testing/development-fake-authenticator.js";

const ownerId = "phase-six-owner";
const authenticator = new DevelopmentOnlyFakeAuthenticator(ownerId, "owner-token", [
  { userId: "non-owner", token: "non-owner-token" },
]);
const artifact = Artifact.create({
  id: "artifact-1",
  ownerId,
  name: "Phase Six Pearl",
  slug: "phase-six-pearl",
  visibility: "public",
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
});

function makeApp(
  update: UpdateArtifactMetadataService["execute"] = async () => artifact,
  getDependencies: DraftWorkflowService["getVersionDependencies"] = async () => ({
    artifactId: artifact.id,
    version: "1.2.0",
    dependencies: [{
      targetArtifactId: "private-target-id",
      declaredRange: "^2.0.0",
      resolutions: [{ version: "2.1.3", resolvedAt: new Date("2026-05-02T00:00:00.000Z") }],
    }],
  }),
) {
  return createHttpApp({
    listArtifacts: { execute: async () => ({ items: [], nextCursor: null }) },
    authenticator,
    updateArtifactMetadata: { execute: update },
    artifactVersionDependencies: { getVersionDependencies: getDependencies },
  });
}

describe("PATCH /api/v1/artifacts/{artifactId}", () => {
  it("requires authentication and returns the canonical updated Artifact", async () => {
    const update = vi.fn(async () => artifact);
    const app = makeApp(update);
    const unauthenticated = await app.request(`/api/v1/artifacts/${artifact.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(update).not.toHaveBeenCalled();

    const response = await app.request(`/api/v1/artifacts/${artifact.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: artifact.id,
      ownerId,
      name: artifact.name,
      slug: artifact.slug,
      visibility: "public",
      status: "active",
      createdAt: artifact.createdAt.toISOString(),
      updatedAt: artifact.updatedAt.toISOString(),
    });
    expect(update).toHaveBeenCalledWith({ actorId: ownerId, artifactId: artifact.id, visibility: "private" });
  });

  it.each([
    ["empty", {}],
    ["immutable name", { name: "Changed" }],
    ["immutable slug", { slug: "changed" }],
    ["identity", { id: "other" }],
    ["owner", { ownerId: "other" }],
    ["status", { status: "tombstone" }],
    ["version content", { content: { instructions: "changed" } }],
    ["content hash", { contentHash: "changed" }],
    ["dependencies", { dependencies: [] }],
    ["lineage", { lineage: [] }],
    ["provenance", { provenance: {} }],
    ["unknown", { tags: ["new"] }],
    ["invalid visibility", { visibility: "hidden" }],
  ])("rejects %s patch bodies", async (_label, body) => {
    const update = vi.fn(async () => artifact);
    const response = await makeApp(update).request(`/api/v1/artifacts/${artifact.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("preserves owner, missing Artifact, and tombstone errors", async () => {
    const app = makeApp(async () => { throw new DomainError("FORBIDDEN", "Actor cannot modify this Artifact."); });
    const denied = await app.request(`/api/v1/artifacts/${artifact.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer non-owner-token", "content-type": "application/json" },
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    for (const [code, status] of [["ARTIFACT_NOT_FOUND", 404], ["ARTIFACT_GONE", 410]] as const) {
      const response = await makeApp(async () => {
        throw new DomainError(code, code === "ARTIFACT_GONE" ? "Artifact has been tombstoned." : "Artifact was not found.");
      }).request(`/api/v1/artifacts/${artifact.id}`, {
        method: "PATCH",
        headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
        body: JSON.stringify({ visibility: "private" }),
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
  });
});

describe("GET /api/v1/artifacts/{artifactId}/versions/{version}/dependencies", () => {
  it("passes the exact requested Version and returns only recorded target identifiers and resolutions", async () => {
    const getDependencies = vi.fn(async () => ({
      artifactId: artifact.id,
      version: "1.2.0",
      dependencies: [{
        targetArtifactId: "private-target-id",
        declaredRange: "^2.0.0",
        resolutions: [{ version: "2.1.3", resolvedAt: new Date("2026-05-02T00:00:00.000Z") }],
      }],
    }));
    const response = await makeApp(undefined, getDependencies).request(
      `/api/v1/artifacts/${artifact.id}/versions/1.2.0/dependencies`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      artifactId: artifact.id,
      version: "1.2.0",
      dependencies: [{
        targetArtifactId: "private-target-id",
        declaredRange: "^2.0.0",
        resolutions: [{ version: "2.1.3", resolvedAt: "2026-05-02T00:00:00.000Z" }],
      }],
    });
    expect(getDependencies).toHaveBeenCalledWith({ actorId: null, artifactId: artifact.id, version: "1.2.0" });
  });

  it("returns an empty dependency collection and maps visibility, missing, and tombstone errors", async () => {
    const empty = await makeApp(undefined, async () => ({
      artifactId: artifact.id,
      version: "2.0.0",
      dependencies: [],
    })).request(`/api/v1/artifacts/${artifact.id}/versions/2.0.0/dependencies`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ artifactId: artifact.id, version: "2.0.0", dependencies: [] });

    for (const [code, status] of [
      ["FORBIDDEN", 403],
      ["ARTIFACT_NOT_FOUND", 404],
      ["VERSION_NOT_FOUND", 404],
      ["ARTIFACT_GONE", 410],
    ] as const) {
      const response = await makeApp(undefined, async () => {
        throw new DomainError(code, "Request could not be completed.");
      }).request(`/api/v1/artifacts/${artifact.id}/versions/1.2.0/dependencies`);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
  });
});
