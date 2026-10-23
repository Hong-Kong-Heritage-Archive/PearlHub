import { describe, expect, it } from "vitest";
import { DevelopmentOnlyFakeAuthenticator } from "../../src/http/testing/development-fake-authenticator.js";

describe("development fake authenticator", () => {
  it("maps separate local bearer tokens to their configured user identities", async () => {
    const authenticator = new DevelopmentOnlyFakeAuthenticator("owner-1", "owner-token", [
      { userId: "owner-2", token: "other-owner-token" },
    ]);

    await expect(authenticator.authenticate(new Headers({ authorization: "Bearer owner-token" })))
      .resolves.toEqual({ userId: "owner-1" });
    await expect(authenticator.authenticate(new Headers({ authorization: "Bearer other-owner-token" })))
      .resolves.toEqual({ userId: "owner-2" });
    await expect(authenticator.authenticate(new Headers({ authorization: "Bearer unknown-token" })))
      .resolves.toBeNull();
  });

  it("rejects empty credentials and duplicate tokens", () => {
    expect(() => new DevelopmentOnlyFakeAuthenticator("owner-1", "owner-token", [
      { userId: "", token: "other-token" },
    ])).toThrow("Every development fake credential requires an internal user ID and token.");
    expect(() => new DevelopmentOnlyFakeAuthenticator("owner-1", "same-token", [
      { userId: "owner-2", token: "same-token" },
    ])).toThrow("Development fake authentication tokens must be unique.");
  });
});
