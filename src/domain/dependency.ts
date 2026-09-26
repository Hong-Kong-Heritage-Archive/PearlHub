import { satisfiesSemVer, validateSemVerRange } from "./semver.js";

export interface CreateDependencyInput {
  id: string;
  artifactVersionId: string;
  targetArtifactId: string;
  declaredRange: string;
  createdAt: Date;
}

export class Dependency {
  private constructor(private readonly state: CreateDependencyInput) {}

  static create(input: CreateDependencyInput): Dependency {
    validateSemVerRange(input.declaredRange);
    return new Dependency({ ...input, createdAt: new Date(input.createdAt) });
  }

  get id(): string { return this.state.id; }
  get artifactVersionId(): string { return this.state.artifactVersionId; }
  get targetArtifactId(): string { return this.state.targetArtifactId; }
  get declaredRange(): string { return this.state.declaredRange; }
  get createdAt(): Date { return new Date(this.state.createdAt); }

  accepts(version: string): boolean {
    return satisfiesSemVer(version, this.state.declaredRange);
  }

  snapshot(): CreateDependencyInput {
    return { ...this.state, createdAt: this.createdAt };
  }
}