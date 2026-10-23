"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { createImportDraft, DraftRequestError, type ArtifactVisibility } from "../lib/drafts";

const maxContentBytes = 1_048_576;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export default function ImportForm() {
  const router = useRouter();
  const pendingRef = useRef(false);
  const [token, setToken] = useState("");
  const [sourceType, setSourceType] = useState<"pasted" | "github">("pasted");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [visibility, setVisibility] = useState<ArtifactVisibility>("private");
  const [content, setContent] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    if (!token.trim()) {
      setError("Enter a developer bearer token to create an Import Draft.");
      return;
    }
    if (!slugPattern.test(slug)) {
      setError("Slug must use lowercase letters and numbers separated by single hyphens.");
      return;
    }
    if (sourceType === "pasted" && new TextEncoder().encode(content).byteLength > maxContentBytes) {
      setError("Pasted content must be no larger than 1 MiB.");
      return;
    }

    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const draft = sourceType === "pasted"
        ? await createImportDraft({ sourceType, name: name.trim(), slug, visibility, content }, token)
        : await createImportDraft({ sourceType, name: name.trim(), slug, visibility, sourceUrl: sourceUrl.trim() }, token);
      router.push(`/draft/${encodeURIComponent(draft.id)}`);
    } catch (caught: unknown) {
      setError(caught instanceof DraftRequestError ? caught.message : "Could not create an Import Draft.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <main className="page-shell">
      <header className="site-header">
        <Link className="wordmark" href="/">PearlHub</Link>
        <nav className="site-nav" aria-label="Main navigation">
          <Link href="/">Discover</Link><Link href="/create">Create Draft</Link><Link href="/import" aria-current="page">Import</Link><Link href="/drafts">My Drafts</Link>
        </nav>
      </header>
      <section className="intro" aria-labelledby="import-title">
        <p className="eyebrow">BRING CONTENT TO PEARLHUB</p>
        <h1 id="import-title">Import to a Draft</h1>
        <p className="intro-copy">Review and edit the imported content in a private Draft before you publish it.</p>
      </section>
      <section className="create-panel" aria-label="Import form">
        <form className="create-form" onSubmit={submit}>
          <label className="field" htmlFor="import-token">
            <span>Developer bearer token <span className="required-mark">(required)</span></span>
            <input id="import-token" type="password" autoComplete="off" value={token} disabled={pending} onChange={(event) => setToken(event.target.value)} />
            <span className="field-help">Temporary in-memory token for the configured API. It is never saved in browser storage and is not a login flow.</span>
          </label>
          <fieldset className="draft-editor-list">
            <legend>Import source</legend>
            <label><input type="radio" name="import-source" value="pasted" checked={sourceType === "pasted"} disabled={pending} onChange={() => setSourceType("pasted")} /> Pasted Markdown/Skill content</label>
            <label><input type="radio" name="import-source" value="github" checked={sourceType === "github"} disabled={pending} onChange={() => setSourceType("github")} /> GitHub raw URL</label>
          </fieldset>
          <label className="field" htmlFor="import-name">
            <span>Artifact name</span>
            <input id="import-name" required maxLength={200} value={name} disabled={pending} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field" htmlFor="import-slug">
            <span>Artifact slug</span>
            <input id="import-slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={slug} disabled={pending} onChange={(event) => setSlug(event.target.value)} />
          </label>
          <label className="field" htmlFor="import-visibility">
            <span>Visibility after publication</span>
            <select id="import-visibility" value={visibility} disabled={pending} onChange={(event) => setVisibility(event.target.value as ArtifactVisibility)}>
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
          </label>
          {sourceType === "pasted" ? (
            <label className="field" htmlFor="import-content">
              <span>Markdown/Skill content</span>
              <textarea id="import-content" required rows={12} maxLength={maxContentBytes} value={content} disabled={pending} onChange={(event) => setContent(event.target.value)} />
              <span className="field-help">Maximum size: 1 MiB. Content is sent unchanged and can be reviewed in the Draft editor.</span>
            </label>
          ) : (
            <label className="field" htmlFor="import-source-url">
              <span>Supported GitHub raw URL</span>
              <input id="import-source-url" type="url" required maxLength={2048} placeholder="https://raw.githubusercontent.com/owner/repo/branch/SKILL.md" value={sourceUrl} disabled={pending} onChange={(event) => setSourceUrl(event.target.value)} />
              <span className="field-help">PearlHub fetches the allowlisted raw.githubusercontent.com source. The returned content is reviewed in the Draft before publication.</span>
            </label>
          )}
          {error && <p className="create-error" role="alert">{error}</p>}
          <button className="primary-button" type="submit" disabled={pending}>{pending ? "Creating Import Draft…" : "Create Import Draft"}</button>
        </form>
      </section>
    </main>
  );
}
