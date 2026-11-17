import { DevelopmentOnlyFakeAuthenticator } from "./http/testing/development-fake-authenticator.js";
import type { Authenticator } from "./http/authentication.js";

export type ServerAuthenticationConfig =
  | { authenticator: Authenticator; firebaseProjectId?: never }
  | { authenticator?: never; firebaseProjectId: string };

export function resolveServerAuthenticationConfig(
  environment: NodeJS.ProcessEnv,
): ServerAuthenticationConfig {
  const mode = environment.PEARLHUB_AUTH_MODE;
  if (mode === "firebase") {
    return { firebaseProjectId: requireFirebaseProjectId(environment.FIREBASE_PROJECT_ID) };
  }
  if (mode !== "development-fake") {
    throw new Error("PEARLHUB_AUTH_MODE must be firebase or development-fake.");
  }
  if (environment.NODE_ENV === "production") {
    throw new Error("Development fake authentication is not allowed in production.");
  }

  const userId = environment.DEV_AUTH_USER_ID;
  const token = environment.DEV_AUTH_TOKEN;
  if (!userId || !token) {
    throw new Error("DEV_AUTH_USER_ID and DEV_AUTH_TOKEN are required for development authentication.");
  }
  const secondUserId = environment.DEV_AUTH_USER_ID_2;
  const secondToken = environment.DEV_AUTH_TOKEN_2;
  if (Boolean(secondUserId) !== Boolean(secondToken)) {
    throw new Error("DEV_AUTH_USER_ID_2 and DEV_AUTH_TOKEN_2 must be configured together.");
  }

  return {
    authenticator: new DevelopmentOnlyFakeAuthenticator(
      userId,
      token,
      secondUserId && secondToken ? [{ userId: secondUserId, token: secondToken }] : [],
    ),
  };
}

export function requireFirebaseProjectId(projectId: string | undefined): string {
  if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error("FIREBASE_PROJECT_ID must be a valid Firebase project ID.");
  }
  return projectId;
}
