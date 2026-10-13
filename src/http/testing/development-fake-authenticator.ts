import type { AuthenticatedPrincipal, Authenticator } from "../authentication.js";

export class DevelopmentOnlyFakeAuthenticator implements Authenticator {
  constructor(
    private readonly userId: string,
    private readonly token: string,
  ) {
    if (!userId || !token) {
      throw new Error("A development fake authenticator requires an internal user ID and token.");
    }
  }

  async authenticate(headers: Headers): Promise<AuthenticatedPrincipal | null> {
    const authorization = headers.get("authorization");
    if (authorization !== `Bearer ${this.token}`) return null;
    return { userId: this.userId };
  }
}
