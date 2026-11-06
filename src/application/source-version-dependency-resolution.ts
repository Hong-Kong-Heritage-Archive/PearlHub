import { createHash, randomUUID } from "node:crypto";
import * as semver from "semver";
import { Artifact } from "../domain/artifact.js";
import { ArtifactVersion } from "../domain/artifact-version.js";
import { Dependency } from "../domain/dependency.js";
import { DependencyResolutionRun } from "../domain/dependency-resolution-run.js";
import { DomainError } from "../domain/errors.js";
import type {
  ArtifactRepository,
  ArtifactVersionRepository,
  Clock,
  DependencyTargetDiscovery,
  DependencyRepository,
  DependencyResolutionRunRepository,
  IdGenerator,
  ResolutionArtifactLockRepository,
  ResolutionSourceVersionLock,
  TransactionManager,
} from "../ports/repositories.js";
import type { AccessPolicy } from "./services.js";

export const RESOLUTION_MANIFEST_VERSION = 1;
export const RESOLUTION_POLICY_VERSION = "semver-highest-v1";

export interface ResolutionManifestDependency {
  dependencyId: string;
  targetArtifactId: string;
  declaredRange: string;
  resolvedArtifactVersionId: string;
  resolvedVersion: string;
  resolvedContentHash: string;
}

export interface ResolutionManifest {
  manifestVersion: number;
  resolverPolicyVersion: string;
  sourceArtifactVersionId: string;
  dependencies: ResolutionManifestDependency[];
}

export interface ResolvedSourceDependency extends ResolutionManifestDependency {
  id: string;
  runId: string;
  resolvedAt: Date;
}

export interface SourceVersionDependencyResolutionResult {
  runId: string;
  sourceArtifactVersionId: string;
  createdAt: Date;
  initiatorUserId: string;
  manifestVersion: number;
  resolverPolicyVersion: string;
  manifestHash: string;
  dependencies: ResolvedSourceDependency[];
}

export interface SourceVersionDependencyResolution {
  execute(input: { sourceArtifactVersionId: string; actorId: string }): Promise<SourceVersionDependencyResolutionResult>;
}

const systemClock: Clock = { now: () => new Date() };
const uuidGenerator: IdGenerator = { next: () => randomUUID() };

