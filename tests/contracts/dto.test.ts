import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { parseCompatibilityReportRequest, parseCopyArtifactRequest, parseCreateArtifactRequest, parseImportGitHubRequest, parsePublishVersionRequest, toApiError } from "../../src/contracts/dto.js";

describe("contract DTOs", () => {
  it("accepts valid artifact request shape and rejects malformed bodies", () => {
    expect(parseCreateArtifactRequest({ name: "Pearl", slug: "pearl", visibility: "public" })).toEqual({ name: "Pearl", slug: "pearl", visibility: "public" });
    expect(() => parseCreateArtifactRequest({ name: "Pearl", slug: "pearl", visibility: "everyone" })).toThrowError(DomainError);
  });

  it("serializes stable API errors", () => {
    expect(toApiError(new DomainError("INVALID_REQUEST", "Bad request.", { field: "name" }))).toEqual({ error: { code: "INVALID_REQUEST", message: "Bad request.", details: { field: "name" } } });
  });

  it("parses request DTOs for publish, copy, import, and compatibility", () => {
    expect(parsePublishVersionRequest({ version: "1.0.0", content: { skill: {}, knowledge: [] }, dependencies: [{ targetArtifactId: "target", declaredRange: "^2.1.0" }] })).toMatchObject({ version: "1.0.0", dependencies: [{ targetArtifactId: "target", declaredRange: "^2.1.0" }] });
    expect(parseCopyArtifactRequest({ name: "Copy", slug: "copy", sourceVersionId: "version-id" })).toEqual({ name: "Copy", slug: "copy", sourceVersionId: "version-id" });
    expect(parseImportGitHubRequest({ sourceUrl: "https://github.com/example/pearl", name: "Import", slug: "import" }).sourceUrl).toContain("github.com");
    expect(parseCompatibilityReportRequest({ artifactVersionId: "version-id", status: "compatible", report: {} })).toEqual({ artifactVersionId: "version-id", status: "compatible", report: {} });
    expect(() => parsePublishVersionRequest({ version: "1.0.0", content: [], dependencies: [{}] })).toThrowError(DomainError);
  });
});