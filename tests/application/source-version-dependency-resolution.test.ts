import { describe, expect, it } from "vitest";
import { Artifact, type ArtifactStatus, type ArtifactVisibility } from "../../src/domain/artifact.js";
import { ArtifactVersion } from "../../src/domain/artifact-version.js";
import { Dependency } from "../../src/domain/dependency.js";
import type { DependencyResolution } from "../../src/domain/records.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  canonicalResolutionManifest,
  hashResolutionManifest,
  ResolveSourceVersionDependenciesService,
  type ResolutionManifest,
} from "../../src/application/source-version-dependency-resolution.js";
import type { AccessPolicy } from "../../src/application/services.js";
import type {
  ArtifactRepository,
  ArtifactVersionRepository,
  Clock,
  DependencyRepository,
  DependencyResolutionRunRepository,
  IdGenerator,
  ResolutionSourceVersionLock,
  TransactionManager,
} from "../../src/ports/repositories.js";

const fixedTime = new Date("2026-11-04T12:00:00.000Z");
const actorId = "owner-source";

function makeArtifact(
  id: string,
  ownerId: string,
  visibility: ArtifactVisibility = "public",
  status: ArtifactStatus = "active",
): Artifact {
  const artifact = Artifact.create({
    id,
    ownerId,
    name: `Artifact ${id}`,
    slug: id,
    visibility,
    createdAt: fixedTime,
  });
  return status === "active"
    ? artifact
    : Artifact.reconstitute({ ...artifact.snapshot(), status, visibility: "unlisted" });
}

function makeVersion(id: string, artifactId: string, version: string, contentHash = `hash-${id}`): ArtifactVersion {
  return ArtifactVersion.create({
    id,
    artifactId,
    version,
    contentHash,
    contentLocation: `content/${id}`,
    createdAt: fixedTime,
    publishedAt: fixedTime,
  });
}

function makeDependency(id: string, sourceVersionId: string, targetArtifactId: string, declaredRange: string): Dependency {
  return Dependency.create({ id, artifactVersionId: sourceVersionId, targetArtifactId, declaredRange, createdAt: fixedTime });
}

interface FixtureOptions {
  sourceVisibility?: ArtifactVisibility;
  sourceStatus?: ArtifactStatus;
  sourceOwnerId?: string;
  actorId?: string;
  declarations?: Dependency[];
  artifacts?: Artifact[];
  versions?: ArtifactVersion[];
  access?: AccessPolicy;
}

