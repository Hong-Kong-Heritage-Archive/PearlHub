"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { createDraft, DraftRequestError, getDraft, publishDraft, updateDraft, type Draft, type DraftContent, type DraftInput } from "../lib/drafts";

interface DraftEditorProps {
  draftId?: string;
}

export default function DraftEditor({ draftId }: DraftEditorProps) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [visibility, setVisibility] = useState<DraftInput["visibility"]>("private");
  const [instructions, setInstructions] = useState("");
  const [knowledgeFiles, setKnowledgeFiles] = useState<DraftContent["knowledgeFiles"]>([]);
  const [dependencies, setDependencies] = useState<DraftContent["dependencies"]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  function loadIntoForm(value: Draft) {
    setDraft(value);
    setName(value.name);
    setSlug(value.slug);
    setVisibility(value.visibility);
    setInstructions(value.content.instructions);
    setKnowledgeFiles(value.content.knowledgeFiles);
    setDependencies(value.content.dependencies);
  }

  function currentInput(): DraftInput {
    return { name: name.trim(), slug, visibility, content: { instructions, knowledgeFiles, dependencies } };
  }

  async function perform(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (caught: unknown) {
      if (caught instanceof DraftRequestError && caught.code === "DRAFT_REVISION_CONFLICT") {
        setError("This Draft changed elsewhere. Reload it before saving or publishing.");
      } else if (caught instanceof Error) {
        setError(caught.message);
      } else {
        setError("The request failed. Try again.");
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function loadDraft() {
    if (!draftId) return;
    await perform(async () => {
      const loaded = await getDraft(draftId, token);
      loadIntoForm(loaded);
      setMessage("Draft loaded. It is still unpublished.");
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await perform(async () => {
      if (!token.trim()) throw new Error("Enter a developer bearer token to use the authenticated API.");
      const input = currentInput();
      if (!draft) {
        const created = await createDraft(input, token);
        loadIntoForm(created);
        setMessage("Draft saved. It is not published.");
        return;
      }
      const saved = await updateDraft({ ...input, id: draft.id, revision: draft.revision }, token);
      loadIntoForm(saved);
      setMessage("Draft saved.");
    });
  }

  async function publish() {
    if (!draft) return;
    await perform(async () => {
      const result = await publishDraft(draft, token);
      setMessage(`Published ${result.artifact.name} ${result.version.version}.`);
      router.push(`/artifacts/${encodeURIComponent(result.artifact.id)}/versions/${encodeURIComponent(result.version.version)}`);
    });
  }

  const editingExistingArtifact = draft?.artifactId !== null && draft?.artifactId !== undefined;

  return (
    <main className="page-shell">
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="PearlHub home">PearlHub</Link>
        <nav className="site-nav" aria-label="Main navigation">
          <Link href="/">Discover</Link>
          <Link className="nav-create-link" href="/create" aria-current="page">Create Draft</Link>
          <Link href="/drafts">My Drafts</Link>
        </nav>
      </header>
      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">PEARLHUB CONTENT</p>
        <h1 id="page-title">{draft ? "Edit Draft" : "Create a Draft"}</h1>
        <p className="intro-copy">Drafts are private and unpublished. Publishing creates the complete immutable version in one API request.</p>
      </section>
      <section className="create-panel" aria-labelledby="draft-editor-title">
        <h2 id="draft-editor-title">Draft — not published</h2>
        {draftId && !draft && (
          <div className="create-form">
            <button className="primary-button" type="button" onClick={loadDraft} disabled={busy || !token.trim()}>
              {busy ? "Loading Draft…" : "Load Draft"}
            </button>
          </div>
        )}
        {error && <p className="create-error" role="alert">{error}</p>}
        {message && <p className="create-success" role="status">{message}</p>}
        {draft?.state === "active" && (
          <p className="field-help">
            Saved Draft: <Link href={`/draft/${encodeURIComponent(draft.id)}`}>open this Draft</Link> or <Link href="/drafts">find it in My Drafts</Link>.
          </p>
        )}
        <form className="create-form" onSubmit={submit} noValidate>
          <label className="field" htmlFor="draft-token">
            <span>Developer bearer token <span className="required-mark">(required)</span></span>
            <input id="draft-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy} />
            <span className="field-help">Temporary in-memory token for the configured API. It is never saved in browser storage and is not a login flow.</span>
          </label>
          <label className="field" htmlFor="draft-name">
            <span>Name <span className="required-mark">(required)</span></span>
            <input id="draft-name" required maxLength={200} value={name} disabled={busy || Boolean(editingExistingArtifact)} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field" htmlFor="draft-slug">
            <span>Slug <span className="required-mark">(required)</span></span>
            <input id="draft-slug" required value={slug} disabled={busy || Boolean(editingExistingArtifact)} onChange={(event) => setSlug(event.target.value)} />
          </label>
          <label className="field" htmlFor="draft-visibility">
            <span>Intended visibility</span>
            <select id="draft-visibility" value={visibility} disabled={busy} onChange={(event) => setVisibility(event.target.value as DraftInput["visibility"])}>
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
          </label>
          {editingExistingArtifact && <p className="field-help">This work-copy keeps its Artifact identity: name and slug cannot be changed.</p>}
          <label className="field" htmlFor="draft-instructions">
            <span>Instructions</span>
            <textarea id="draft-instructions" rows={8} value={instructions} disabled={busy} onChange={(event) => setInstructions(event.target.value)} />
          </label>
          <fieldset className="draft-editor-list">
            <legend>Knowledge files</legend>
            {knowledgeFiles.map((file, index) => (
              <div className="draft-editor-item" key={`file-${index}`}>
                <label className="field">
                  <span>Relative path</span>
                  <input value={file.path} disabled={busy} onChange={(event) => setKnowledgeFiles((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, path: event.target.value } : item))} />
                </label>
                <label className="field">
                  <span>File content</span>
                  <textarea rows={5} value={file.content} disabled={busy} onChange={(event) => setKnowledgeFiles((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, content: event.target.value } : item))} />
                </label>
                <button className="secondary-button" type="button" onClick={() => setKnowledgeFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} disabled={busy}>Remove file</button>
              </div>
            ))}
            <button className="secondary-button" type="button" onClick={() => setKnowledgeFiles((current) => [...current, { path: "", content: "" }])} disabled={busy}>Add knowledge file</button>
          </fieldset>
          <fieldset className="draft-editor-list">
            <legend>Dependencies</legend>
            {dependencies.map((dependency, index) => (
              <div className="draft-editor-item" key={`dependency-${index}`}>
                <label className="field">
                  <span>Target Artifact ID</span>
                  <input value={dependency.targetArtifactId} disabled={busy} onChange={(event) => setDependencies((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, targetArtifactId: event.target.value } : item))} />
                </label>
                <label className="field">
                  <span>Declared SemVer range</span>
                  <input value={dependency.declaredRange} placeholder="^2.1.0" disabled={busy} onChange={(event) => setDependencies((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, declaredRange: event.target.value } : item))} />
                </label>
                <button className="secondary-button" type="button" onClick={() => setDependencies((current) => current.filter((_, itemIndex) => itemIndex !== index))} disabled={busy}>Remove dependency</button>
              </div>
            ))}
            <button className="secondary-button" type="button" onClick={() => setDependencies((current) => [...current, { targetArtifactId: "", declaredRange: "" }])} disabled={busy}>Add dependency</button>
          </fieldset>
          <div className="draft-editor-actions">
            <button className="primary-button" type="submit" disabled={busy || (Boolean(draftId) && !draft)}>
              {busy ? "Saving…" : draft ? "Save Draft" : "Create Draft"}
            </button>
            {draft && <button className="secondary-button" type="button" onClick={publish} disabled={busy || draft.state !== "active"}>{busy ? "Publishing…" : "Publish Draft"}</button>}
          </div>
        </form>
        {draft && (
          <details className="draft-preview">
            <summary>Preview Draft content</summary>
            <p><strong>Status:</strong> Draft — not published (revision {draft.revision})</p>
            <p><strong>Name:</strong> {name}</p>
            <p><strong>Slug:</strong> {slug}</p>
            <p><strong>Visibility after publish:</strong> {visibility}</p>
            <h3>Instructions</h3><pre>{instructions}</pre>
            <h3>Knowledge files</h3>{knowledgeFiles.map((file, index) => <section key={`preview-file-${index}`}><h4>{file.path || "(no path)"}</h4><pre>{file.content}</pre></section>)}
            <h3>Dependencies</h3><pre>{JSON.stringify(dependencies, null, 2)}</pre>
          </details>
        )}
        {draft?.baseVersionId && <p className="field-help">Work-copy source version ID: <code>{draft.baseVersionId}</code>. The published source remains unchanged.</p>}
      </section>
    </main>
  );
}
