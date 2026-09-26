import { DomainError } from "./errors.js";
import { parseSemVer } from "./semver.js";

export interface CreateArtifactVersionInput {
  id: string;
  artifactId: string;
  version: string;
  contentHash: string;
  contentLocation: string;
  createdAt: Date;
  publishedAt: Date;
}

export class ArtifactVersion {
  private constructor(private readonly state: CreateArtifactVersionInput) {}

  static create(input: CreateArtifactVersionInput): ArtifactVersion {
    parseSemVer(input.version);
    if (!input.id || !input.artifactId || !input.contentHash || !input.contentLocation) {
      throw new DomainError("INVALID_REQUEST", "Version identity and content metadata are required.");
    }
    return new ArtifactVersion({ ...input, createdAt: new Date(input.createdAt), publishedAt: new Date(input.publishedAt) });
  }

  get id(): string { return this.state.id; }
  get artifactId(): string { return this.state.artifactId; }
  get version(): string { return this.state.version; }
  get contentHash(): string { return this.state.contentHash; }
  get contentLocation(): string { return this.state.contentLocation; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  get publishedAt(): Date { return new Date(this.state.publishedAt); }

  modify(): never {
    throw new DomainError("VERSION_IMMUTABLE", "Published Artifact Versions cannot be changed.");
  }

  snapshot(): CreateArtifactVersionInput {
    return { ...this.state, createdAt: this.createdAt, publishedAt: this.publishedAt };
  }
}