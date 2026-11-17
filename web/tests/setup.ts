import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { getCurrentFirebaseIdToken } from "../lib/firebase-auth";

vi.mock("../lib/firebase-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/firebase-auth")>();
  return {
    ...actual,
    getCurrentFirebaseIdToken: vi.fn().mockResolvedValue(null),
  };
});

afterEach(() => {
  vi.mocked(getCurrentFirebaseIdToken).mockReset().mockResolvedValue(null);
});
