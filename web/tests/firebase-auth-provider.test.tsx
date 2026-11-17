import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TestUser = {
  uid: string;
  email: string | null;
  getIdToken(): Promise<string>;
};

const firebaseMocks = vi.hoisted(() => {
  type MockUser = { uid: string; email: string | null; getIdToken(): Promise<string> };
  let listener: ((user: MockUser | null) => void) | null = null;
  const auth: { currentUser: MockUser | null } = { currentUser: null };
  const localPersistence = { persistence: "local" };
  const setPersistence = vi.fn(async (...args: unknown[]) => {
    void args;
  });
  const emit = (user: MockUser | null) => {
    auth.currentUser = user;
    listener?.(user);
  };
  const user = (uid: string, email: string | null): MockUser => ({
    uid,
    email,
    getIdToken: async () => "sensitive-id-token",
  });

  return {
    auth,
    localPersistence,
    setPersistence,
    emit,
    user,
    setListener(next: ((user: MockUser | null) => void) | null) {
      listener = next;
    },
  };
});

vi.mock("firebase/auth", () => ({
  browserLocalPersistence: firebaseMocks.localPersistence,
  getAuth: () => firebaseMocks.auth,
  setPersistence: firebaseMocks.setPersistence,
  onIdTokenChanged: vi.fn((_auth: unknown, callback: (user: TestUser | null) => void) => {
    firebaseMocks.setListener(callback);
    callback(firebaseMocks.auth.currentUser);
    return vi.fn();
  }),
  GoogleAuthProvider: class GoogleAuthProvider {},
  signInWithPopup: vi.fn(async () => {
    const user = firebaseMocks.user("google-uid", "google@example.test");
    firebaseMocks.emit(user);
    return { user };
  }),
  signInWithEmailAndPassword: vi.fn(async (_auth: unknown, email: string) => {
    const user = firebaseMocks.user("email-uid", email);
    firebaseMocks.emit(user);
    return { user };
  }),
  createUserWithEmailAndPassword: vi.fn(async (_auth: unknown, email: string) => {
    const user = firebaseMocks.user("new-email-uid", email);
    firebaseMocks.emit(user);
    return { user };
  }),
  signOut: vi.fn(async () => {
    firebaseMocks.emit(null);
  }),
}));

vi.mock("firebase/app", () => ({
  getApps: () => [{
    name: "pearlhub-web",
    options: { projectId: "pearlhub-demo-1" },
  }],
  initializeApp: vi.fn(),
}));

vi.mock("../lib/firebase-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/firebase-auth")>();
  return {
    ...actual,
    initializeFirebaseAuth: vi.fn(async () => {
      await firebaseMocks.setPersistence(firebaseMocks.auth, firebaseMocks.localPersistence);
      return firebaseMocks.auth;
    }),
    getCurrentFirebaseIdToken: vi.fn(async () => null),
  };
});

import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
} from "firebase/auth";
import { FirebaseAuthProvider } from "../components/firebase-auth-provider";
import { readFirebaseClientConfig, getCurrentFirebaseIdToken } from "../lib/firebase-auth";
import { listDrafts } from "../lib/drafts";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(getCurrentFirebaseIdToken).mockReset().mockResolvedValue(null);
  firebaseMocks.setPersistence.mockClear();
  firebaseMocks.emit(null);
  firebaseMocks.setListener(null);
});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "public-api-key");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "pearlhub-demo.firebaseapp.com");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "pearlhub-demo-1");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_ID", "1:123:web:abc");
  firebaseMocks.emit(null);
  vi.mocked(getCurrentFirebaseIdToken).mockReset().mockResolvedValue(null);
});

describe("Firebase client authentication", () => {
  it("validates public Firebase configuration and tolerates an entirely unconfigured environment", () => {
    expect(readFirebaseClientConfig({})).toBeNull();
    expect(() => readFirebaseClientConfig({
      NEXT_PUBLIC_FIREBASE_API_KEY: "public-api-key",
    })).toThrow("Firebase public configuration is incomplete.");
    expect(readFirebaseClientConfig({
      NEXT_PUBLIC_FIREBASE_API_KEY: "public-api-key",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "pearlhub-demo.firebaseapp.com",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "pearlhub-demo-1",
      NEXT_PUBLIC_FIREBASE_APP_ID: "1:123:web:abc",
    })).toEqual({
      apiKey: "public-api-key",
      authDomain: "pearlhub-demo.firebaseapp.com",
      projectId: "pearlhub-demo-1",
      appId: "1:123:web:abc",
    });
    expect(() => readFirebaseClientConfig({
      NEXT_PUBLIC_FIREBASE_API_KEY: "public-api-key",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "pearlhub-demo.firebaseapp.com",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "pearlhub-demo-1",
      NEXT_PUBLIC_FIREBASE_APP_ID: "invalid app id",
    })).toThrow("Firebase public configuration is invalid.");
  });

  it("offers signed-out Google and email/password sign-in, and creates email/password accounts", async () => {
    render(<FirebaseAuthProvider><p>Public content</p></FirebaseAuthProvider>);
    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.getByText("Public content")).toBeInTheDocument();
    expect(setPersistence).toHaveBeenCalledWith(firebaseMocks.auth, browserLocalPersistence);

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(await screen.findByText("Signed in as google@example.test.")).toBeInTheDocument();
    expect(signInWithPopup).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "returning@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "safe-example-password" } });
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with email" }));
    expect(await screen.findByText("Signed in as returning@example.test.")).toBeInTheDocument();
    expect(signInWithEmailAndPassword).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create an account" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "safe-example-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Signed in as new@example.test.")).toBeInTheDocument();
    expect(createUserWithEmailAndPassword).toHaveBeenCalledTimes(1);
  });

  it("returns to signed-out state after an API 401 without rendering or persisting ID tokens", async () => {
    firebaseMocks.emit(firebaseMocks.user("session-uid", "owner@example.test"));
    vi.mocked(getCurrentFirebaseIdToken).mockResolvedValue("sensitive-id-token");
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", "https://api.example.test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "UNAUTHENTICATED", message: "Authentication is required.", details: {} },
    }), { status: 401, headers: { "content-type": "application/json" } })));

    function ProtectedRequest() {
      return <button type="button" onClick={() => void listDrafts().catch(() => {})}>Request Drafts</button>;
    }

    render(<FirebaseAuthProvider><ProtectedRequest /></FirebaseAuthProvider>);
    expect(await screen.findByText("Signed in as owner@example.test.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Request Drafts" }));

    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("PearlHub rejected the current session.");
    expect(screen.queryByText("sensitive-id-token")).not.toBeInTheDocument();
    expect(storageWrite).not.toHaveBeenCalled();
    await waitFor(() => expect(firebaseMocks.auth.currentUser).toBeNull());
  });
});
