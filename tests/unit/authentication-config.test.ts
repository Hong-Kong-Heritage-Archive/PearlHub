import { describe, expect, it } from "vitest";
import { resolveServerAuthenticationConfig } from "../../src/authentication-config.js";
import { DevelopmentOnlyFakeAuthenticator } from "../../src/http/testing/development-fake-authenticator.js";

describe("server authentication configuration", () => {
  it("selects Firebase explicitly with a validated project ID", () => {
    expect(resolveServerAuthenticationConfig({
      NODE_ENV: "production",
      PEARLHUB_AUTH_MODE: "firebase",
      FIREBASE_PROJECT_ID: "pearlhub-prod-1",
    })).toEqual({ firebaseProjectId: "pearlhub-prod-1" });
  });

  it("fails closed when Firebase mode has no valid project ID", () => {
    expect(() => resolveServerAuthenticationConfig({
      NODE_ENV: "production",
      PEARLHUB_AUTH_MODE: "firebase",
    })).toThrow("FIREBASE_PROJECT_ID must be a valid Firebase project ID.");
    expect(() => resolveServerAuthenticationConfig({
      NODE_ENV: "production",
      PEARLHUB_AUTH_MODE: "firebase",
      FIREBASE_PROJECT_ID: "not a project",
    })).toThrow("FIREBASE_PROJECT_ID must be a valid Firebase project ID.");
  });

  it("never permits development fake auth in production", () => {
    expect(() => resolveServerAuthenticationConfig({
      NODE_ENV: "production",
      PEARLHUB_AUTH_MODE: "development-fake",
      DEV_AUTH_USER_ID: "internal-user",
      DEV_AUTH_TOKEN: "local-token",
    })).toThrow("Development fake authentication is not allowed in production.");
  });

  it("requires explicit local fake-auth mode and paired optional credentials", () => {
    expect(() => resolveServerAuthenticationConfig({ NODE_ENV: "development" }))
      .toThrow("PEARLHUB_AUTH_MODE must be firebase or development-fake.");
    expect(() => resolveServerAuthenticationConfig({
      NODE_ENV: "development",
      PEARLHUB_AUTH_MODE: "development-fake",
      DEV_AUTH_USER_ID: "internal-user",
    })).toThrow("DEV_AUTH_USER_ID and DEV_AUTH_TOKEN are required for development authentication.");
    expect(() => resolveServerAuthenticationConfig({
      NODE_ENV: "development",
      PEARLHUB_AUTH_MODE: "development-fake",
      DEV_AUTH_USER_ID: "internal-user",
      DEV_AUTH_TOKEN: "local-token",
      DEV_AUTH_USER_ID_2: "second-user",
    })).toThrow("DEV_AUTH_USER_ID_2 and DEV_AUTH_TOKEN_2 must be configured together.");
    expect(resolveServerAuthenticationConfig({
      NODE_ENV: "development",
      PEARLHUB_AUTH_MODE: "development-fake",
      DEV_AUTH_USER_ID: "internal-user",
      DEV_AUTH_TOKEN: "local-token",
    }).authenticator).toBeInstanceOf(DevelopmentOnlyFakeAuthenticator);
  });
});
