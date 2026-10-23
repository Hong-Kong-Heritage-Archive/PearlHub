import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import { normalizePearlTags } from "./discovery.js";
import { validateSemVerRange } from "./semver.js";
import type { ArtifactVisibility } from "./artifact.js";

export interface KnowledgeFile {
  path: string;
  content: string;
}

export interface DraftDependency {
  targetArtifactId: string;
  declaredRange: string;
}

export interface DraftContent {
  instructions: string;
  knowledgeFiles: KnowledgeFile[];
  dependencies: DraftDependency[];
  tags?: string[] | undefined;
}

export interface ForkOrigin {
  artifactId: string;
  versionId: string;
}

export interface DraftProvenance {
  sourceType: string;
  sourceUrl: string;
  sourceRef: string;
  importedAt: Date;
}

export interface DraftState {
  id: string;
  ownerId: string;
  artifactId: string | null;
  baseVersionId: string | null;
  name: string;
  slug: string;
  visibility: ArtifactVisibility;
  content: DraftContent;
  forkOrigin: ForkOrigin | null;
  provenance: DraftProvenance | null;
  state: "active" | "published" | "discarded";
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Draft {
  private constructor(private readonly value: DraftState) {}

  static create(input: Omit<DraftState, "state" | "revision" | "forkOrigin" | "provenance"> & Partial<Pick<DraftState, "forkOrigin" | "provenance">>): Draft {
    const content = validateDraftContent(input.content);
    validateMetadata(input.name, input.slug, input.visibility);
    if (!input.id || !input.ownerId) throw invalidDraft("Draft identity and owner are required.");
    return new Draft({
      ...input,
      name: input.name.trim(),
      content,
      forkOrigin: input.forkOrigin ?? null,
      provenance: input.provenance === null || input.provenance === undefined
        ? null
        : { ...input.provenance, importedAt: new Date(input.provenance.importedAt) },
      state: "active",
      revision: 1,
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.updatedAt),
    });
  }

  static reconstitute(value: DraftState): Draft {
    const validContent = validateDraftContent(value.content);
    validateMetadata(value.name, value.slug, value.visibility);
    return new Draft({
      ...value,
      content: validContent,
      forkOrigin: value.forkOrigin ? { ...value.forkOrigin } : null,
      provenance: value.provenance ? { ...value.provenance, importedAt: new Date(value.provenance.importedAt) } : null,
      createdAt: new Date(value.createdAt),
      updatedAt: new Date(value.updatedAt),
    });
  }

  get id(): string { return this.value.id; }
  get ownerId(): string { return this.value.ownerId; }
  get artifactId(): string | null { return this.value.artifactId; }
  get baseVersionId(): string | null { return this.value.baseVersionId; }
  get name(): string { return this.value.name; }
  get slug(): string { return this.value.slug; }
  get visibility(): ArtifactVisibility { return this.value.visibility; }
  get content(): DraftContent { return copyContent(this.value.content); }
  get forkOrigin(): ForkOrigin | null { return this.value.forkOrigin ? { ...this.value.forkOrigin } : null; }
  get provenance(): DraftProvenance | null {
    return this.value.provenance ? { ...this.value.provenance, importedAt: new Date(this.value.provenance.importedAt) } : null;
  }
  get state(): DraftState["state"] { return this.value.state; }
  get revision(): number { return this.value.revision; }
  get createdAt(): Date { return new Date(this.value.createdAt); }
  get updatedAt(): Date { return new Date(this.value.updatedAt); }

  update(input: { name: string; slug: string; visibility: ArtifactVisibility; content: DraftContent; revision: number; at: Date }): Draft {
    this.assertEditable(input.revision);
    if (this.artifactId !== null && (input.name.trim() !== this.name || input.slug !== this.slug)) {
      throw new DomainError("INVALID_REQUEST", "Work-copy name and slug are immutable.");
    }
    validateMetadata(input.name, input.slug, input.visibility);
    return new Draft({
      ...this.value,
      name: this.artifactId === null ? input.name.trim() : this.name,
      slug: this.slug,
      visibility: input.visibility,
      content: validateDraftContent(input.content),
      revision: this.revision + 1,
      updatedAt: new Date(input.at),
    });
  }

