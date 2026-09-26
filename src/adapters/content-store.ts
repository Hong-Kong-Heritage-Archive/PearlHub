import { createHash } from "node:crypto";
import type { ArtifactContentStore } from "../ports/repositories.js";

export class MemoryArtifactContentStore implements ArtifactContentStore {
  private readonly contents = new Map<string, string>();

  async put(content: string, contentHash: string): Promise<string> {
    const actualHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (actualHash !== contentHash) throw new Error("Content hash does not match content.");
    this.contents.set(contentHash, content);
    return contentHash;
  }

  async get(location: string): Promise<string | null> {
    return this.contents.get(location) ?? null;
  }

  async exists(contentHash: string): Promise<boolean> {
    return this.contents.has(contentHash);
  }
}