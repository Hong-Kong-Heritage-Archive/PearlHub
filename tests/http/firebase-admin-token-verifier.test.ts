import { beforeEach, describe, expect, it, vi } from "vitest";

const firebaseAdminMocks = vi.hoisted(() => ({
  credential: {
    getAccessToken: vi.fn(async () => ({ access_token: "adc-access-token" })),
  },
  app: {
    name: "pearlhub-api",
    options: { projectId: "pearlhub-test-1" },
  },
  auth: {
    verifyIdToken: vi.fn(async (token: string, checkRevoked: boolean) => {
      void token;
      void checkRevoked;
      return { uid: "verified-firebase-uid" };
    }),
  },
}));

vi.mock("firebase-admin/app", () => ({
  applicationDefault: () => firebaseAdminMocks.credential,
  getApps: () => [firebaseAdminMocks.app],
  initializeApp: vi.fn(),
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => firebaseAdminMocks.auth,
}));

import { createFirebaseAdminIdTokenVerifier } from "../../src/adapters/firebase-authenticator.js";

beforeEach(() => {
  firebaseAdminMocks.credential.getAccessToken
    .mockReset()
    .mockResolvedValue({ access_token: "adc-access-token" });
  firebaseAdminMocks.auth.verifyIdToken
    .mockReset()
    .mockResolvedValue({ uid: "verified-firebase-uid" });
  firebaseAdminMocks.app.options.projectId = "pearlhub-test-1";
});

describe("Firebase Admin ID-token verifier", () => {
  it("validates ADC at startup and checks ID-token revocation", async () => {
    const verifier = await createFirebaseAdminIdTokenVerifier("pearlhub-test-1");

    expect(firebaseAdminMocks.credential.getAccessToken).toHaveBeenCalledOnce();
    await expect(verifier.verify("firebase-id-token")).resolves.toEqual({
      uid: "verified-firebase-uid",
    });
    expect(firebaseAdminMocks.auth.verifyIdToken)
      .toHaveBeenCalledWith("firebase-id-token", true);
  });

  it.each(["auth/id-token-revoked", "auth/user-disabled"])(
    "rejects credentials when Firebase reports %s",
    async (code) => {
      const error = Object.assign(new Error("Firebase rejected the credential."), { code });
      firebaseAdminMocks.auth.verifyIdToken.mockRejectedValueOnce(error);
      const verifier = await createFirebaseAdminIdTokenVerifier("pearlhub-test-1");

      await expect(verifier.verify("firebase-id-token")).resolves.toBeNull();
    },
  );

  it("fails startup when Firebase Admin cannot obtain ADC", async () => {
    firebaseAdminMocks.credential.getAccessToken.mockRejectedValueOnce(
      new Error("credential details must not be exposed"),
    );

    await expect(createFirebaseAdminIdTokenVerifier("pearlhub-test-1"))
      .rejects.toThrow("Firebase Admin could not obtain Application Default Credentials.");
  });
});