  consume(revision: number, at: Date): Draft {
    this.assertEditable(revision);
    return new Draft({ ...this.value, state: "published", revision: this.revision + 1, updatedAt: new Date(at) });
  }

  discard(revision: number, at: Date): Draft {
    this.assertEditable(revision);
    return new Draft({ ...this.value, state: "discarded", revision: this.revision + 1, updatedAt: new Date(at) });
  }

  snapshot(): DraftState {
    return {
      ...this.value,
      content: copyContent(this.value.content),
      forkOrigin: this.forkOrigin,
      provenance: this.provenance,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  private assertEditable(revision: number): void {
    if (this.state !== "active") throw new DomainError("DRAFT_NOT_ACTIVE", "Draft is no longer active.");
    if (revision !== this.revision) throw new DomainError("DRAFT_REVISION_CONFLICT", "Draft has changed; reload before saving.", { expectedRevision: this.revision });
  }
}

export function validateDraftContent(value: DraftContent): DraftContent {
  if (!value || typeof value.instructions !== "string" || !Array.isArray(value.knowledgeFiles) || !Array.isArray(value.dependencies)) {
    throw invalidDraft("Draft content requires instructions, knowledge files, and dependencies.");
  }
  const tags = normalizePearlTags(value.tags ?? []);
  const paths = new Set<string>();
  const knowledgeFiles = value.knowledgeFiles.map((file) => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      throw invalidDraft("Knowledge-file paths and contents must be strings.");
    }
    const path = normalizeKnowledgePath(file.path);
    const key = path.toLocaleLowerCase("en-US");
    if (paths.has(key)) throw invalidDraft("Knowledge-file paths must be unique after normalization.", { path });
    paths.add(key);
    return { path, content: file.content };
  });
  const dependencies = value.dependencies.map((dependency) => {
    if (!dependency || typeof dependency.targetArtifactId !== "string" || dependency.targetArtifactId.trim() === "" || typeof dependency.declaredRange !== "string") {
      throw invalidDraft("Each dependency requires a target Artifact ID and SemVer range.");
    }
    validateSemVerRange(dependency.declaredRange);
    return { targetArtifactId: dependency.targetArtifactId, declaredRange: dependency.declaredRange };
  }).sort((left, right) => compareStrings(left.targetArtifactId, right.targetArtifactId) || compareStrings(left.declaredRange, right.declaredRange));
  return { instructions: value.instructions, knowledgeFiles: knowledgeFiles.sort((left, right) => compareStrings(left.path, right.path)), dependencies, tags };
}

export function normalizeKnowledgePath(value: string): string {
  const path = value.trim().replaceAll("\\", "/").replace(/\/+/g, "/");
  if (!path || path.startsWith("/") || /^[a-z]:\//i.test(path) || path.split("/").some((part) => part === "." || part === ".." || part === "")) {
    throw invalidDraft("Knowledge-file paths must be normalized relative paths without traversal segments.", { path: value });
  }
  return path;
}

export function canonicalDraftSnapshot(content: DraftContent): string {
  return canonicalizeJson(validateDraftContent(content));
}

export function hashDraftContent(content: DraftContent): string {
  return `sha256:${createHash("sha256").update(canonicalDraftSnapshot(content), "utf8").digest("hex")}`;
}

export function hashKnowledgeFile(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function canonicalizeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateMetadata(name: string, slug: string, visibility: ArtifactVisibility): void {
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 200) {
    throw invalidDraft("Artifact names must contain 1 to 200 characters.");
  }
  if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw invalidDraft("Artifact slug is invalid.");
  }
  if (!["private", "unlisted", "public"].includes(visibility)) throw invalidDraft("Artifact visibility is invalid.");
}

function copyContent(content: DraftContent): DraftContent {
  return { instructions: content.instructions, knowledgeFiles: content.knowledgeFiles.map((file) => ({ ...file })), dependencies: content.dependencies.map((dependency) => ({ ...dependency })), tags: [...(content.tags ?? [])] };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidDraft(message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError("INVALID_REQUEST", message, details);
}
