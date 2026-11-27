import { describe, expect, it } from "vitest";
import { requireDatabaseUrl } from "../../src/runtime.js";

describe("requireDatabaseUrl", () => {
  it("accepts a Cloud SQL socket URL with a URL-encoded password", () => {
    const url = "postgresql://pearlhub:%5Eencoded%3Dpassword@/pearlhub?host=/cloudsql/project:region:instance";

    expect(requireDatabaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it("rejects unencoded reserved characters in credentials", () => {
    expect(() => requireDatabaseUrl({
      DATABASE_URL: "postgresql://pearlhub:^not-encoded=/pearlhub?host=/cloudsql/project:region:instance",
    })).toThrow("reserved credentials URL-encoded");
  });
});