function makeFixture(options: FixtureOptions = {}) {
  const currentActorId = options.actorId ?? actorId;
  const sourceArtifact = makeArtifact("source-artifact", options.sourceOwnerId ?? actorId, options.sourceVisibility, options.sourceStatus);
  const sourceVersion = makeVersion("source-version", sourceArtifact.id, "1.0.0");
  const artifacts = new Map<string, Artifact>([[sourceArtifact.id, sourceArtifact]]);
  for (const artifact of options.artifacts ?? []) artifacts.set(artifact.id, artifact);
  const versions = new Map<string, ArtifactVersion>([[sourceVersion.id, sourceVersion]]);
  const versionsByArtifact = new Map<string, ArtifactVersion[]>();
  const addVersion = (version: ArtifactVersion) => {
    versions.set(version.id, version);
    const candidates = versionsByArtifact.get(version.artifactId) ?? [];
    candidates.push(version);
    versionsByArtifact.set(version.artifactId, candidates);
  };
  for (const version of options.versions ?? []) addVersion(version);

  const declarations = options.declarations ?? [];
  const events: string[] = [];
  const runRows: import("../../src/domain/dependency-resolution-run.js").DependencyResolutionRun[] = [];
  const resolutionRows: DependencyResolution[] = [];
  let inTransaction = false;
  let transactionCount = 0;
  const assertTransaction = () => {
    if (!inTransaction) throw new Error("Repository operation ran outside the transaction.");
  };
  const transactionManager: TransactionManager = {
    run: async (work) => {
      if (inTransaction) throw new Error("Unexpected nested transaction.");
      transactionCount += 1;
      inTransaction = true;
      events.push("transaction");
      try {
        return await work();
      } finally {
        inTransaction = false;
      }
    },
  };
  const lock: ResolutionSourceVersionLock = {
    lockSourceVersionForResolution: async (id) => {
      assertTransaction();
      events.push("lock");
      return id === sourceVersion.id;
    },
  };
  const artifactRepository: ArtifactRepository = {
    findById: async (id) => {
      assertTransaction();
      events.push(`artifact:${id}`);
      return artifacts.get(id) ?? null;
    },
    findByIds: async (ids) => ids.flatMap((id) => artifacts.has(id) ? [artifacts.get(id)!] : []),
    findTombstoneSnapshotArtifact: async () => null,
    findByOwnerAndSlug: async () => null,
    create: async () => {},
    save: async () => {},
    tombstone: async () => {},
    restore: async () => null,
  };
  const versionRepository: ArtifactVersionRepository = {
    findById: async (id) => {
      assertTransaction();
      events.push("source-version");
      return versions.get(id) ?? null;
    },
    findByArtifactAndVersion: async () => null,
    findForArtifact: async (id) => {
      assertTransaction();
      events.push(`candidates:${id}`);
      return versionsByArtifact.get(id) ?? [];
    },
    findLatest: async () => null,
    lockArtifactForWrite: async () => false,
    create: async () => {},
  };
  const dependencyRepository: DependencyRepository & DependencyResolutionRunRepository = {
    findForVersion: async (id) => {
      assertTransaction();
      events.push("declarations");
      return id === sourceVersion.id ? declarations : [];
    },
    create: async () => {},
    createResolution: async () => {},
    createResolutionForRun: async (runId, resolution) => {
      assertTransaction();
      events.push("item");
      resolutionRows.push({ ...resolution, runId });
    },
    findResolutions: async () => [],
    createRun: async (run) => {
      assertTransaction();
      events.push("run");
      runRows.push(run);
    },
    findRunById: async () => null,
    findRunsForVersion: async () => [],
    findResolutionsForRun: async () => [],
  };
  let id = 0;
  const ids: IdGenerator = { next: () => `generated-${++id}` };
  const clock: Clock = { now: () => new Date(fixedTime) };
  const access: AccessPolicy = options.access ?? {
    canRead: async (actor, artifact) => actor === artifact.ownerId || artifact.visibility === "public",
    canWrite: async (actor, artifact) => actor === artifact.ownerId,
  };
  const service = new ResolveSourceVersionDependenciesService(
    artifactRepository,
    versionRepository,
    lock,
    dependencyRepository,
    dependencyRepository,
    access,
    transactionManager,
    ids,
    clock,
  );
  return {
    service,
    sourceArtifact,
    sourceVersion,
    artifacts,
    versions,
    versionsByArtifact,
    declarations,
    events,
    runRows,
    resolutionRows,
    transactionCount: () => transactionCount,
    addVersion,
    actorId: currentActorId,
  };
}

