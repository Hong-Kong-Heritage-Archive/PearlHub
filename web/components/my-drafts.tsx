"use client";

import Link from "next/link";
import { useState } from "react";
import { DraftRequestError, listDrafts, type DraftSummary } from "../lib/drafts";

export default function MyDrafts() {
  const [token, setToken] = useState("");
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!token.trim()) {
      setError("Enter a developer bearer token to find your Drafts.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setDrafts(await listDrafts(token));
    } catch (caught: unknown) {
      setError(caught instanceof DraftRequestError ? caught.message : "Could not load your Drafts.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page-shell">
      <header className="site-header">
        <Link className="wordmark" href="/">PearlHub</Link>
        <nav className="site-nav" aria-label="Main navigation">
          <Link href="/">Discover</Link>
          <Link href="/create">Create Draft</Link>
          <Link href="/drafts" aria-current="page">My Drafts</Link>
        </nav>
      </header>
      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">PRIVATE WORKSPACE</p>
        <h1 id="page-title">My Drafts</h1>
        <p className="intro-copy">Find your active, unpublished Drafts. Only Drafts owned by the authenticated account are returned.</p>
      </section>
      <section className="create-panel" aria-labelledby="draft-list-title">
        <h2 id="draft-list-title">Your unpublished Drafts</h2>
        <div className="create-form">
          <label className="field" htmlFor="drafts-token">
            <span>Developer bearer token <span className="required-mark">(required)</span></span>
            <input id="drafts-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} disabled={loading} />
            <span className="field-help">Temporary in-memory token only; it is never saved in browser storage.</span>
          </label>
          <div className="draft-editor-actions">
            <button className="primary-button" type="button" onClick={load} disabled={loading}>
              {loading ? "Loading Drafts…" : "Load My Drafts"}
            </button>
            <Link className="secondary-button draft-create-link" href="/create">Create a Draft</Link>
          </div>
        </div>
        {error && <p className="create-error" role="alert">{error}</p>}
        {drafts?.length === 0 && <p className="empty-drafts" role="status">No active Drafts found for this account.</p>}
        {drafts && drafts.length > 0 && (
          <ul className="my-draft-list" aria-label="Active Drafts">
            {drafts.map((draft) => (
              <li className="my-draft-card" key={draft.id}>
                <div className="my-draft-heading">
                  <div>
                    <h3>{draft.name}</h3>
                    <p className="artifact-slug">{draft.slug}</p>
                  </div>
                  <span className="visibility-badge visibility-private">{draft.visibility}</span>
                </div>
                <p className="my-draft-meta">
                  Revision {draft.revision} · Updated {new Date(draft.updatedAt).toLocaleString()}
                  {draft.baseVersionId ? " · Work-copy" : " · First publication"}
                </p>
                <Link className="secondary-button draft-open-link" href={`/draft/${encodeURIComponent(draft.id)}`}>
                  Open Draft
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
