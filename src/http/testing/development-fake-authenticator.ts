import type { AuthenticatedPrincipal, Authenticator } from "../authentication.js";

export class DevelopmentOnlyFakeAuthenticator implements Authenticator {
  private readonly userByToken: ReadonlyMap<string, string>;

  constructor(
    userId: string,
    token: string,
    additionalCredentials: ReadonlyArray<{ userId: string; token: string }> = [],
  ) {
    if (!userId || !token) {
      throw new Error("A development fake authenticator requires an internal user ID and token.");
    }
    const credentials = [{ userId, token }, ...additionalCredentials];
    if (credentials.some((credential) => !credential.userId || !credential.token)) {
      throw new Error("Every development fake credential requires an internal user ID and token.");
    }
    if (new Set(credentials.map((credential) => credential.token)).size !== credentials.length) {
      throw new Error("Development fake authentication tokens must be unique.");
    }
    this.userByToken = new Map(credentials.map((credential) => [credential.token, credential.userId]));
  }

  async authenticate(headers: Headers): Promise<AuthenticatedPrincipal | null> {
    const authorization = headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return null;
    const userId = this.userByToken.get(authorization.slice("Bearer ".length));
    return userId ? { userId } : null;
  }
}
