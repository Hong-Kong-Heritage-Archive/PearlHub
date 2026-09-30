import { describe, expect, it } from "vitest";
import { Artifact } from "../../src/domain/artifact.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import { Dependency } from "../../src/domain/dependency.js";
import { DomainError } from "../../src/domain/errors.js";
import { parsePearlContent } from "../../src/domain/pearl.js";

describe("Artifact", () => {
  it("keeps identity immutable and tombstones without discarding its snapshot", () => {
    const artifact = Artifact.create({
      id: "artifact-1",
      ownerId: "owner-1",
      name: "Example Pearl",
      slug: "example-pearl",
      visibility: "public",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(() => artifact.rename("Changed")).toThrowError(DomainError);
    const deleted = artifact.tombstone(new Date("2026-02-01T00:00:00Z"));
    expect(deleted.status).toBe("tombstone");
    expect(deleted.visibility).toBe("unlisted");
    expect(deleted.snapshot()).toMatchObject({
      id: "artifact-1",
      ownerId: "owner-1",
      name: "Example Pearl",
      slug: "example-pearl",
    });
  });

  it("rejects invalid names and slugs", () => {
    const base = {
      id: "artifact-1",
      ownerId: "owner-1",
      visibility: "private" as const,
      createdAt: new Date(),
    };

    expect(() => Artifact.create({ ...base, name: "  ", slug: "valid-slug" })).toThrowError(DomainError);
    expect(() => Artifact.create({ ...base, name: "Name", slug: "Not A Slug" })).toThrowError(DomainError);
  });
});

describe("SemVer domain values", () => {
  it("accepts SemVer 2 versions and rejects aliases or date identities", () => {
    expect(ArtifactVersion.create({
      id: "version-1",
      artifactId: "artifact-1",
      version: "2.4.3",
      contentHash: "sha256:abc",
      contentLocation: "content/abc",
      createdAt: new Date(),
      publishedAt: new Date(),
    }).version).toBe("2.4.3");

    expect(ArtifactVersion.create({
      id: "version-build-metadata",
      artifactId: "artifact-1",
      version: "2.4.3-rc.1+build.7",
      contentHash: "sha256:abc",
      contentLocation: "content/abc",
      createdAt: new Date(),
      publishedAt: new Date(),
    }).version).toBe("2.4.3-rc.1+build.7");

    for (const version of ["v1", "latest", "2026-09-24"]) {
      expect(() => ArtifactVersion.create({
        id: "version-1",
        artifactId: "artifact-1",
        version,
        contentHash: "sha256:abc",
        contentLocation: "content/abc",
        createdAt: new Date(),
        publishedAt: new Date(),
      })).toThrowError(DomainError);
    }
  });

  it("validates dependency ranges and recognizes compatible versions", () => {
    const dependency = Dependency.create({
      id: "dependency-1",
      artifactVersionId: "source-version",
      targetArtifactId: "target-artifact",
      declaredRange: "^2.1.0",
      createdAt: new Date(),
    });

    expect(dependency.accepts("2.4.3")).toBe(true);
    expect(dependency.accepts("3.0.0")).toBe(false);
    expect(() => Dependency.create({
      id: "dependency-2",
      artifactVersionId: "source-version",
      targetArtifactId: "target-artifact",
      declaredRange: "not-a-range",
      createdAt: new Date(),
    })).toThrowError(DomainError);
  });
});

describe("Pearl content", () => {
  it("validates the canonical structure and JSON-compatible content", () => {
    expect(parsePearlContent({ version: "2.4.3", skill: {}, knowledge: [] })).toMatchObject({ version: "2.4.3", skill: {}, knowledge: [] });
    expect(() => parsePearlContent({ version: "2.4.3", skill: [], knowledge: [] })).toThrowError(DomainError);
    expect(() => parsePearlContent({ version: "2.4.3", skill: {}, knowledge: {} })).toThrowError(DomainError);
    expect(() => parsePearlContent({ version: "2.4.3", skill: {}, knowledge: [], extra: undefined })).toThrowError(DomainError);
  });

  it("rejects missing Skill or Knowledge and invalid version metadata", () => {
    expect(() => parsePearlContent({ version: "2.4.3", knowledge: [] })).toThrowError(DomainError);
    expect(() => parsePearlContent({ version: "2.4.3", skill: {} })).toThrowError(DomainError);
    expect(() => parsePearlContent({ version: 2, skill: {}, knowledge: [] })).toThrowError(DomainError);
    expect(() => parsePearlContent({ version: "v2", skill: {}, knowledge: [] })).toThrowError(expect.objectContaining({ code: "INVALID_SEMVER" }));
  });
});