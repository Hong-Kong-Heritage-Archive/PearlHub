"use client";

import Link from "next/link";
import { useState } from "react";
import { DraftRequestError, listVersions, type PublishedVersion } from "../lib/drafts";

export default function ArtifactVersions({ artifactId }: { artifactId: string }) {
  const [versions, setVersions] = useState<PublishedVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setVersions(await listVersions(artifactId));
    } catch (caught: unknown) {
      setError(caught instanceof DraftRequestError ? caught.message : "Could not load published versions.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page-shell">
      <header className="site-header">
        <Link className="wordmark" href="/">PearlHub</Link>
        <nav className="site-nav" aria-label="Main navigation"><Link href="/">Discover</Link><Link href="/create">Create Draft</Link><Link href="/import">Import</Link><Link href="/drafts">My Drafts</Link></nav>
      </header>
      <section className="intro">
        <p className="eyebrow">IMMUTABLE CONTENT</p>
        <h1>Published versions</h1>
        <p className="intro-copy">Only published versions appear here. Drafts remain private to their owner.</p>
      </section>
      <section className="create-panel">
        <p className="field-help">Sign in above to include Artifacts that are private to your account.</p>
        <button className="primary-button" type="button" onClick={load} disabled={loading}>{loading ? "Loading…" : "Load versions"}</button>
        {error && <p className="create-error" role="alert">{error}</p>}
        {versions && versions.length === 0 && <p role="status">No published versions yet.</p>}
        {versions && versions.length > 0 && (
          <ul className="version-list">
            {versions.map(({ version, artifact }) => (
              <li key={version.id}>
                <Link href={`/artifacts/${encodeURIComponent(artifact.id)}/versions/${encodeURIComponent(version.version)}`}>
                  {artifact.name} — {version.version}
                </Link>
                <span>Published {new Date(version.publishedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
