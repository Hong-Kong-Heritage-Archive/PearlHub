import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { GitHubSource } from "../application/services.js";
import { DomainError } from "../domain/errors.js";
import { MAX_IMPORT_CONTENT_BYTES } from "../domain/import.js";

const allowedHost = "raw.githubusercontent.com";
const lookupTimeoutMs = 5_000;
const requestTimeoutMs = 10_000;

export interface GitHubRawResponse {
  statusCode: number;
  body: Buffer;
}

export interface GitHubRawTransport {
  get(url: URL, addresses: LookupAddress[], maxBytes: number, timeoutMs: number): Promise<GitHubRawResponse>;
}

export class SafeGitHubRawSource implements GitHubSource {
  constructor(
    private readonly resolve: (hostname: string) => Promise<LookupAddress[]> = resolvePublicAddresses,
    private readonly transport: GitHubRawTransport = httpsTransport,
  ) {}

  async fetch(sourceUrl: string): Promise<{ content: string; ref: string }> {
    const { url, ref } = validateGitHubRawUrl(sourceUrl);
    let addresses: LookupAddress[];
    try {
      addresses = await withTimeout(this.resolve(url.hostname), lookupTimeoutMs);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof Error && error.message === "IMPORT_SOURCE_TIMEOUT") {
        throw new DomainError("IMPORT_SOURCE_TIMEOUT", "GitHub source request timed out.");
      }
      throw new DomainError("IMPORT_SOURCE_UNAVAILABLE", "GitHub source could not be resolved.");
    }
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new DomainError("IMPORT_SOURCE_INVALID", "GitHub source resolves to a prohibited network destination.");
    }

    let response: GitHubRawResponse;
    try {
      response = await this.transport.get(url, addresses, MAX_IMPORT_CONTENT_BYTES, requestTimeoutMs);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof Error && error.message === "IMPORT_SOURCE_TIMEOUT") {
        throw new DomainError("IMPORT_SOURCE_TIMEOUT", "GitHub source request timed out.");
      }
      throw new DomainError("IMPORT_SOURCE_UNAVAILABLE", "GitHub source could not be retrieved.");
    }
    if (response.statusCode >= 300 && response.statusCode < 400) {
      throw new DomainError("IMPORT_SOURCE_INVALID", "GitHub source redirects are not supported.");
    }
    if (response.statusCode !== 200) {
      throw new DomainError("IMPORT_SOURCE_UNAVAILABLE", "GitHub source returned an unsuccessful response.");
    }
    if (response.body.byteLength > MAX_IMPORT_CONTENT_BYTES) {
      throw new DomainError("IMPORT_CONTENT_TOO_LARGE", "Imported content exceeds the 1 MiB limit.");
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    } catch {
      throw new DomainError("IMPORT_INVALID_FORMAT", "GitHub source is not valid UTF-8 text.");
    }
    return { content, ref };
  }
}

export function validateGitHubRawUrl(sourceUrl: string): { url: URL; ref: string } {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new DomainError("IMPORT_SOURCE_INVALID", "GitHub source URL is malformed.");
  }
  if (url.protocol !== "https:" || url.hostname !== allowedHost || (url.port !== "" && url.port !== "443")
    || url.username || url.password || url.search || url.hash || sourceUrl.length > 2_048) {
    throw new DomainError("IMPORT_SOURCE_INVALID", "Only HTTPS raw.githubusercontent.com URLs without credentials or query data are supported.");
  }

  const rawSegments = url.pathname.slice(1).split("/");
  let segments: string[];
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    throw new DomainError("IMPORT_SOURCE_INVALID", "GitHub source URL contains an invalid path.");
  }
  if (segments.length < 4 || segments.some((part) => !part || part === "." || part === ".." || /[\\/\u0000-\u001f]/.test(part))) {
    throw new DomainError("IMPORT_SOURCE_INVALID", "GitHub source URL must identify a repository, ref, and file.");
  }
  const ref = segments[2] === "refs" && segments.length >= 6
    ? segments.slice(2, 5).join("/")
    : segments[2]!;
  return { url, ref };
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    if (a === undefined || b === undefined || c === undefined) return false;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254)
      || (a === 172 && b !== undefined && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b !== undefined && b >= 64 && b <= 127)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 31 && c === 196)
      || (a === 192 && b === 52 && c === 193)
      || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 175 && c === 48)
      || (a === 198 && b === 18)
      || (a === 198 && b === 19)
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.toLowerCase().startsWith("::ffff:")) return false;
  const [first = "", second = ""] = address.split(":");
  const firstHextet = Number.parseInt(first || "0", 16);
  const secondHextet = Number.parseInt(second || "0", 16);
  return firstHextet >= 0x2000 && firstHextet <= 0x3fff
    && !(firstHextet === 0x2001 && (secondHextet <= 0x01ff || secondHextet === 0x0db8))
    && firstHextet !== 0x2002;
}

const httpsTransport: GitHubRawTransport = {
  async get(url, addresses, maxBytes, timeoutMs) {
    return await new Promise<GitHubRawResponse>((resolve, reject) => {
      let received = 0;
      const chunks: Buffer[] = [];
      const selected = addresses[0]!;
      const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
        if (options?.all) callback(null, addresses);
        else callback(null, selected.address, selected.family);
      };
      const request = httpsRequest(url, {
        method: "GET",
        headers: { accept: "text/plain" },
        lookup: pinnedLookup,
      }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve({ statusCode: response.statusCode ?? 0, body: Buffer.alloc(0) });
          return;
        }
        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          response.destroy();
          request.destroy();
          reject(new DomainError("IMPORT_CONTENT_TOO_LARGE", "Imported content exceeds the 1 MiB limit."));
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += bytes.byteLength;
          if (received > maxBytes) {
            response.destroy();
            request.destroy();
            reject(new DomainError("IMPORT_CONTENT_TOO_LARGE", "Imported content exceeds the 1 MiB limit."));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
        response.on("error", reject);
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error("IMPORT_SOURCE_TIMEOUT")));
      const totalTimeout = setTimeout(() => request.destroy(new Error("IMPORT_SOURCE_TIMEOUT")), timeoutMs);
      request.once("close", () => clearTimeout(totalTimeout));
      request.once("error", reject);
      request.end();
    });
  },
};

function resolvePublicAddresses(hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("IMPORT_SOURCE_TIMEOUT")), timeoutMs);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
