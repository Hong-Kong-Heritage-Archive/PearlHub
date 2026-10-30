import { DomainError } from "./errors.js";

export interface CreateDependencyResolutionRunInput {
  id: string;
  sourceArtifactVersionId: string;
  createdAt: Date;
}

export class DependencyResolutionRun {
  private constructor(private readonly state: CreateDependencyResolutionRunInput) {}

  static create(input: CreateDependencyResolutionRunInput): DependencyResolutionRun {
    if (!input.id || !input.sourceArtifactVersionId || Number.isNaN(input.createdAt.getTime())) {
      throw new DomainError("INVALID_REQUEST", "Resolution run identity, source version, and creation time are required.");
    }
    return new DependencyResolutionRun({ ...input, createdAt: new Date(input.createdAt) });
  }

  get id(): string { return this.state.id; }
  get sourceArtifactVersionId(): string { return this.state.sourceArtifactVersionId; }
  get createdAt(): Date { return new Date(this.state.createdAt); }

  snapshot(): CreateDependencyResolutionRunInput {
    return { ...this.state, createdAt: this.createdAt };
  }
}
