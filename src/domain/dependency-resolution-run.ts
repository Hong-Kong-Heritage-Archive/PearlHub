import { DomainError } from "./errors.js";

export interface CreateDependencyResolutionRunInput {
  id: string;
  sourceArtifactVersionId: string;
  createdAt: Date;
  initiatorUserId?: string | null;
  manifestVersion?: number | null;
  resolverPolicyVersion?: string | null;
  manifestHash?: string | null;
}

export interface DependencyResolutionRunSnapshot {
  id: string;
  sourceArtifactVersionId: string;
  createdAt: Date;
  initiatorUserId: string | null;
  manifestVersion: number | null;
  resolverPolicyVersion: string | null;
  manifestHash: string | null;
}

export class DependencyResolutionRun {
  private constructor(private readonly state: DependencyResolutionRunSnapshot) {}

  static create(input: CreateDependencyResolutionRunInput): DependencyResolutionRun {
    if (!input.id || !input.sourceArtifactVersionId || Number.isNaN(input.createdAt.getTime())) {
      throw new DomainError("INVALID_REQUEST", "Resolution run identity, source version, and creation time are required.");
    }
    const metadata = [
      input.initiatorUserId ?? null,
      input.manifestVersion ?? null,
      input.resolverPolicyVersion ?? null,
      input.manifestHash ?? null,
    ];
    const hasMetadata = metadata.some((value) => value !== null);
    if (hasMetadata && (
      typeof input.initiatorUserId !== "string" || input.initiatorUserId.length === 0
      || !Number.isInteger(input.manifestVersion) || (input.manifestVersion ?? 0) <= 0
      || typeof input.resolverPolicyVersion !== "string" || input.resolverPolicyVersion.trim().length === 0
      || typeof input.manifestHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(input.manifestHash)
    )) {
      throw new DomainError("INVALID_REQUEST", "Resolution run manifest metadata must be complete and valid.");
    }
    return new DependencyResolutionRun({
      id: input.id,
      sourceArtifactVersionId: input.sourceArtifactVersionId,
      createdAt: new Date(input.createdAt),
      initiatorUserId: input.initiatorUserId ?? null,
      manifestVersion: input.manifestVersion ?? null,
      resolverPolicyVersion: input.resolverPolicyVersion ?? null,
      manifestHash: input.manifestHash ?? null,
    });
  }

  get id(): string { return this.state.id; }
  get sourceArtifactVersionId(): string { return this.state.sourceArtifactVersionId; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  get initiatorUserId(): string | null { return this.state.initiatorUserId; }
  get manifestVersion(): number | null { return this.state.manifestVersion; }
  get resolverPolicyVersion(): string | null { return this.state.resolverPolicyVersion; }
  get manifestHash(): string | null { return this.state.manifestHash; }

  snapshot(): DependencyResolutionRunSnapshot {
    return { ...this.state, createdAt: this.createdAt };
  }
}
