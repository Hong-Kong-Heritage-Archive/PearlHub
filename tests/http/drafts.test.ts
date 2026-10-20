import { describe, expect, it, vi } from "vitest";
import type { DraftWorkflow } from "../../src/application/services.js";
import { Artifact } from "../../src/domain/artifact.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import { Draft } from "../../src/domain/draft.js";
import { DomainError } from "../../src/domain/errors.js";
import { createHttpApp } from "../../src/http/app.js";
import type { Authenticator } from "../../src/http/authentication.js";

const date = new Date("2026-01-01T00:00:00.000Z");
const pearlContent = { instructions: "Do work", knowledgeFiles: [{ path: "guide.md", content: "Knowledge" }], dependencies: [] };
const storedDraft = Draft.create({
  id: "draft-id", ownerId: "owner-id", artifactId: null, baseVersionId: null,
  name: "Pearl", slug: "pearl", visibility: "public", content: pearlContent, createdAt: date, updatedAt: date,
});
const artifact = Artifact.create({ id: "artifact-id", ownerId: "owner-id", name: "Pearl", slug: "pearl", visibility: "public", createdAt: date });
const version = ArtifactVersion.create({
  id: "version-id", artifactId: artifact.id, version: "0.1.0", contentHash: "sha256:abc", contentLocation: "postgres:artifact-id:0.1.0",
  contentSnapshot: { ...pearlContent, knowledgeFiles: [{ path: "guide.md", content: "Knowledge", contentHash: "sha256:file" }] },
  createdAt: date, publishedAt: date,
});

function makeApp(overrides: Partial<DraftWorkflow> = {}) {
  const drafts: DraftWorkflow = {
    create: vi.fn(async () => storedDraft),
    list: vi.fn(async () => [storedDraft]),
    get: vi.fn(async () => storedDraft),
    update: vi.fn(async () => storedDraft),
    discard: vi.fn(async () => {}),
    createWorkCopy: vi.fn(async () => storedDraft),
    publish: vi.fn(async () => ({ artifact, version })),
    getPublishedVersion: vi.fn(async () => ({ artifact, version })),
    listPublishedVersions: vi.fn(async () => ({ artifact, versions: [version] })),
    ...overrides,
  };
  const authenticator: Authenticator = {
    authenticate: async (headers) => {
      if (headers.get("authorization") === "Bearer owner-token") return { userId: "owner-id" };
      if (headers.get("authorization") === "Bearer other-token") return { userId: "other-id" };
      if (headers.has("authorization")) return { userId: "owner-id" };
      return null;
    },
  };
  const app = createHttpApp({ drafts, listArtifacts: { execute: async () => ({ items: [], nextCursor: null }) }, authenticator });
  return { app, drafts };
}

describe("Draft and published-version HTTP routes", () => {
  it("requires authentication and returns owner-scoped Draft summaries without content", async () => {
    const { app, drafts } = makeApp();
    const anonymous = await app.request("/api/v1/drafts");
    expect(anonymous.status).toBe(401);

    const response = await app.request("/api/v1/drafts", { headers: { authorization: "******" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      id: "draft-id",
      artifactId: null,
      baseVersionId: null,
      name: "Pearl",
      slug: "pearl",
      visibility: "public",
      state: "active",
      revision: 1,
      createdAt: date.toISOString(),
      updatedAt: date.toISOString(),
    }]);
    expect(drafts.list).toHaveBeenCalledWith({ actorId: "owner-id" });
  });

  it("creates an owner-bound Draft and publishes it through one request", async () => {
    const { app, drafts } = makeApp();
    const created = await app.request("/api/v1/drafts", {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ name: "Pearl", slug: "pearl", visibility: "public", content: pearlContent }),
    });
    expect(created.status).toBe(201);
    expect(drafts.create).toHaveBeenCalledWith({ actorId: "owner-id", name: "Pearl", slug: "pearl", visibility: "public", content: pearlContent });

    const published = await app.request("/api/v1/drafts/draft-id/publish", {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ revision: 1 }),
    });
    expect(published.status).toBe(201);
    expect(await published.json()).toMatchObject({
      artifact: { id: "artifact-id", name: "Pearl" },
      version: { id: "version-id", version: "0.1.0", content: { instructions: "Do work" } },
    });
    expect(drafts.publish).toHaveBeenCalledWith({ actorId: "owner-id", draftId: "draft-id", revision: 1 });
  });

  it("requires authentication and denies cross-owner Draft reads", async () => {
    const { app } = makeApp({
      get: async ({ actorId }) => {
        if (actorId !== "owner-id") throw new DomainError("FORBIDDEN", "Actor cannot access this Draft.");
        return storedDraft;
      },
    });
    const anonymous = await app.request("/api/v1/drafts/draft-id");
    const otherOwner = await app.request("/api/v1/drafts/draft-id", { headers: { authorization: "Bearer other-token" } });
    expect(anonymous.status).toBe(401);
    expect(otherOwner.status).toBe(403);
  });

  it("serves the complete immutable version and creates work-copy from the selected version", async () => {
    const { app, drafts } = makeApp();
    const read = await app.request("/api/v1/artifacts/artifact-id/versions/0.1.0");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ version: { contentHash: "sha256:abc", content: { knowledgeFiles: [{ path: "guide.md", contentHash: "sha256:file" }] } } });

    const copied = await app.request("/api/v1/artifacts/artifact-id/versions/0.1.0/work-copy", {
      method: "POST",
      headers: { authorization: "Bearer owner-token" },
    });
    expect(copied.status).toBe(201);
    expect(drafts.createWorkCopy).toHaveBeenCalledWith({ actorId: "owner-id", artifactId: "artifact-id", version: "0.1.0" });
  });

  it("rejects owner fields and invalid content before calling the application service", async () => {
    const { app, drafts } = makeApp();
    const response = await app.request("/api/v1/drafts", {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ name: "Pearl", slug: "pearl", visibility: "private", ownerId: "attacker", content: pearlContent }),
    });
    expect(response.status).toBe(400);
    expect(drafts.create).not.toHaveBeenCalled();
  });
});
