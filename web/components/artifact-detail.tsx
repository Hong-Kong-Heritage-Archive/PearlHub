"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  DraftRequestError,
  getArtifact,
  getArtifactLineage,
  type ArtifactLineage,
  type ArtifactMetadata,
} from "../lib/drafts";

interface DetailState {
  artifact: ArtifactMetadata | null;
  lineage: ArtifactLineage | null;
  error: string | null;
  loading: boolean;
}

const initialState: DetailState = {
  artifact: null,
  lineage: null,
  error: null,
  loading: true,
};

export default function ArtifactDetail({ artifactId }: { artifactId: string }) {
  const [tokenInput, setTokenInput] = useState("");
  const [token, setToken] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const [state, setState] = useState(initialState);

  useEffect(() => {
    const controller = new AbortController();
    setState({ artifact: null, lineage: null, error: null, loading: true });
    void Promise.all([
      getArtifact(artifactId, token, controller.signal),
      getArtifactLineage(artifactId, token, controller.signal),
    ]).then(([artifact, lineage]) => {
      if (!controller.signal.aborted) setState({ artifact, lineage, error: null, loading: false });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setState({
        artifact: null,
        lineage: null,
        error: getDetailError(error),
        loading: false,
      });
    });
    return () => controller.abort();
  }, [artifactId, retryCount, token]);

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
            onChange={(event) => setTokenInput(event.target.value)}
          />
          <span className="field-help">Temporary in-memory token only; no login flow is available.</span>
        </label>
        <button
          className="secondary-button"
          type="button"
          disabled={state.loading}
          onClick={() => setToken(tokenInput.trim())}
        >
          Load with token
        </button>
      </section>

      {state.loading && <p className="status-panel" role="status">Loading Artifact details…</p>}
      {!state.loading && state.error && (
        <section className="status-panel error-panel" role="alert">
          <h2>Unable to load this Artifact</h2>
          <p>{state.error}</p>
          <button className="secondary-button" type="button" onClick={() => setRetryCount((count) => count + 1)}>
            Try again
          </button>
        </section>
      )}
      {!state.loading && state.artifact && state.lineage && (
        <>
          <section className="create-panel" aria-labelledby="artifact-metadata-title">
            <h2 id="artifact-metadata-title">Artifact metadata</h2>
            <dl className="artifact-dates">
              <div><dt>Slug</dt><dd>{state.artifact.slug}</dd></div>
              <div><dt>Owner</dt><dd>{state.artifact.ownerId}</dd></div>
              <div><dt>Visibility</dt><dd>{state.artifact.visibility}</dd></div>
              <div><dt>Status</dt><dd>{state.artifact.status}</dd></div>
              <div><dt>Created</dt><dd><time dateTime={state.artifact.createdAt}>{formatDate(state.artifact.createdAt)}</time></dd></div>
              <div><dt>Updated</dt><dd><time dateTime={state.artifact.updatedAt}>{formatDate(state.artifact.updatedAt)}</time></dd></div>
            </dl>
            <Link className="secondary-button" href={`/artifacts/${encodeURIComponent(state.artifact.id)}/versions`}>
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

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}
