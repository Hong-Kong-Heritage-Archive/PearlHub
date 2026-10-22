import { afterEach, describe, expect, it, vi } from "vitest";
import { requestArtifacts, type DiscoveryFilters } from "../lib/discovery";
import { listDrafts } from "../lib/drafts";

const filters: DiscoveryFilters = {
  q: "",
  tags: [],
  sort: "createdAt",
  order: "desc",
  limit: 20,
  visibility: "",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("API configuration", () => {
  it("reports a missing API base URL for discovery without calling a localhost fallback", async () => {
    const fetch = vi.fn();
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "");
    vi.stubGlobal("fetch", fetch);

    await expect(requestArtifacts(filters, null, new AbortController().signal))
      .rejects.toMatchObject({ message: "The PearlHub API base URL is not configured." });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a missing API base URL for Draft requests without calling a localhost fallback", async () => {
    const fetch = vi.fn();
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "");
    vi.stubGlobal("fetch", fetch);

    await expect(listDrafts("temporary-token"))
      .rejects.toMatchObject({ code: "API_URL_NOT_CONFIGURED" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
