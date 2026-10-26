"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  DraftRequestError,
  getArtifact,
  getArtifactLineage,
  getCurrentUser,
  updateArtifactVisibility,
  type ArtifactVisibility,
  type ArtifactLineage,
  type ArtifactMetadata,
  type CurrentUser,
} from "../lib/drafts";

interface DetailState {
  artifactId: string | null;
  token: string;
  artifact: ArtifactMetadata | null;
  lineage: ArtifactLineage | null;
  error: string | null;
  loading: boolean;
}

const initialState: DetailState = {
  artifactId: null,
  token: "",
  artifact: null,
  lineage: null,
  error: null,
  loading: true,
};

const visibilityOptions: ArtifactVisibility[] = ["private", "unlisted", "public"];

export default function ArtifactDetail({ artifactId }: { artifactId: string }) {
  const [tokenInput, setTokenInput] = useState("");
  const [token, setToken] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const [identityRetryCount, setIdentityRetryCount] = useState(0);
  const [currentUser, setCurrentUser] = useState<(CurrentUser & { token: string }) | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [visibilitySelection, setVisibilitySelection] = useState<ArtifactVisibility>("private");
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const [visibilityMessage, setVisibilityMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const saveController = useRef<AbortController | null>(null);
  const [state, setState] = useState(initialState);

  useEffect(() => {
    const controller = new AbortController();
    setState({ artifactId, token, artifact: null, lineage: null, error: null, loading: true });
    void Promise.all([
      getArtifact(artifactId, token, controller.signal),
      getArtifactLineage(artifactId, token, controller.signal),
    ]).then(([artifact, lineage]) => {
      if (!controller.signal.aborted) {
        setState({ artifactId, token, artifact, lineage, error: null, loading: false });
        setVisibilitySelection(artifact.visibility);
        setVisibilityMessage(null);
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setState({
        artifactId,
        token,
        artifact: null,
        lineage: null,
        error: getDetailError(error),
        loading: false,
      });
    });
    return () => controller.abort();
  }, [artifactId, retryCount, token]);

  useEffect(() => {
    const controller = new AbortController();
    setCurrentUser(null);
    if (!token) {
      setIdentityLoading(false);
      return () => controller.abort();
    }

    setIdentityLoading(true);
    void getCurrentUser(token, controller.signal).then((user) => {
      if (!controller.signal.aborted) setCurrentUser({ ...user, token });
    }).catch(() => {
      if (!controller.signal.aborted) setCurrentUser(null);
    }).finally(() => {
      if (!controller.signal.aborted) setIdentityLoading(false);
    });
    return () => controller.abort();
  }, [identityRetryCount, token]);

  useEffect(() => () => saveController.current?.abort(), [artifactId, token]);

  const displayedArtifact = state.artifactId === artifactId && state.token === token ? state.artifact : null;
  const detailLoading = displayedArtifact === null && state.error === null
    || (state.artifactId === artifactId && state.token === token && state.loading);
  const detailError = state.artifactId === artifactId && state.token === token ? state.error : null;
  const canEditVisibility = displayedArtifact !== null
    && displayedArtifact.status === "active"
    && token.length > 0
    && tokenInput.trim() === token
    && !identityLoading
    && currentUser?.token === token
    && currentUser.userId === displayedArtifact.ownerId;

  async function saveVisibility() {
    if (!canEditVisibility || !displayedArtifact) return;
    const controller = new AbortController();
    saveController.current = controller;
    setVisibilitySaving(true);
    setVisibilityMessage(null);
    try {
      const updated = await updateArtifactVisibility(displayedArtifact.id, visibilitySelection, token, controller.signal);
      if (controller.signal.aborted) return;
      setState((current) => current.artifactId === artifactId && current.token === token && current.artifact
        ? { ...current, artifact: updated }
        : current);
      setVisibilitySelection(updated.visibility);
      setVisibilityMessage({ kind: "success", text: "Visibility updated." });
    } catch (error) {
      if (controller.signal.aborted) return;
      setVisibilityMessage({ kind: "error", text: getVisibilityError(error) });
    } finally {
      if (!controller.signal.aborted) setVisibilitySaving(false);
      if (saveController.current === controller) saveController.current = null;
    }
  }

  return (
    <main className="page-shell">
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="PearlHub home">PearlHub</Link>
        <nav className="site-nav" aria-label="Main navigation">
          <Link href="/">Discover</Link>
          <Link className="nav-create-link" href="/create">Create Draft</Link>
          <Link href="/import">Import</Link>
          <Link href="/drafts">My Drafts</Link>
        </nav>
      </header>

      <section className="intro">
        <p className="eyebrow">ARTIFACT DETAIL</p>
        <h1>{state.artifact?.name ?? "Artifact"}</h1>
        <p className="intro-copy">Artifact metadata and visible PearlHub Fork lineage.</p>
      </section>

      <section className="create-panel" aria-label="Artifact access">
        <label className="field" htmlFor="artifact-detail-token">
          <span>Developer bearer token (optional for public Artifacts)</span>
          <input
            id="artifact-detail-token"
            type="password"
            autoComplete="off"
            value={tokenInput}
            onChange={(event) => {
              const nextToken = event.target.value.trim();
              setTokenInput(event.target.value);
              if (nextToken !== token) {
                setCurrentUser(null);
                setIdentityLoading(false);
                setVisibilityMessage(null);
                if (token) setToken("");
              }
            }}
          />
          <span className="field-help">Temporary in-memory token only; no login flow is available.</span>
        </label>
        <button
          className="secondary-button"
          type="button"
          disabled={state.loading && state.token === token}
          onClick={() => {
            const nextToken = tokenInput.trim();
            setCurrentUser(null);
            setIdentityLoading(Boolean(nextToken));
            setVisibilityMessage(null);
            setToken(nextToken);
            setIdentityRetryCount((count) => count + 1);
          }}
        >
          Load with token
        </button>
      </section>

      {detailLoading && <p className="status-panel" role="status">Loading Artifact details…</p>}
      {!detailLoading && detailError && (
        <section className="status-panel error-panel" role="alert">
          <h2>Unable to load this Artifact</h2>
          <p>{detailError}</p>
          <button className="secondary-button" type="button" onClick={() => setRetryCount((count) => count + 1)}>
            Try again
          </button>
        </section>
      )}
      {!detailLoading && !detailError && displayedArtifact && state.lineage && (
        <>
          <section className="create-panel" aria-labelledby="artifact-metadata-title">
            <h2 id="artifact-metadata-title">Artifact metadata</h2>
            <dl className="artifact-dates">
              <div><dt>Slug</dt><dd>{displayedArtifact.slug}</dd></div>
              <div><dt>Owner</dt><dd>{displayedArtifact.ownerId}</dd></div>
              <div><dt>Visibility</dt><dd>{displayedArtifact.visibility}</dd></div>
              <div><dt>Status</dt><dd>{displayedArtifact.status}</dd></div>
              <div><dt>Created</dt><dd><time dateTime={displayedArtifact.createdAt}>{formatDate(displayedArtifact.createdAt)}</time></dd></div>
              <div><dt>Updated</dt><dd><time dateTime={displayedArtifact.updatedAt}>{formatDate(displayedArtifact.updatedAt)}</time></dd></div>
            </dl>
            {canEditVisibility && (
              <section aria-labelledby="visibility-editor-title">
                <h3 id="visibility-editor-title">Edit visibility</h3>
                <label className="field" htmlFor="artifact-visibility">
                  <span>Visibility</span>
                  <select
                    id="artifact-visibility"
                    value={visibilitySelection}
                    disabled={visibilitySaving}
                    onChange={(event) => {
                      setVisibilitySelection(event.target.value as ArtifactVisibility);
                      setVisibilityMessage(null);
                    }}
                  >
                    {visibilityOptions.map((visibility) => (
                      <option key={visibility} value={visibility}>{visibility}</option>
                    ))}
                  </select>
                </label>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={visibilitySaving || visibilitySelection === displayedArtifact.visibility}
                  onClick={() => void saveVisibility()}
                >
                  {visibilitySaving ? "Saving…" : "Save visibility"}
                </button>
                {visibilityMessage && (
                  <p role={visibilityMessage.kind === "success" ? "status" : "alert"}>{visibilityMessage.text}</p>
                )}
              </section>
            )}
            <Link className="secondary-button" href={`/artifacts/${encodeURIComponent(displayedArtifact.id)}/versions`}>
              View published versions
            </Link>
          </section>
          <section className="create-panel" aria-labelledby="lineage-title">
            <h2 id="lineage-title">Fork lineage</h2>
            <LineageList title="Forked from" entries={state.lineage.parents} />
            <LineageList title="Forked into" entries={state.lineage.children} />
            {state.lineage.parents.length === 0 && state.lineage.children.length === 0 && (
              <p role="status">No visible Fork lineage.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function LineageList({ title, entries }: { title: string; entries: ArtifactLineage["parents"] }) {
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      {entries.length === 0
        ? <p>None</p>
        : <ul className="version-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <Link href={`/artifacts/${encodeURIComponent(entry.artifact.id)}`}>
                {entry.artifact.name} ({entry.artifact.slug})
              </Link>
              <span>
                {entry.relationshipType === "fork" ? "Fork" : "Relationship"} · source Version ID: {entry.sourceVersionId ?? "unavailable"}
              </span>
            </li>
          ))}
        </ul>}
    </section>
  );
}

function getDetailError(error: unknown): string {
  if (error instanceof DraftRequestError) {
    if (error.status === 410) return "This Artifact has been tombstoned and is no longer readable.";
    if (error.status === 403) return "You do not have permission to view this Artifact.";
    if (error.status === 404) return "This Artifact was not found or is not visible to you.";
    return error.message;
  }
  return "The API returned an unexpected Artifact detail response.";
}

function getVisibilityError(error: unknown): string {
  if (error instanceof DraftRequestError) {
    if (error.status === 401) return "Your bearer token could not be authenticated. Reload with a valid token and retry.";
    if (error.status === 403) return "Only the Artifact owner can change visibility.";
    if (error.status === 410) return "This Artifact has been tombstoned and cannot be changed.";
    return error.message;
  }
  return "The visibility update failed. Please retry.";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}
