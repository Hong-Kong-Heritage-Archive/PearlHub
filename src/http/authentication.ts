export interface AuthenticatedPrincipal {
  userId: string;
}

export interface Authenticator {
  authenticate(headers: Headers): Promise<AuthenticatedPrincipal | null>;
}
