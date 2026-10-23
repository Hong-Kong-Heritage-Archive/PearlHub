import { describe, expect, it, vi } from "vitest";
import type { LookupAddress } from "node:dns";
import { isPublicAddress, SafeGitHubRawSource, validateGitHubRawUrl, type GitHubRawTransport } from "../../src/adapters/github-raw-source.js";

const publicAddress: LookupAddress = { address: "140.82.112.3", family: 4 };

function source(
  addresses: LookupAddress[] = [publicAddress],
  response: { statusCode: number; body: Buffer } = { statusCode: 200, body: Buffer.from("# A Skill\n", "utf8") },
) {
  const transport: GitHubRawTransport = { get: vi.fn(async () => response) };
  return {
    service: new SafeGitHubRawSource(async () => addresses, transport),
    transport,
  };
}

describe("safe GitHub raw content source", () => {
  it("accepts the fixed raw host and captures the explicit ref", () => {
    expect(validateGitHubRawUrl("https://raw.githubusercontent.com/acme/pearl/main/SKILL.md").ref).toBe("main");
    expect(validateGitHubRawUrl("https://raw.githubusercontent.com/acme/pearl/refs/heads/main/SKILL.md").ref).toBe("refs/heads/main");
  });

  it.each([
    "http://raw.githubusercontent.com/acme/pearl/main/SKILL.md",
    "https://github.com/acme/pearl/raw/main/SKILL.md",
    "https://raw.githubusercontent.com.evil.example/acme/pearl/main/SKILL.md",
    "https://user:password@raw.githubusercontent.com/acme/pearl/main/SKILL.md",
    "https://raw.githubusercontent.com:444/acme/pearl/main/SKILL.md",
    "https://raw.githubusercontent.com/acme/pearl/main/../../etc/passwd",
    "https://raw.githubusercontent.com/acme/pearl/main/%2fetc/passwd",
    "https://raw.githubusercontent.com/acme/pearl/main/SKILL.md?token=secret",
  ])("rejects unsupported URL %s before network access", async (url) => {
    const { service, transport } = source();
    await expect(service.fetch(url)).rejects.toMatchObject({ code: "IMPORT_SOURCE_INVALID" });
    expect(transport.get).not.toHaveBeenCalled();
  });

  it("pins requests to validated public DNS addresses and preserves UTF-8 content", async () => {
    const { service, transport } = source();
    await expect(service.fetch("https://raw.githubusercontent.com/acme/pearl/main/SKILL.md")).resolves.toEqual({
      content: "# A Skill\n",
      ref: "main",
    });
    expect(transport.get).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "raw.githubusercontent.com" }),
      [publicAddress],
      1_048_576,
      10_000,
    );
  });

  it("rejects private, loopback, and mixed public/private DNS answers", async () => {
    for (const answers of [
      [{ address: "127.0.0.1", family: 4 }],
      [{ address: "::1", family: 6 }],
      [publicAddress, { address: "10.0.0.1", family: 4 }],
    ]) {
      const { service, transport } = source(answers);
      await expect(service.fetch("https://raw.githubusercontent.com/acme/pearl/main/SKILL.md"))
        .rejects.toMatchObject({ code: "IMPORT_SOURCE_INVALID" });
      expect(transport.get).not.toHaveBeenCalled();
    }
  });

  it("rejects redirects, failed HTTP responses, and oversized bodies", async () => {
    for (const [response, code] of [
      [{ statusCode: 302, body: Buffer.alloc(0) }, "IMPORT_SOURCE_INVALID"],
      [{ statusCode: 404, body: Buffer.alloc(0) }, "IMPORT_SOURCE_UNAVAILABLE"],
      [{ statusCode: 200, body: Buffer.alloc(1_048_577) }, "IMPORT_CONTENT_TOO_LARGE"],
    ] as const) {
      const { service } = source([publicAddress], response);
      await expect(service.fetch("https://raw.githubusercontent.com/acme/pearl/main/SKILL.md"))
        .rejects.toMatchObject({ code });
    }
  });

  it("maps request timeout and invalid UTF-8 to stable errors", async () => {
    const timedOut = new SafeGitHubRawSource(async () => [publicAddress], {
      get: async () => { throw new Error("IMPORT_SOURCE_TIMEOUT"); },
    });
    await expect(timedOut.fetch("https://raw.githubusercontent.com/acme/pearl/main/SKILL.md"))
      .rejects.toMatchObject({ code: "IMPORT_SOURCE_TIMEOUT" });

    const invalidText = source([publicAddress], { statusCode: 200, body: Buffer.from([0xff]) }).service;
    await expect(invalidText.fetch("https://raw.githubusercontent.com/acme/pearl/main/SKILL.md"))
      .rejects.toMatchObject({ code: "IMPORT_INVALID_FORMAT" });
  });

  it("allows only globally routable unicast destination addresses", () => {
    expect(isPublicAddress("140.82.112.3")).toBe(true);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("10.1.2.3")).toBe(false);
    expect(isPublicAddress("169.254.10.1")).toBe(false);
    expect(isPublicAddress("192.168.1.1")).toBe(false);
    expect(isPublicAddress("192.88.99.1")).toBe(false);
    expect(isPublicAddress("2001:4860:4860::8888")).toBe(true);
    expect(isPublicAddress("fc00::1")).toBe(false);
    expect(isPublicAddress("2001:db8::1")).toBe(false);
    expect(isPublicAddress("2002:0808:0808::1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
  });
});
