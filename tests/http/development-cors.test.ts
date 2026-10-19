import { describe, expect, it } from "vitest";
import { parseDevelopmentCorsOrigins } from "../../src/http/development-cors.js";

describe("parseDevelopmentCorsOrigins", () => {
  it("defaults to the local Next.js development origins", () => {
    expect(parseDevelopmentCorsOrigins(undefined)).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]);
  });

  it("normalizes and deduplicates configured origins", () => {
    expect(parseDevelopmentCorsOrigins(" https://web.example.test/,https://web.example.test ")).toEqual([
      "https://web.example.test",
    ]);
  });

  it("accepts an empty list to disable development CORS", () => {
    expect(parseDevelopmentCorsOrigins(" , ")).toEqual([]);
  });

  it.each([
    "*",
    "ftp://web.example.test",
    "http://user:password@localhost:3000",
    "http://localhost:3000/path",
    "http://localhost:3000/?q=1",
  ])("rejects unsafe or non-origin configuration %s", (value) => {
    expect(() => parseDevelopmentCorsOrigins(value)).toThrow("PEARLHUB_DEV_CORS_ORIGINS");
  });
});
