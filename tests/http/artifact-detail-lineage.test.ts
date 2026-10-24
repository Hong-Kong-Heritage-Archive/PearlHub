import { describe, expect, it, vi } from "vitest";
import type { ArtifactReadService } from "../../src/application/services.js";
import { Artifact } from "../../src/domain/artifact.js";
import type { Lineage } from "../../src/domain/records.js";
import { DomainError } from "../../src/domain/errors.js";
import { createHttpApp } from "../../src/http/app.js";
import { DevelopmentOnlyFakeAuthenticator } from "../../src/http/testing/development-fake-authenticator.js";

const ownerId = "internal-owner";
const otherOwnerId = "other-owner";
const authenticator = new DevelopmentOnlyFakeAuthenticator(ownerId, "owner-token", [
  { userId: otherOwnerId, token: "other-token" },
]);

function makeApp(reads: {
  getArtifact: ArtifactReadService["getArtifact"];
  getArtifactLineage: ArtifactReadService["getArtifactLineage"];
}) {
  return createHttpApp({
    listArtifacts: { execute: async () => ({ items: [], nextCursor: null }) },
    artifactReads: reads,
    authenticator,
  });
}

const artifact = {
  id: "artifact-1",
  ownerId,
  name: "Visible Artifact",
  slug: "visible-artifact",
  visibility: "public",
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};
const domainArtifact = Artifact.create({
  id: artifact.id,
  ownerId: artifact.ownerId,
  name: artifact.name,
  slug: artifact.slug,
  visibility: "public",
  createdAt: artifact.createdAt,
});
const parentArtifact = Artifact.create({
  id: "parent-id",
  ownerId,
  name: "Parent Artifact",
  slug: "parent-artifact",
  visibility: "public",
  createdAt: artifact.createdAt,
});
const childArtifact = Artifact.create({
  id: "child-id",
  ownerId,
  name: "Child Artifact",
  slug: "child-artifact",
  visibility: "public",
  createdAt: artifact.createdAt,
});

describe("GET /api/v1/artifacts/{artifactId}", () => {
  it("returns canonical Artifact metadata for an anonymous public read", async () => {
    const getArtifact = vi.fn(async () => domainArtifact);
    const app = makeApp({ getArtifact, getArtifactLineage: vi.fn() });

    const response = await app.request("/api/v1/artifacts/artifact-1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...artifact,
      createdAt: artifact.createdAt.toISOString(),
      updatedAt: artifact.createdAt.toISOString(),
    });
    expect(getArtifact).toHaveBeenCalledWith({ actorId: null, artifactId: "artifact-1" });
  });

  it("passes the authenticated principal and maps authorization, missing, and tombstone errors", async () => {
    const getArtifact = vi.fn(async () => domainArtifact);
    const app = makeApp({ getArtifact, getArtifactLineage: vi.fn() });
    const ownerResponse = await app.request("/api/v1/artifacts/artifact-1", {
      headers: { authorization: "Bearer owner-token" },
    });
    expect(ownerResponse.status).toBe(200);
    expect(getArtifact).toHaveBeenCalledWith({ actorId: ownerId, artifactId: "artifact-1" });

    for (const [error, status, code] of [
      [new DomainError("FORBIDDEN", "Actor cannot read this Artifact."), 403, "FORBIDDEN"],
      [new DomainError("ARTIFACT_NOT_FOUND", "Artifact was not found."), 404, "ARTIFACT_NOT_FOUND"],
      [new DomainError("ARTIFACT_GONE", "Artifact has been tombstoned."), 410, "ARTIFACT_GONE"],
    ] as const) {
      getArtifact.mockRejectedValueOnce(error);
      const response = await app.request("/api/v1/artifacts/artifact-1", {
        headers: { authorization: "Bearer other-token" },
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
  });
});

describe("GET /api/v1/artifacts/{artifactId}/lineage", () => {
  it("returns both relation directions and their exact source-version IDs", async () => {
    const parent: Lineage = {
      id: "edge-parent",
      parentArtifactId: "parent-id",
      childArtifactId: "artifact-1",
      sourceVersionId: "parent-version-id",
      relationshipType: "fork",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    };
    const child: Lineage = {
      id: "edge-child",
      parentArtifactId: "artifact-1",
      childArtifactId: "child-id",
      sourceVersionId: "source-version-id",
      relationshipType: "fork",
      createdAt: new Date("2026-01-04T00:00:00.000Z"),
    };
    const getArtifactLineage = vi.fn(async () => ({
      parents: [{ lineage: parent, artifact: parentArtifact }],
      children: [{ lineage: child, artifact: childArtifact }],
    }));
    const app = makeApp({ getArtifact: vi.fn(), getArtifactLineage });

    const response = await app.request("/api/v1/artifacts/artifact-1/lineage", {
      headers: { authorization: "Bearer owner-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      parents: [{ parentArtifactId: "parent-id", childArtifactId: "artifact-1", sourceVersionId: "parent-version-id", artifact: { name: "Parent Artifact" } }],
      children: [{ parentArtifactId: "artifact-1", childArtifactId: "child-id", sourceVersionId: "source-version-id", artifact: { name: "Child Artifact" } }],
    });
    expect(getArtifactLineage).toHaveBeenCalledWith({ actorId: ownerId, artifactId: "artifact-1" });
  });

  it("returns an empty representation and preserves access errors", async () => {
    const getArtifactLineage = vi.fn()
      .mockResolvedValueOnce({ parents: [], children: [] })
      .mockRejectedValueOnce(new DomainError("FORBIDDEN", "Actor cannot read this Artifact."));
    const app = makeApp({ getArtifact: vi.fn(), getArtifactLineage });

    const empty = await app.request("/api/v1/artifacts/artifact-1/lineage");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ parents: [], children: [] });

    const denied = await app.request("/api/v1/artifacts/artifact-1/lineage", {
      headers: { authorization: "Bearer other-token" },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });
});
