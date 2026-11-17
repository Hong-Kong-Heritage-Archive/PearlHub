import { describe, expect, it, vi } from "vitest";
import { FirebaseAuthenticator, type FirebaseIdTokenVerifier } from "../../src/adapters/firebase-authenticator.js";
import type { UserIdentityRepository } from "../../src/ports/repositories.js";

describe("Firebase authenticator", () => {
  it("returns null for absent and malformed bearer credentials", async () => {
    const verifier: FirebaseIdTokenVerifier = { verify: vi.fn() };
    const identities: UserIdentityRepository = {
      findUserId: vi.fn(),
      create: vi.fn(),
      resolveOrCreateUserId: vi.fn(),
    };
    const authenticator = new FirebaseAuthenticator(verifier, identities);

    await expect(authenticator.authenticate(new Headers())).resolves.toBeNull();
    await expect(authenticator.authenticate(new Headers({ authorization: "Basic token" }))).resolves.toBeNull();
    await expect(authenticator.authenticate(new Headers({ authorization: "Bearer token with-spaces" }))).resolves.toBeNull();
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(identities.resolveOrCreateUserId).not.toHaveBeenCalled();
  });

  it("returns null for rejected tokens without attempting identity mapping", async () => {
    const verifier: FirebaseIdTokenVerifier = { verify: vi.fn().mockResolvedValue(null) };
    const identities: UserIdentityRepository = {
      findUserId: vi.fn(),
      create: vi.fn(),
      resolveOrCreateUserId: vi.fn(),
    };
    const authenticator = new FirebaseAuthenticator(verifier, identities);

    await expect(authenticator.authenticate(new Headers({ authorization: "Bearer invalid-token" }))).resolves.toBeNull();
    expect(identities.resolveOrCreateUserId).not.toHaveBeenCalled();
  });

  it("maps a verified Firebase UID to its internal PearlHub user", async () => {
    const verifier: FirebaseIdTokenVerifier = {
      verify: vi.fn().mockResolvedValue({ uid: "firebase-uid-1" }),
    };
    const identities: UserIdentityRepository = {
      findUserId: vi.fn(),
      create: vi.fn(),
      resolveOrCreateUserId: vi.fn().mockResolvedValue("internal-user-1"),
    };
    const authenticator = new FirebaseAuthenticator(verifier, identities);

    await expect(authenticator.authenticate(new Headers({ authorization: "Bearer verified-token" })))
      .resolves.toEqual({ userId: "internal-user-1" });
    expect(identities.resolveOrCreateUserId).toHaveBeenCalledWith("firebase", "firebase-uid-1");
    expect(identities.resolveOrCreateUserId).not.toHaveBeenCalledWith("firebase", expect.anything(), expect.anything());
  });

  it("does not convert identity persistence failures into anonymous authentication", async () => {
    const verifier: FirebaseIdTokenVerifier = {
      verify: vi.fn().mockResolvedValue({ uid: "firebase-uid-1" }),
    };
    const identities: UserIdentityRepository = {
      findUserId: vi.fn(),
      create: vi.fn(),
      resolveOrCreateUserId: vi.fn().mockRejectedValue(new Error("database unavailable")),
    };
    const authenticator = new FirebaseAuthenticator(verifier, identities);

    await expect(authenticator.authenticate(new Headers({ authorization: "Bearer verified-token" })))
      .rejects.toThrow("database unavailable");
  });
});
