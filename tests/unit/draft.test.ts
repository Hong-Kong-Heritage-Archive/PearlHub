import { describe, expect, it } from "vitest";
import { Draft, hashDraftContent } from "../../src/domain/draft.js";
import { DomainError } from "../../src/domain/errors.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const input = {
  id: "draft-1",
  ownerId: "owner-1",
  artifactId: null,
  baseVersionId: null,
  name: "Pearl",
  slug: "pearl",
  visibility: "private" as const,
  content: { instructions: "Do work", knowledgeFiles: [{ path: " docs\\guide.md ", content: "Knowledge" }], dependencies: [{ targetArtifactId: "target", declaredRange: "^2.1.0" }] },
  createdAt: now,
  updatedAt: now,
};

describe("Draft domain", () => {
  it("normalizes knowledge-file paths and rejects duplicate or traversing paths", () => {
    expect(Draft.create(input).content.knowledgeFiles[0]?.path).toBe("docs/guide.md");
    expect(() => Draft.create({ ...input, content: { ...input.content, knowledgeFiles: [{ path: "a/../b", content: "" }] } })).toThrowError(DomainError);
    expect(() => Draft.create({ ...input, content: { ...input.content, knowledgeFiles: [{ path: "Guide.md", content: "" }, { path: " guide.MD ", content: "" }] } })).toThrowError(DomainError);
  });

  it("validates dependency SemVer ranges and keeps revisioned identity immutable", () => {
    const draft = Draft.create(input);
    expect(() => Draft.create({ ...input, content: { ...input.content, dependencies: [{ targetArtifactId: "target", declaredRange: "latest" }] } })).toThrowError(DomainError);
    const updated = draft.update({ ...input, name: " Updated Pearl ", slug: "updated-pearl", revision: 1, at: now });
    expect(updated.name).toBe("Updated Pearl");
    expect(updated.revision).toBe(2);
    expect(() => updated.update({ ...input, revision: 1, at: now })).toThrowError(DomainError);
  });

  it("computes deterministic hashes and includes content, paths, and dependency declarations", () => {
    const content = Draft.create(input).content;
    expect(hashDraftContent(content)).toBe(hashDraftContent({ ...content, knowledgeFiles: [...content.knowledgeFiles].reverse(), dependencies: [...content.dependencies].reverse() }));
    expect(hashDraftContent(content)).not.toBe(hashDraftContent({ ...content, instructions: "Different" }));
    expect(hashDraftContent(content)).not.toBe(hashDraftContent({ ...content, knowledgeFiles: [{ path: "docs/other.md", content: "Knowledge" }] }));
    expect(hashDraftContent(content)).not.toBe(hashDraftContent({ ...content, dependencies: [{ targetArtifactId: "target", declaredRange: "^3.0.0" }] }));
  });
});
