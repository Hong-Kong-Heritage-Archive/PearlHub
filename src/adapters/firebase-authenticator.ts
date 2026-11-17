import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { UserIdentityRepository } from "../ports/repositories.js";
import type { AuthenticatedPrincipal, Authenticator } from "../http/authentication.js";
import { requireFirebaseProjectId } from "../authentication-config.js";

export interface VerifiedFirebaseIdentity {
  uid: string;
}

export interface FirebaseIdTokenVerifier {
  verify(token: string): Promise<VerifiedFirebaseIdentity | null>;
}

export class FirebaseAuthenticator implements Authenticator {
  constructor(
    private readonly verifier: FirebaseIdTokenVerifier,
    private readonly identities: UserIdentityRepository,
  ) {}

  async authenticate(headers: Headers): Promise<AuthenticatedPrincipal | null> {
    const authorization = headers.get("authorization");
    const bearer = authorization && /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!bearer) return null;

    const identity = await this.verifier.verify(bearer[1]!);
    if (!identity || typeof identity.uid !== "string" || identity.uid.length === 0) return null;
    return { userId: await this.identities.resolveOrCreateUserId("firebase", identity.uid) };
  }
}

export async function createFirebaseAdminIdTokenVerifier(projectId: string): Promise<FirebaseIdTokenVerifier> {
  const expectedProjectId = requireFirebaseProjectId(projectId);
  const credential = applicationDefault();
  try {
    await credential.getAccessToken();
  } catch {
    throw new Error("Firebase Admin could not obtain Application Default Credentials.");
  }
  const appName = "pearlhub-api";
  const app = getApps().find((candidate) => candidate.name === appName)
    ?? initializeApp({ credential, projectId: expectedProjectId }, appName);
  if (app.options.projectId !== expectedProjectId) {
    throw new Error("The initialized Firebase Admin app does not match FIREBASE_PROJECT_ID.");
  }
  const auth = getAuth(app);

  return {
    async verify(token) {
      try {
        const claims = await auth.verifyIdToken(token, true);
        return typeof claims.uid === "string" && claims.uid.length > 0 ? { uid: claims.uid } : null;
      } catch (error) {
        if (isInvalidIdTokenError(error)) return null;
        throw error;
      }
    },
  };
}

function isInvalidIdTokenError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = error.code;
  return typeof code === "string" && [
    "auth/argument-error",
    "auth/id-token-expired",
    "auth/invalid-id-token",
    "auth/id-token-revoked",
    "auth/user-disabled",
  ].includes(code);
}
