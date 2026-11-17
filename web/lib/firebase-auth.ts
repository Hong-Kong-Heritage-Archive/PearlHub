import { getApps, initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  setPersistence,
  type Auth,
} from "firebase/auth";

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

export interface FirebaseClientEnvironment {
  NEXT_PUBLIC_FIREBASE_API_KEY?: string;
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?: string;
  NEXT_PUBLIC_FIREBASE_PROJECT_ID?: string;
  NEXT_PUBLIC_FIREBASE_APP_ID?: string;
}

export class FirebaseClientConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirebaseClientConfigurationError";
  }
}

export function readFirebaseClientConfig(
  environment: FirebaseClientEnvironment = {
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  },
): FirebaseClientConfig | null {
  const values = [
    environment.NEXT_PUBLIC_FIREBASE_API_KEY?.trim(),
    environment.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim(),
    environment.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim(),
    environment.NEXT_PUBLIC_FIREBASE_APP_ID?.trim(),
  ];
  if (values.every((value) => !value)) return null;
  const [apiKey, authDomain, projectId, appId] = values;
  if (!apiKey || !authDomain || !projectId || !appId) {
    throw new FirebaseClientConfigurationError("Firebase public configuration is incomplete.");
  }
  if (
    /\s/.test(apiKey)
    || /\s/.test(authDomain)
    || /\s/.test(appId)
    || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)
  ) {
    throw new FirebaseClientConfigurationError("Firebase public configuration is invalid.");
  }
  return { apiKey, authDomain, projectId, appId };
}

export function getFirebaseAuth(): Auth | null {
  const config = readFirebaseClientConfig();
  if (!config) return null;
  const appName = "pearlhub-web";
  const app = getApps().find((candidate) => candidate.name === appName)
    ?? initializeApp(config, appName);
  if (app.options.projectId !== config.projectId) {
    throw new FirebaseClientConfigurationError("The initialized Firebase app does not match the configured project.");
  }
  return getAuth(app);
}

export async function initializeFirebaseAuth(): Promise<Auth | null> {
  const auth = getFirebaseAuth();
  if (!auth) return null;
  await setPersistence(auth, browserLocalPersistence);
  return auth;
}

export async function getCurrentFirebaseIdToken(): Promise<string | null> {
  const auth = getFirebaseAuth();
  if (!auth?.currentUser) return null;
  return auth.currentUser.getIdToken();
}

export function notifyFirebaseAuthenticationRejected(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("pearlhub:authentication-rejected"));
  }
}

export function onFirebaseAuthenticationRejected(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("pearlhub:authentication-rejected", listener);
  return () => window.removeEventListener("pearlhub:authentication-rejected", listener);
}