describe("source-version dependency resolution", () => {
  it("locks before reading declarations and persists a complete deterministic run", async () => {
    const targetA = makeArtifact("target-a", "owner-a");
    const targetB = makeArtifact("target-b", "owner-b");
    const dependencyA = makeDependency("dep-a", "source-version", targetA.id, "^1.0.0");
    const dependencyB = makeDependency("dep-b", "source-version", targetB.id, "^2.0.0");
    const fixture = makeFixture({
      sourceVisibility: "private",
      artifacts: [targetA, targetB],
      declarations: [dependencyB, dependencyA],
      versions: [
        makeVersion("a-build-2", targetA.id, "1.5.0+build.2"),
        makeVersion("a-build-1", targetA.id, "1.5.0+build.1"),
        makeVersion("a-lower", targetA.id, "1.2.0"),
        makeVersion("b-high", targetB.id, "3.0.0"),
        makeVersion("b-match", targetB.id, "2.1.0"),
      ],
    });

    const result = await fixture.service.execute({
      sourceArtifactVersionId: fixture.sourceVersion.id,
      actorId: fixture.actorId,
    });

    expect(fixture.events.indexOf("lock")).toBeLessThan(fixture.events.indexOf("declarations"));
    expect(fixture.transactionCount()).toBe(1);
    expect(result.dependencies.map(({ dependencyId, resolvedVersion }) => [dependencyId, resolvedVersion])).toEqual([
      ["dep-a", "1.5.0+build.1"],
      ["dep-b", "2.1.0"],
    ]);
    expect(fixture.runRows).toHaveLength(1);
    expect(fixture.runRows[0]?.snapshot()).toMatchObject({
      initiatorUserId: fixture.actorId,
      manifestVersion: 1,
      resolverPolicyVersion: "semver-highest-v1",
      manifestHash: result.manifestHash,
    });
    expect(fixture.resolutionRows).toHaveLength(2);
    expect(fixture.resolutionRows.every((item) => item.runId === result.runId)).toBe(true);
    expect(result.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("creates an immutable valid run and deterministic manifest for an empty source", async () => {
    const fixture = makeFixture();
    const result = await fixture.service.execute({
      sourceArtifactVersionId: fixture.sourceVersion.id,
      actorId: fixture.actorId,
    });

    expect(result.dependencies).toEqual([]);
    expect(fixture.runRows).toHaveLength(1);
    expect(fixture.resolutionRows).toEqual([]);
    expect(result.manifestHash).toBe(hashResolutionManifest({
      manifestVersion: 1,
      resolverPolicyVersion: "semver-highest-v1",
      sourceArtifactVersionId: fixture.sourceVersion.id,
      dependencies: [],
    }));
    expect(canonicalResolutionManifest({
      manifestVersion: 1,
      resolverPolicyVersion: "semver-highest-v1",
      sourceArtifactVersionId: "source-version",
      dependencies: [],
    })).toBe('{"manifestVersion":1,"resolverPolicyVersion":"semver-highest-v1","sourceArtifactVersionId":"source-version","dependencies":[]}');
    expect(hashResolutionManifest({
      manifestVersion: 1,
      resolverPolicyVersion: "semver-highest-v1",
      sourceArtifactVersionId: "source-version",
      dependencies: [],
    })).toBe("sha256:312607b0f331f6687e9ad077ee5569ad4a20ad1279871eef2d0e19b09915ee3e");
  });

  it("does not create partial history when a later declaration cannot be resolved", async () => {
    const target = makeArtifact("target-good", "owner-good");
    const good = makeDependency("dep-a", "source-version", target.id, "^1.0.0");
    const missingVersion = makeDependency("dep-b", "source-version", "target-without-versions", "^1.0.0");
    const fixture = makeFixture({
      sourceVisibility: "private",
      artifacts: [target, makeArtifact("target-without-versions", "owner-other")],
      declarations: [good, missingVersion],
      versions: [makeVersion("target-good-v1", target.id, "1.0.0")],
    });

    await expect(fixture.service.execute({
      sourceArtifactVersionId: fixture.sourceVersion.id,
      actorId: fixture.actorId,
    })).rejects.toMatchObject({ code: "DEPENDENCY_RESOLUTION_FAILED" });
    expect(fixture.runRows).toEqual([]);
    expect(fixture.resolutionRows).toEqual([]);
  });

  it("uses the same external target failure for missing, private, and tombstoned targets", async () => {
    const missingFixture = makeFixture({
      sourceVisibility: "private",
      declarations: [makeDependency("dep", "source-version", "missing-target", "^1.0.0")],
    });
    const privateTarget = makeArtifact("private-target", "other-owner", "private");
    const privateFixture = makeFixture({
      sourceVisibility: "private",
      artifacts: [privateTarget],
      declarations: [makeDependency("dep", "source-version", privateTarget.id, "^1.0.0")],
      versions: [makeVersion("private-v1", privateTarget.id, "1.0.0")],
    });
    const tombstone = makeArtifact("tombstoned-target", "owner-target", "unlisted", "tombstone");
    const tombstoneFixture = makeFixture({
      sourceVisibility: "private",
      artifacts: [tombstone],
      declarations: [makeDependency("dep", "source-version", tombstone.id, "^1.0.0")],
      versions: [makeVersion("tombstone-v1", tombstone.id, "1.0.0")],
    });
    const input = (fixture: ReturnType<typeof makeFixture>) => ({
      sourceArtifactVersionId: fixture.sourceVersion.id,
      actorId: fixture.actorId,
    });

    const missing = await missingFixture.service.execute(input(missingFixture)).catch((error: unknown) => error);
    const privateError = await privateFixture.service.execute(input(privateFixture)).catch((error: unknown) => error);
    const tombstoneError = await tombstoneFixture.service.execute(input(tombstoneFixture)).catch((error: unknown) => error);
    expect(missing).toMatchObject({ code: "DEPENDENCY_RESOLUTION_FAILED", message: "A dependency could not be resolved." });
    expect(privateError).toMatchObject({ code: "DEPENDENCY_RESOLUTION_FAILED", message: "A dependency could not be resolved." });
    expect(tombstoneError).toMatchObject({ code: "DEPENDENCY_RESOLUTION_FAILED", message: "A dependency could not be resolved." });
    expect(missing).toBeInstanceOf(DomainError);
  });

  it("enforces source ownership, public-source target visibility, and owner access to unlisted targets", async () => {
    const forbiddenSource = makeFixture({ sourceOwnerId: "source-owner", actorId: "other-actor" });
    await expect(forbiddenSource.service.execute({
      sourceArtifactVersionId: forbiddenSource.sourceVersion.id,
      actorId: forbiddenSource.actorId,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const privateTarget = makeArtifact("own-private", actorId, "private");
    const publicSource = makeFixture({
      sourceVisibility: "public",
      artifacts: [privateTarget],
      declarations: [makeDependency("dep", "source-version", privateTarget.id, "^1.0.0")],
      versions: [makeVersion("own-private-v1", privateTarget.id, "1.0.0")],
    });
    await expect(publicSource.service.execute({
      sourceArtifactVersionId: publicSource.sourceVersion.id,
      actorId: publicSource.actorId,
    })).rejects.toMatchObject({ code: "DEPENDENCY_RESOLUTION_FAILED" });

    const unlistedTarget = makeArtifact("own-unlisted", actorId, "unlisted");
    const privateSource = makeFixture({
      sourceVisibility: "private",
      artifacts: [unlistedTarget],
      declarations: [makeDependency("dep", "source-version", unlistedTarget.id, "^1.0.0")],
      versions: [makeVersion("own-unlisted-v1", unlistedTarget.id, "1.0.0")],
    });
    await expect(privateSource.service.execute({
      sourceArtifactVersionId: privateSource.sourceVersion.id,
      actorId: privateSource.actorId,
    })).resolves.toMatchObject({ dependencies: [{ resolvedVersion: "1.0.0" }] });
  });

  it("rejects tombstoned sources and unauthenticated callers before creating a run", async () => {
    const tombstone = makeFixture({ sourceStatus: "tombstone" });
    await expect(tombstone.service.execute({
      sourceArtifactVersionId: tombstone.sourceVersion.id,
      actorId: tombstone.actorId,
    })).rejects.toMatchObject({ code: "ARTIFACT_GONE" });
    const anonymous = makeFixture();
    await expect(anonymous.service.execute({
      sourceArtifactVersionId: anonymous.sourceVersion.id,
      actorId: "",
    })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(tombstone.runRows).toEqual([]);
    expect(anonymous.runRows).toEqual([]);
  });

  it("honors existing SemVer prerelease rules", async () => {
    const target = makeArtifact("prerelease-target", "owner-target");
    const stableDependency = makeDependency("stable-dep", "source-version", target.id, "^1.0.0");
    const stableFixture = makeFixture({
      sourceVisibility: "private",
      artifacts: [target],
      declarations: [stableDependency],
      versions: [
        makeVersion("beta", target.id, "1.2.0-beta.2"),
        makeVersion("stable", target.id, "1.1.9"),
      ],
    });
    const stable = await stableFixture.service.execute({
      sourceArtifactVersionId: stableFixture.sourceVersion.id,
      actorId: stableFixture.actorId,
    });
    expect(stable.dependencies[0]?.resolvedVersion).toBe("1.1.9");

    const prereleaseFixture = makeFixture({
      sourceVisibility: "private",
      artifacts: [target],
      declarations: [makeDependency("prerelease-dep", "source-version", target.id, ">=1.2.0-beta.1 <1.2.0")],
      versions: [
        makeVersion("beta-one", target.id, "1.2.0-beta.1"),
        makeVersion("beta-two", target.id, "1.2.0-beta.2"),
      ],
    });
    const prerelease = await prereleaseFixture.service.execute({
      sourceArtifactVersionId: prereleaseFixture.sourceVersion.id,
      actorId: prereleaseFixture.actorId,
    });
    expect(prerelease.dependencies[0]?.resolvedVersion).toBe("1.2.0-beta.2");
  });

  it("creates a fresh run for every explicit execution, even when the manifest hash matches", async () => {
    const fixture = makeFixture();
    const input = { sourceArtifactVersionId: fixture.sourceVersion.id, actorId: fixture.actorId };
    const first = await fixture.service.execute(input);
    const second = await fixture.service.execute(input);
    expect(second.manifestHash).toBe(first.manifestHash);
    expect(second.runId).not.toBe(first.runId);
    expect(fixture.runRows).toHaveLength(2);
  });

  it("canonicalizes dependency order and hashes stable UTF-8 bytes", () => {
    const entryA = {
      dependencyId: "a",
      targetArtifactId: "target-a",
      declaredRange: "^1.0.0",
      resolvedArtifactVersionId: "version-a",
      resolvedVersion: "1.2.0",
      resolvedContentHash: "sha256:a",
    };
    const entryB = {
      dependencyId: "b",
      targetArtifactId: "target-b",
      declaredRange: "^2.0.0",
      resolvedArtifactVersionId: "version-b",
      resolvedVersion: "2.1.0",
      resolvedContentHash: "sha256:b",
    };
    const manifest: ResolutionManifest = {
      manifestVersion: 1,
      resolverPolicyVersion: "semver-highest-v1",
      sourceArtifactVersionId: "source-version",
      dependencies: [entryB, entryA],
    };
    const reordered = { ...manifest, dependencies: [entryA, entryB] };
    expect(canonicalResolutionManifest(manifest)).toBe(canonicalResolutionManifest(reordered));
    expect(hashResolutionManifest(manifest)).toBe(hashResolutionManifest(reordered));
    expect(canonicalResolutionManifest(manifest)).toBe(
      '{"manifestVersion":1,"resolverPolicyVersion":"semver-highest-v1","sourceArtifactVersionId":"source-version","dependencies":[{"dependencyId":"a","targetArtifactId":"target-a","declaredRange":"^1.0.0","resolvedArtifactVersionId":"version-a","resolvedVersion":"1.2.0","resolvedContentHash":"sha256:a"},{"dependencyId":"b","targetArtifactId":"target-b","declaredRange":"^2.0.0","resolvedArtifactVersionId":"version-b","resolvedVersion":"2.1.0","resolvedContentHash":"sha256:b"}]}',
    );
    expect(hashResolutionManifest(manifest))
      .toBe("sha256:fba93960e4cb3abf4a93b8d81600d09b289774d2686afcd08452e2851ecf5027");
    expect(hashResolutionManifest({ ...manifest, sourceArtifactVersionId: "other-source" })).not.toBe(hashResolutionManifest(manifest));
    expect(hashResolutionManifest({ ...manifest, dependencies: [{ ...entryA, resolvedVersion: "1.3.0" }, entryB] }))
      .not.toBe(hashResolutionManifest(manifest));
    expect(hashResolutionManifest({ ...manifest, dependencies: [{ ...entryA, resolvedArtifactVersionId: "other-version" }, entryB] }))
      .not.toBe(hashResolutionManifest(manifest));
    expect(hashResolutionManifest({ ...manifest, dependencies: [{ ...entryA, resolvedContentHash: "sha256:changed" }, entryB] }))
      .not.toBe(hashResolutionManifest(manifest));
    expect(hashResolutionManifest({ ...manifest, dependencies: [{ ...entryA, declaredRange: "^1.1.0" }, entryB] }))
      .not.toBe(hashResolutionManifest(manifest));
  });
});
