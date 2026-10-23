"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { createWorkCopy, DraftRequestError, getPublishedVersion, tombstoneArtifact, type PublishedVersion } from "../lib/drafts";

export default function PublishedVersionView({ artifactId, version }: { artifactId: string; version: string }) {
  const router = useRouter();
  const workCopyPending = useRef(false);
  const [token, setToken] = useState("");
  const [published, setPublished] = useState<PublishedVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmingTombstone, setConfirmingTombstone] = useState(false);
  const [tombstoning, setTombstoning] = useState(false);
  const [tombstoned, setTombstoned] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    setTombstoned(false);
    try {
      setPublished(await getPublishedVersion(artifactId, version, token));
    } catch (caught: unknown) {
      setError(caught instanceof DraftRequestError ? caught.message : "Could not load this published version.");
    } finally {
      setLoading(false);
    }
  }

  async function tombstone() {
    if (!token.trim()) {
      setError("Enter the Artifact owner's developer bearer token to tombstone this Artifact.");
      return;
    }
    setTombstoning(true);
    setError(null);
    try {
      await tombstoneArtifact(artifactId, token);
      setPublished(null);
      setConfirmingTombstone(false);
      setTombstoned(true);
    } catch (caught: unknown) {
      setError(caught instanceof DraftRequestError ? caught.message : "Could not tombstone this Artifact.");
    } finally {
      setTombstoning(false);
    }
  }

  async function workCopy() {
    if (workCopyPending.current || tombstoning) return;
    workCopyPending.current = true;
    setLoading(true);
    setError(null);
    try {
      const draft = await createWorkCopy(artifactId, version, token);
      router.push(`/draft/${encodeURIComponent(draft.id)}`);
    } catch (caught: unknown) {
      setError(caught instanceof DraftRequestError ? caught.message : "Could not create a work-copy.");
    } finally {
      workCopyPending.current = false;
      setLoading(false);
    }
  }

  return (
    <main className="page-shell">
      <header className="site-header">
        <Link className="wordmark" href="/">PearlHub</Link>
        <nav className="site-nav" aria-label="Main navigation"><Link href="/">Discover</Link><Link href="/create">Create Draft</Link><Link href="/drafts">My Drafts</Link></nav>
      </header>
      <section className="intro">
        <p className="eyebrow">IMMUTABLE VERSION</p>
        <h1>Published version</h1>
        <p className="intro-copy">Published content is read-only. Create a work-copy to make later edits.</p>
      </section>
      <section className="create-panel">
        <label className="field" htmlFor="version-token">
          <span>Developer bearer token (optional for public Artifacts)</span>
          <input id="version-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
          <span className="field-help">Temporary in-memory token only; no login flow is available.</span>
        </label>
        <button className="primary-button" type="button" onClick={load} disabled={loading || tombstoning}>{loading ? "Loading…" : "Load published version"}</button>
        {error && <p className="create-error" role="alert">{error}</p>}
        {tombstoned && (
          <div className="create-success" role="status">
            <h2>Artifact tombstoned</h2>
            <p>The Artifact is now unlisted and unavailable for normal use. Its published history has been retained.</p>
          </div>
        )}
        {published && (
          <article className="published-version">
            <h2>{published.artifact.name} — {published.version.version}</h2>
            <dl className="created-details">
              <div><dt>Artifact</dt><dd><Link href={`/artifacts/${encodeURIComponent(artifactId)}/versions`}>{published.artifact.slug} versions</Link></dd></div>
              <div><dt>Visibility</dt><dd>{published.artifact.visibility}</dd></div>
              <div><dt>Tags</dt><dd>{published.version.content.tags?.length ? published.version.content.tags.join(", ") : "None"}</dd></div>
              <div><dt>Content hash</dt><dd><code>{published.version.contentHash}</code></dd></div>
              <div><dt>Published</dt><dd>{new Date(published.version.publishedAt).toLocaleString()}</dd></div>
            </dl>
            <h3>Instructions</h3><pre>{published.version.content.instructions}</pre>
            <h3>Knowledge files</h3>
            {published.version.content.knowledgeFiles.map((file) => (
              <section className="knowledge-file" key={file.path}>
                <h4>{file.path}</h4><p><code>{file.contentHash}</code></p><pre>{file.content}</pre>
              </section>
            ))}
            <h3>Dependencies</h3>
            {published.version.content.dependencies.length
              ? <ul>{published.version.content.dependencies.map((dependency) => <li key={`${dependency.targetArtifactId}:${dependency.declaredRange}`}>{dependency.targetArtifactId} {dependency.declaredRange}</li>)}</ul>
              : <p>No dependencies.</p>}
            <button className="secondary-button" type="button" onClick={workCopy} disabled={loading || tombstoning}>Create work-copy from this version</button>
            <div className="artifact-delete-actions">
              <button className="danger-button" type="button" onClick={() => setConfirmingTombstone(true)} disabled={loading || tombstoning}>
                Tombstone Artifact
              </button>
              {confirmingTombstone && (
                <div className="delete-confirmation" role="group" aria-label="Confirm Artifact tombstone">
                  <p>This will make the Artifact unavailable for normal use. Its published history is retained, but this cannot be undone here.</p>
                  <div className="delete-confirmation-actions">
                    <button className="secondary-button" type="button" onClick={() => setConfirmingTombstone(false)} disabled={tombstoning}>
                      Cancel
                    </button>
                    <button className="danger-button" type="button" onClick={() => void tombstone()} disabled={tombstoning}>
                      {tombstoning ? "Tombstoning…" : "Confirm tombstone"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </article>
        )}
      </section>
    </main>
  );
}
