"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createArtifact,
  CreateArtifactRequestError,
  type ArtifactVisibility,
  type CreatedArtifact,
} from "../lib/discovery";

type ArtifactField = "name" | "slug" | "visibility";
type FormField = ArtifactField | "token";
type FieldErrors = Partial<Record<FormField, string>>;

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export default function CreateArtifactForm() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [visibility, setVisibility] = useState<ArtifactVisibility>("private");
  const [token, setToken] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [createdArtifact, setCreatedArtifact] = useState<CreatedArtifact | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const requestController = useRef<AbortController | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const slugInput = useRef<HTMLInputElement>(null);
  const tokenInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => requestController.current?.abort(), []);

  function updateField(field: FormField, value: string) {
    if (field === "name") setName(value);
    if (field === "slug") setSlug(value);
    if (field === "visibility") setVisibility(value as ArtifactVisibility);
    if (field === "token") setToken(value);
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
    setFormError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;

    const errors: FieldErrors = {};
    const submittedName = name.trim();
    if (submittedName.length < 1) errors.name = "Enter an Artifact name.";
    else if (submittedName.length > 200) errors.name = "Artifact names can be up to 200 characters.";
    if (!slug) errors.slug = "Enter an Artifact slug.";
    else if (!slugPattern.test(slug)) errors.slug = "Use lowercase letters, numbers, and single hyphens only.";
    if (!["private", "unlisted", "public"].includes(visibility)) {
      errors.visibility = "Choose a supported visibility.";
    }
    if (!token.trim()) errors.token = "Enter a valid bearer token to create an Artifact.";

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setFormError(null);
      if (errors.name) nameInput.current?.focus();
      else if (errors.slug) slugInput.current?.focus();
      else if (errors.visibility) document.getElementById("artifact-visibility")?.focus();
      else tokenInput.current?.focus();
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    const controller = new AbortController();
    requestController.current = controller;

    try {
      const created = await createArtifact(
        { name: submittedName, slug, visibility },
        token,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setCreatedArtifact(created);
      setName("");
      setSlug("");
      setVisibility("private");
      setToken("");
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      if (error instanceof CreateArtifactRequestError && error.field) {
        setFieldErrors({ [error.field]: error.message });
        if (error.field === "name") nameInput.current?.focus();
        else if (error.field === "slug") slugInput.current?.focus();
        else document.getElementById("artifact-visibility")?.focus();
      } else if (error instanceof CreateArtifactRequestError) {
        setFormError(error.message);
      } else if (error instanceof Error && error.message.startsWith("The PearlHub API base URL")) {
        setFormError(error.message);
      } else {
        setFormError("Could not reach the PearlHub API. Check your connection and try again.");
      }
    } finally {
      if (!controller.signal.aborted) {
        submittingRef.current = false;
        setSubmitting(false);
      }
      if (requestController.current === controller) requestController.current = null;
    }
  }

  return (
    <main className="page-shell">
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="PearlHub home">PearlHub</Link>
        <nav className="site-nav" aria-label="Main navigation">
          <Link href="/">Discover</Link>
          <Link className="nav-create-link" href="/create" aria-current="page">Create Artifact</Link>
        </nav>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">PEARLHUB DIRECTORY</p>
        <h1 id="page-title">Create an Artifact</h1>
        <p className="intro-copy">
          Give your Pearl a name and a stable slug. You can choose who can discover it.
        </p>
      </section>

      <section className="create-panel" aria-labelledby="form-title">
        <h2 id="form-title">Artifact details</h2>
        {createdArtifact && (
          <div className="create-success" role="status" aria-live="polite">
            <h3>Artifact created successfully</h3>
            <p>
              The API confirmed creation of <strong>{createdArtifact.name}</strong> ({createdArtifact.slug}).
            </p>
            <dl className="created-details">
              <div><dt>Artifact ID</dt><dd><code>{createdArtifact.id}</code></dd></div>
              <div><dt>Visibility</dt><dd>{createdArtifact.visibility}</dd></div>
              <div><dt>Status</dt><dd>{createdArtifact.status}</dd></div>
            </dl>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setCreatedArtifact(null);
                nameInput.current?.focus();
              }}
            >
              Create another Artifact
            </button>
          </div>
        )}

        {formError && <p className="create-error" role="alert">{formError}</p>}

        <form className="create-form" onSubmit={submit} noValidate>
          <label className="field" htmlFor="artifact-name">
            <span>Name <span className="required-mark">(required)</span></span>
            <input
              ref={nameInput}
              id="artifact-name"
              name="name"
              type="text"
              autoComplete="off"
              required
              maxLength={200}
              value={name}
              placeholder="Example Pearl"
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={fieldErrors.name ? "artifact-name-error" : "artifact-name-help"}
              disabled={submitting}
              onChange={(event) => updateField("name", event.target.value)}
            />
            {fieldErrors.name
              ? <span className="field-error" id="artifact-name-error" role="alert">{fieldErrors.name}</span>
              : <span className="field-help" id="artifact-name-help">1–200 characters; surrounding whitespace is trimmed on submit.</span>}
          </label>

          <label className="field" htmlFor="artifact-slug">
            <span>Slug <span className="required-mark">(required)</span></span>
            <input
              ref={slugInput}
              id="artifact-slug"
              name="slug"
              type="text"
              autoComplete="off"
              required
              spellCheck={false}
              value={slug}
              placeholder="example-pearl"
              aria-invalid={Boolean(fieldErrors.slug)}
              aria-describedby={fieldErrors.slug ? "artifact-slug-error" : "artifact-slug-help"}
              disabled={submitting}
              onChange={(event) => updateField("slug", event.target.value)}
            />
            {fieldErrors.slug
              ? <span className="field-error" id="artifact-slug-error" role="alert">{fieldErrors.slug}</span>
              : <span className="field-help" id="artifact-slug-help">Lowercase letters and numbers separated by single hyphens.</span>}
          </label>

          <label className="field" htmlFor="artifact-visibility">
            <span>Visibility <span className="required-mark">(required)</span></span>
            <select
              id="artifact-visibility"
              name="visibility"
              required
              value={visibility}
              aria-invalid={Boolean(fieldErrors.visibility)}
              aria-describedby={fieldErrors.visibility ? "artifact-visibility-error" : "artifact-visibility-help"}
              disabled={submitting}
              onChange={(event) => updateField("visibility", event.target.value)}
            >
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
            {fieldErrors.visibility
              ? <span className="field-error" id="artifact-visibility-error" role="alert">{fieldErrors.visibility}</span>
              : <span className="field-help" id="artifact-visibility-help">Visibility never overrides server-side access controls.</span>}
          </label>

          <label className="field token-field" htmlFor="artifact-token">
            <span>Developer bearer token <span className="required-mark">(required)</span></span>
            <input
              ref={tokenInput}
              id="artifact-token"
              name="token"
              type="password"
              autoComplete="off"
              required
              value={token}
              aria-invalid={Boolean(fieldErrors.token)}
              aria-describedby={fieldErrors.token ? "artifact-token-error artifact-token-help" : "artifact-token-help"}
              disabled={submitting}
              onChange={(event) => updateField("token", event.target.value)}
            />
            {fieldErrors.token && (
              <span className="field-error" id="artifact-token-error" role="alert">{fieldErrors.token}</span>
            )}
            <span className="field-help" id="artifact-token-help">
              Temporary developer input only. A valid PearlHub API bearer token is required; it is held in memory
              for this page and cleared after successful creation or when you leave.
            </span>
          </label>

          <div className="create-actions">
            <Link className="secondary-button cancel-create" href="/">Back to discovery</Link>
            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? "Creating Artifact…" : "Create Artifact"}
            </button>
          </div>
          {submitting && <p className="submission-status" role="status" aria-live="polite">Submitting Artifact to PearlHub…</p>}
        </form>
      </section>

      <aside className="auth-limitation">
        <h2>Authentication note</h2>
        <p>
          PearlHub does not yet have a production sign-in flow. This temporary token field is not a login system;
          the backend verifies every request and determines the owner.
        </p>
      </aside>
    </main>
  );
}
