import { DomainError } from "./errors.js";

export type ArtifactVisibility = "private" | "unlisted" | "public";
export type ArtifactStatus = "active" | "tombstone";

export interface ArtifactSnapshot {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  visibility: ArtifactVisibility;
  status: ArtifactStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateArtifactInput {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  visibility: ArtifactVisibility;
  createdAt: Date;
}

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class Artifact {
  private constructor(private readonly state: ArtifactSnapshot) {}

  static create(input: CreateArtifactInput): Artifact {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 200) {
      throw new DomainError("INVALID_REQUEST", "Artifact name must contain 1 to 200 characters.", { field: "name" });
    }
    if (!slugPattern.test(input.slug)) {
      throw new DomainError("INVALID_REQUEST", "Artifact slug must contain lowercase letters, numbers, and single hyphens.", { field: "slug" });
    }
    if (!input.id || !input.ownerId || Number.isNaN(input.createdAt.getTime())) {
      throw new DomainError("INVALID_REQUEST", "Artifact identity and creation time are required.");
    }

    return new Artifact({
      ...input,
      name,
      status: "active",
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
    });
  }

  static reconstitute(snapshot: ArtifactSnapshot): Artifact {
    return new Artifact({ ...snapshot, createdAt: new Date(snapshot.createdAt), updatedAt: new Date(snapshot.updatedAt) });
  }

  get id(): string { return this.state.id; }
  get ownerId(): string { return this.state.ownerId; }
  get name(): string { return this.state.name; }
  get slug(): string { return this.state.slug; }
  get visibility(): ArtifactVisibility { return this.state.visibility; }
  get status(): ArtifactStatus { return this.state.status; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  get updatedAt(): Date { return new Date(this.state.updatedAt); }

  rename(_name: string): never {
    throw new DomainError("ARTIFACT_NAME_IMMUTABLE", "Artifact name cannot be changed.");
  }

  changeSlug(_slug: string): never {
    throw new DomainError("ARTIFACT_SLUG_IMMUTABLE", "Artifact slug cannot be changed.");
  }

  changeOwner(_ownerId: string): never {
    throw new DomainError("ARTIFACT_OWNER_IMMUTABLE", "Artifact owner cannot be changed.");
  }

  changeVisibility(visibility: ArtifactVisibility, at: Date): Artifact {
    if (this.state.status === "tombstone") {
      throw new DomainError("INVALID_REQUEST", "A tombstoned Artifact cannot be changed.");
    }
    return new Artifact({ ...this.state, visibility, updatedAt: new Date(at) });
  }

  tombstone(at: Date): Artifact {
    return new Artifact({ ...this.state, status: "tombstone", visibility: "unlisted", updatedAt: new Date(at) });
  }

  snapshot(): ArtifactSnapshot {
    return { ...this.state, createdAt: this.createdAt, updatedAt: this.updatedAt };
  }
}