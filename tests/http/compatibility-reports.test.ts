import { describe, expect, it, vi } from "vitest";
import type { DraftWorkflowService } from "../../src/application/services.js";
import type { CompatibilityReport } from "../../src/domain/records.js";
import { DomainError } from "../../src/domain/errors.js";
import { createHttpApp } from "../../src/http/app.js";
import { DevelopmentOnlyFakeAuthenticator } from "../../src/http/testing/development-fake-authenticator.js";

const artifactId = "compatibility-artifact";
const version = "1.2.3";
const reports: CompatibilityReport[] = [{
  id: "report-1",
  artifactVersionId: "source-version-id",
  targetArtifactVersionId: null,
  status: "future-compatible-status",
  report: { checks: [{ name: "schema", result: null, details: { compatible: true } }] },
  createdAt: new Date("2026-05-02T00:00:00.000Z"),
}];
const authenticator = new DevelopmentOnlyFakeAuthenticator("report-owner", "owner-token", [
  { userId: "other-user", token: "other-token" },
]);

function makeApp(
  getReports: DraftWorkflowService["getVersionCompatibilityReports"] = async () => reports,
) {
  return createHttpApp({
    listArtifacts: { execute: async () => ({ items: [], nextCursor: null }) },
    authenticator,
    artifactVersionCompatibilityReports: { getVersionCompatibilityReports: getReports },
  });
}

describe("GET /api/v1/artifacts/{artifactId}/versions/{version}/compatibility", () => {
  it("returns persisted reports with nested JSON and null values unchanged", async () => {
    const getReports = vi.fn(async () => reports);
    const app = makeApp(getReports);

    const anonymous = await app.request(`/api/v1/artifacts/${artifactId}/versions/${version}/compatibility`);
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual([{
      id: "report-1",
      artifactVersionId: "source-version-id",
      targetArtifactVersionId: null,
      status: "future-compatible-status",
      report: { checks: [{ name: "schema", result: null, details: { compatible: true } }] },
      createdAt: "2026-05-02T00:00:00.000Z",
    }]);
    expect(getReports).toHaveBeenLastCalledWith({
      actorId: null,
      artifactId,
      version,
    });

    const authenticated = await app.request(`/api/v1/artifacts/${artifactId}/versions/${version}/compatibility`, {
      headers: { authorization: "Bearer owner-token" },
    });
    expect(authenticated.status).toBe(200);
    expect(getReports).toHaveBeenLastCalledWith({
      actorId: "report-owner",
      artifactId,
      version,
    });
  });

  it("returns an empty list when no compatibility reports are stored", async () => {
    const response = await makeApp(async () => []).request(
      `/api/v1/artifacts/${artifactId}/versions/${version}/compatibility`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("maps missing, inaccessible, and tombstoned resources through standard errors", async () => {
    for (const [code, status] of [
      ["ARTIFACT_NOT_FOUND", 404],
      ["VERSION_NOT_FOUND", 404],
      ["FORBIDDEN", 403],
      ["ARTIFACT_GONE", 410],
    ] as const) {
      const response = await makeApp(async () => {
        throw new DomainError(code, "Request could not be completed.");
      }).request(`/api/v1/artifacts/${artifactId}/versions/${version}/compatibility`, {
        ...(code === "FORBIDDEN" ? { headers: { authorization: "Bearer other-token" } } : {}),
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
  });
});
