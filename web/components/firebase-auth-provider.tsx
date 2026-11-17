"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import {
  FirebaseClientConfigurationError,
  initializeFirebaseAuth,
  onFirebaseAuthenticationRejected,
} from "../lib/firebase-auth";

type FirebaseSessionStatus = "loading" | "signed-in" | "signed-out" | "unavailable";
type EmailMode = "sign-in" | "create-account";
type FirebaseSessionUser = Pick<User, "uid" | "email">;

export interface FirebaseSession {
  status: FirebaseSessionStatus;
  user: FirebaseSessionUser | null;
  error: string | null;
  signInWithGoogle(): Promise<void>;
  signInWithEmail(email: string, password: string): Promise<void>;
  createAccount(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

export const FirebaseSessionContext = createContext<FirebaseSession | null>(null);

const signedOutSession: FirebaseSession = {
  status: "signed-out",
  user: null,
  error: null,
  signInWithGoogle: async () => {},
  signInWithEmail: async () => {},
  createAccount: async () => {},
  signOut: async () => {},
};

export function useFirebaseSession(): FirebaseSession {
  const session = useContext(FirebaseSessionContext);
  return session ?? signedOutSession;
}

export function FirebaseAuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [status, setStatus] = useState<FirebaseSessionStatus>("loading");
  const [user, setUser] = useState<FirebaseSessionUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    void initializeFirebaseAuth().then((initializedAuth) => {
      if (!active) return;
      if (!initializedAuth) {
        setStatus("unavailable");
        return;
      }
      setAuth(initializedAuth);
      unsubscribe = onIdTokenChanged(initializedAuth, (nextUser) => {
        if (!active) return;
        setUser(nextUser ? { uid: nextUser.uid, email: nextUser.email } : null);
        setStatus(nextUser ? "signed-in" : "signed-out");
        if (nextUser) setError(null);
      });
    }).catch((cause: unknown) => {
      if (!active) return;
      setStatus("unavailable");
      setError(cause instanceof FirebaseClientConfigurationError
        ? cause.message
        : "Firebase sign-in is unavailable. Check the public Firebase configuration.");
    });

    const unsubscribeRejected = onFirebaseAuthenticationRejected(() => {
      setError("PearlHub rejected the current session. Sign in again to continue.");
      setUser(null);
      setStatus("signed-out");
      if (auth?.currentUser) {
        void signOut(auth).catch(() => {
          setError("PearlHub rejected the current session. Sign out and sign in again.");
        });
      }
    });

    return () => {
      active = false;
      unsubscribe?.();
      unsubscribeRejected();
    };
  }, [auth]);

  const runAuthAction = useCallback(async (action: (currentAuth: Auth) => Promise<unknown>) => {
    if (!auth) {
      setError("Firebase sign-in is not configured for this application.");
      return;
    }
    setError(null);
    try {
      await action(auth);
    } catch (cause: unknown) {
      setError(getFirebaseActionError(cause));
    }
  }, [auth]);

  const session = useMemo<FirebaseSession>(() => ({
    status,
    user,
    error,
    signInWithGoogle: () => runAuthAction((currentAuth) =>
      signInWithPopup(currentAuth, new GoogleAuthProvider())),
    signInWithEmail: (email, password) => runAuthAction((currentAuth) =>
      signInWithEmailAndPassword(currentAuth, email, password)),
    createAccount: (email, password) => runAuthAction((currentAuth) =>
      createUserWithEmailAndPassword(currentAuth, email, password)),
    signOut: () => runAuthAction((currentAuth) => signOut(currentAuth)),
  }), [error, runAuthAction, status, user]);

  return (
    <FirebaseSessionContext.Provider value={session}>
      <FirebaseAuthControls />
      {children}
    </FirebaseSessionContext.Provider>
  );
}

function FirebaseAuthControls() {
  const { status, user, error, signInWithGoogle, signInWithEmail, createAccount, signOut } = useFirebaseSession();
  const [mode, setMode] = useState<EmailMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    if (mode === "sign-in") await signInWithEmail(email, password);
    else await createAccount(email, password);
    setPassword("");
    setBusy(false);
  }

  async function submitGoogle() {
    setBusy(true);
    await signInWithGoogle();
    setBusy(false);
  }

  async function submitSignOut() {
    setBusy(true);
    await signOut();
    setBusy(false);
  }

  return (
    <section className="auth-panel" aria-label="PearlHub account">
      {status === "loading" && <p role="status">Checking sign-in status…</p>}
      {status === "unavailable" && (
        <p role="status">Firebase sign-in is unavailable. Configure the public Firebase app settings to enable account access.</p>
      )}
      {status === "signed-in" && (
        <div className="auth-signed-in">
          <p>Signed in{user?.email ? ` as ${user.email}` : ""}.</p>
          <button className="secondary-button" type="button" onClick={() => void submitSignOut()} disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
      {status === "signed-out" && (
        <div className="auth-signed-out">
          <button className="secondary-button" type="button" onClick={() => void submitGoogle()} disabled={busy}>
            {busy ? "Connecting…" : "Continue with Google"}
          </button>
          <form className="auth-email-form" onSubmit={(event) => void submitEmail(event)}>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={busy}
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                minLength={6}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
              />
            </label>
            <div className="auth-actions">
              <button className="primary-button" type="submit" disabled={busy}>
                {busy ? "Please wait…" : mode === "sign-in" ? "Sign in with email" : "Create account"}
              </button>
              <button
                className="auth-mode-button"
                type="button"
                onClick={() => {
                  setMode((current) => current === "sign-in" ? "create-account" : "sign-in");
                }}
                disabled={busy}
              >
                {mode === "sign-in" ? "Create an account" : "Already have an account? Sign in"}
              </button>
            </div>
          </form>
        </div>
      )}
      {error && <p className="create-error" role="alert">{error}</p>}
    </section>
  );
}

function getFirebaseActionError(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
  if (code === "auth/email-already-in-use") return "An account already exists for that email. Sign in instead.";
  if (code === "auth/weak-password") return "Choose a stronger password.";
  if (code === "auth/invalid-email") return "Enter a valid email address.";
  if (["auth/invalid-credential", "auth/invalid-login-credentials", "auth/user-not-found", "auth/wrong-password"].includes(code)) {
    return "The email or password could not be verified.";
  }
  if (code === "auth/operation-not-allowed") return "This sign-in method is not enabled for the Firebase project.";
  if (code === "auth/popup-closed-by-user") return "Google sign-in was cancelled.";
  return "Sign-in could not be completed. Try again.";
}