export class ResolveSourceVersionDependenciesService implements SourceVersionDependencyResolution {
  constructor(
    private readonly artifacts: ArtifactRepository,
    private readonly versions: ArtifactVersionRepository,
    private readonly artifactLocks: ResolutionArtifactLockRepository,
    private readonly sourceVersionLock: ResolutionSourceVersionLock,
    private readonly targetDiscovery: DependencyTargetDiscovery,
    private readonly dependencies: DependencyRepository,
    private readonly runs: DependencyResolutionRunRepository,
    private readonly access: AccessPolicy,
    private readonly transactions: TransactionManager,
    private readonly ids: IdGenerator = uuidGenerator,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(input: { sourceArtifactVersionId: string; actorId: string }): Promise<SourceVersionDependencyResolutionResult> {
    if (!input.actorId) throw new DomainError("UNAUTHENTICATED", "An authenticated actor is required.");

    return this.transactions.run(async () => {
      const discoveredSourceVersion = await this.versions.findById(input.sourceArtifactVersionId);
      if (!discoveredSourceVersion) throw new DomainError("VERSION_NOT_FOUND", "Source Artifact Version was not found.");
      const discoveredSourceArtifact = await this.artifacts.findById(discoveredSourceVersion.artifactId);
      if (!discoveredSourceArtifact) throw new DomainError("ARTIFACT_NOT_FOUND", "Source Artifact was not found.");
      await this.authorizeSource(input.actorId, discoveredSourceArtifact);

      const discoveredTargetIds = orderedUniqueIds(
        await this.targetDiscovery.findTargetArtifactIdsForVersion(discoveredSourceVersion.id),
      );
      const lockedArtifactIds = orderedUniqueIds([discoveredSourceArtifact.id, ...discoveredTargetIds]);
      const lockedArtifacts = await this.artifactLocks.lockArtifactsForResolution(lockedArtifactIds);
      const artifactsById = new Map(lockedArtifacts.map((artifact) => [artifact.id, artifact]));
      const sourceArtifact = artifactsById.get(discoveredSourceArtifact.id);
      if (!sourceArtifact) throw new DomainError("ARTIFACT_NOT_FOUND", "Source Artifact was not found.");

      if (!await this.sourceVersionLock.lockSourceVersionForResolution(input.sourceArtifactVersionId)) {
        throw new DomainError("VERSION_NOT_FOUND", "Source Artifact Version was not found.");
      }
      const sourceVersion = await this.versions.findById(input.sourceArtifactVersionId);
      if (!sourceVersion || sourceVersion.artifactId !== discoveredSourceVersion.artifactId) {
        throw new DomainError("VERSION_NOT_FOUND", "Source Artifact Version was not found.");
      }

      const declarations = await this.dependencies.findForVersion(sourceVersion.id);
      const authoritativeTargetIds = orderedUniqueIds(declarations.map((declaration) => declaration.targetArtifactId));
      if (!sameIds(discoveredTargetIds, authoritativeTargetIds)) throw dependencyResolutionFailed();

      await this.authorizeSource(input.actorId, sourceArtifact);
      const selected = await this.resolveDeclarations(sourceArtifact, input.actorId, declarations, artifactsById);
      const manifest: ResolutionManifest = {
        manifestVersion: RESOLUTION_MANIFEST_VERSION,
        resolverPolicyVersion: RESOLUTION_POLICY_VERSION,
        sourceArtifactVersionId: sourceVersion.id,
        dependencies: selected.map((entry) => entry.manifestDependency),
      };
      const manifestHash = hashResolutionManifest(manifest);
      const createdAt = this.clock.now();
      const run = DependencyResolutionRun.create({
        id: this.ids.next(),
        sourceArtifactVersionId: sourceVersion.id,
        createdAt,
        initiatorUserId: input.actorId,
        manifestVersion: RESOLUTION_MANIFEST_VERSION,
        resolverPolicyVersion: RESOLUTION_POLICY_VERSION,
        manifestHash,
      });

      await this.runs.createRun(run);
      const resultDependencies: ResolvedSourceDependency[] = [];
      for (const entry of selected) {
        const resolution = {
          id: this.ids.next(),
          dependencyId: entry.manifestDependency.dependencyId,
          resolvedArtifactVersionId: entry.manifestDependency.resolvedArtifactVersionId,
          resolvedAt: createdAt,
        };
        await this.dependencies.createResolutionForRun(run.id, resolution);
        resultDependencies.push({
          ...entry.manifestDependency,
          id: resolution.id,
          runId: run.id,
          resolvedAt: new Date(createdAt),
        });
      }

      return {
        runId: run.id,
        sourceArtifactVersionId: sourceVersion.id,
        createdAt: run.createdAt,
        initiatorUserId: input.actorId,
        manifestVersion: RESOLUTION_MANIFEST_VERSION,
        resolverPolicyVersion: RESOLUTION_POLICY_VERSION,
        manifestHash,
        dependencies: resultDependencies,
      };
    });
  }

  private async resolveDeclarations(
    sourceArtifact: Artifact,
    actorId: string,
    declarations: Dependency[],
    artifactsById: ReadonlyMap<string, Artifact>,
  ): Promise<Array<{ manifestDependency: ResolutionManifestDependency }>> {
    const ordered = [...declarations].sort((left, right) => compareText(left.id, right.id));
    const selected: Array<{ manifestDependency: ResolutionManifestDependency }> = [];
    for (const dependency of ordered) {
      const target = artifactsById.get(dependency.targetArtifactId);
      if (!target || target.status !== "active" || !await this.access.canRead(actorId, target)
        || (sourceArtifact.visibility === "public" && target.visibility !== "public")) {
        throw dependencyResolutionFailed();
      }

      const version = (await this.versions.findForArtifact(target.id))
        .filter((candidate) => dependency.accepts(candidate.version))
        .sort(compareEligibleVersions)[0];
      if (!version) throw dependencyResolutionFailed();
      selected.push({
        manifestDependency: {
          dependencyId: dependency.id,
          targetArtifactId: target.id,
          declaredRange: dependency.declaredRange,
          resolvedArtifactVersionId: version.id,
          resolvedVersion: version.version,
          resolvedContentHash: version.contentHash,
        },
      });
    }
    return selected;
  }

  private async authorizeSource(actorId: string, sourceArtifact: Artifact): Promise<void> {
    if (sourceArtifact.status !== "active") {
      throw new DomainError("ARTIFACT_GONE", "Source Artifact has been tombstoned.");
    }
    if (sourceArtifact.ownerId !== actorId && !await this.access.canWrite(actorId, sourceArtifact)) {
      throw new DomainError("FORBIDDEN", "Actor cannot resolve dependencies for this source Artifact.");
    }
  }
}

export function canonicalResolutionManifest(manifest: ResolutionManifest): string {
  const dependencies = [...manifest.dependencies]
    .sort((left, right) => compareText(left.dependencyId, right.dependencyId))
    .map((dependency) => ({
      dependencyId: dependency.dependencyId,
      targetArtifactId: dependency.targetArtifactId,
      declaredRange: dependency.declaredRange,
      resolvedArtifactVersionId: dependency.resolvedArtifactVersionId,
      resolvedVersion: dependency.resolvedVersion,
      resolvedContentHash: dependency.resolvedContentHash,
    }));

  return JSON.stringify({
    manifestVersion: manifest.manifestVersion,
    resolverPolicyVersion: manifest.resolverPolicyVersion,
    sourceArtifactVersionId: manifest.sourceArtifactVersionId,
    dependencies,
  });
}

export function hashResolutionManifest(manifest: ResolutionManifest): string {
  const bytes = canonicalResolutionManifest(manifest);
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function compareEligibleVersions(left: ArtifactVersion, right: ArtifactVersion): number {
  return semver.rcompare(left.version, right.version)
    || compareText(left.version, right.version)
    || compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedUniqueIds(ids: string[]): string[] {
  return [...new Set(ids)].sort(compareText);
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function dependencyResolutionFailed(): DomainError {
  return new DomainError("DEPENDENCY_RESOLUTION_FAILED", "A dependency could not be resolved.");
}
