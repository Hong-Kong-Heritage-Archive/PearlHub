"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  getPublishedVersion,
  getVersionDependencies,
  resolveVersionDependencies,
  DraftRequestError,
  type ArtifactVersionDependencies,
  type DependencyResolutionRun,
  type PublishedVersion,
} from "../lib/drafts";
import {
  assemblePlaygroundPrompt,
  assertManifestMatchesDeclarations,
  assertResolvedContentMatchesManifest,
  GeminiRequestError,
  PLAYGROUND_GEMINI_MODEL,
  PlaygroundContentError,
  runGeminiTest,
  type GeminiRunResult,
  type ResolvedDependencyContent,
} from "../lib/playground";

interface PlaygroundExecution {
  sourceVersion: string;
  run: DependencyResolutionRun;
  result: GeminiRunResult;
}

export default function Playground({ artifactId, version }: { artifactId: string; version: string }) {
  const requestId = useRef(0);
  const apiKeyRef = useRef("");
  const [token, setToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [userInput, setUserInput] = useState("");
  const [source, setSource] = useState<PublishedVersion | null>(null);
  const [dependencyHistory, setDependencyHistory] = useState<ArtifactVersionDependencies | null>(null);
  const [resolutionRun, setResolutionRun] = useState<DependencyResolutionRun | null>(null);
  const [resolvedDependencies, setResolvedDependencies] = useState<ResolvedDependencyContent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [execution, setExecution] = useState<PlaygroundExecution | null>(null);

  useEffect(() => () => {
    requestId.current += 1;
    apiKeyRef.current = "";
  }, []);

  async function loadSource() {
    if (!token.trim()) {
      setLoadError("Enter the source Artifact owner's developer bearer token to resolve dependencies.");
      return;
    }

    const currentRequestId = ++requestId.current;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    setLoading(true);
    setLoadError(null);
    setRunError(null);
    setSource(null);
    setDependencyHistory(null);
    setResolutionRun(null);
    setResolvedDependencies([]);
    setExecution(null);

    try {
      const [published, history] = await Promise.all([
        getPublishedVersion(artifactId, version, token, controller.signal),
        getVersionDependencies(artifactId, version, token, controller.signal),
      ]);
      if (currentRequestId !== requestId.current) return;
      setSource(published);
      setDependencyHistory(history);

      if (history.dependencies.some((dependency) => dependency.resolutionState === "redacted")) {
        setLoadError("Some prior resolution history is currently redacted. Dependency resolution is blocked until every declared target is readable.");
        return;
      }

      const run = await resolveVersionDependencies(artifactId, version, token, controller.signal);
      if (currentRequestId !== requestId.current) return;
      if (run.sourceArtifactVersionId !== published.version.id) {
        throw new PlaygroundContentError("The resolution run does not belong to the selected source Version.");
      }
      assertManifestMatchesDeclarations(published, run.dependencies);

      const dependencies = await Promise.all(run.dependencies.map(async (manifest) => {
        const target = await getPublishedVersion(
          manifest.targetArtifactId,
          manifest.resolvedVersion,
          token,
          controller.signal,
        );
        assertResolvedContentMatchesManifest(manifest, target);
        return { manifest, published: target };
      }));
      if (currentRequestId !== requestId.current) return;
      setResolutionRun(run);
      setResolvedDependencies(dependencies);
    } catch (error: unknown) {
      if (currentRequestId !== requestId.current) return;
      setLoadError(describeLoadError(error, controller.signal.aborted));
    } finally {
      clearTimeout(timeout);
      if (currentRequestId === requestId.current) setLoading(false);
    }
  }

  async function runTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!source || !resolutionRun || !apiKeyRef.current.trim()) {
      setRunError("Load a complete source and dependency manifest, then enter your Gemini API key.");
      return;
    }
    let prompt: string;
    try {
      prompt = assemblePlaygroundPrompt(source, resolvedDependencies, userInput);
    } catch (error: unknown) {
      setRunError(error instanceof PlaygroundContentError ? error.message : "The Skill content cannot be tested.");
      return;
    }
    setRunning(true);
    setRunError(null);
    setExecution(null);
    try {
      const result = await runGeminiTest(apiKeyRef.current, prompt);
      setExecution({ sourceVersion: source.version.version, run: resolutionRun, result });
    } catch (error: unknown) {
      setRunError(error instanceof GeminiRequestError ? error.message : "Gemini could not complete this test.");
    } finally {
      setRunning(false);
    }
  }

  function updateApiKey(value: string) {
    apiKeyRef.current = value;
    setApiKey(value);
    setExecution(null);
    setRunError(null);
  }

  function clearApiKey() {
    updateApiKey("");
  }

  return (
    <main className="page-shell">
      <header className="site-header">
        <Link className="wordmark" href="/">PearlHub</Link>
        <nav className="site-nav" aria-label="Main navigation">
          <Link href="/">Discover</Link>
          <Link href={`/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(version)}`}>Published Version</Link>
        </nav>
      </header>
      <section className="intro">
        <p className="eyebrow">DEVELOPER THIN UI</p>
        <h1>Playground</h1>
        <p className="intro-copy">A controlled prompt-and-context test harness. It does not execute scripts, tools, or external actions from Pearl content.</p>
      </section>

      <section className="create-panel">
        <h2>Source Version</h2>
        <p>Artifact ID: <code>{artifactId}</code></p>
        <p>Exact Version: <code>{version}</code></p>
        <label className="field" htmlFor="playground-token">
          <span>Developer bearer token</span>
          <input
            id="playground-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <span className="field-help">Dependency resolution requires source write access. This token remains in page memory and is sent only to PearlHub.</span>
        </label>
        <button className="primary-button" type="button" onClick={() => void loadSource()} disabled={loading}>
          {loading ? "Loading source and resolving…" : "Load source and resolve dependencies"}
        </button>
        {loadError && <p className="create-error" role="alert">{loadError}</p>}

        {source && (
          <article className="published-version">
            <h2>{source.artifact.name} ({source.artifact.slug}) — {source.version.version}</h2>
            <h3>Source Skill instructions</h3>
            {source.version.content.instructions.trim()
              ? <pre>{source.version.content.instructions}</pre>
              : <p role="alert">This Artifact Version has empty Skill instructions. Running is disabled.</p>}

            <h3>Source Knowledge files</h3>
            {source.version.content.knowledgeFiles.length
              ? source.version.content.knowledgeFiles.map((file) => (
                <section className="knowledge-file" key={file.path}>
                  <h4>{file.path}</h4>
                  <pre>{file.content}</pre>
                </section>
              ))
              : <p>No source Knowledge files.</p>}

            <h3>Direct dependency declarations</h3>
            {source.version.content.dependencies.length
              ? <ul>{source.version.content.dependencies.map((dependency, index) => {
                const history = dependencyHistory?.dependencies.find((entry) =>
                  entry.targetArtifactId === dependency.targetArtifactId
                  && entry.declaredRange === dependency.declaredRange);
                return (
                  <li key={`${dependency.targetArtifactId}:${dependency.declaredRange}:${index}`}>
                    <p>Declared target: <code>{dependency.targetArtifactId}</code></p>
                    <p>Declared SemVer range: <code>{dependency.declaredRange}</code></p>
                    <p>Prior resolution state: {history?.resolutionState ?? "not loaded"}</p>
                    {history?.resolutionState === "redacted" && <p>Prior resolved versions are withheld.</p>}
                  </li>
                );
              })}</ul>
              : <p>No direct dependencies are declared.</p>}
          </article>
        )}

        {resolutionRun && (
          <section aria-labelledby="resolved-manifest-heading">
            <h2 id="resolved-manifest-heading">Resolved dependency manifest</h2>
            <p>Run: <code>{resolutionRun.runId}</code></p>
            <p>Manifest hash: <code>{resolutionRun.manifestHash}</code></p>
            <p>Resolver policy: <code>{resolutionRun.resolverPolicyVersion}</code></p>
            {resolutionRun.dependencies.length
              ? <ol>{resolvedDependencies.map(({ manifest, published: dependency }) => (
                <li key={manifest.dependencyId}>
                  <p>Declared range: <code>{manifest.declaredRange}</code></p>
                  <p>Resolved Version: <code>{manifest.resolvedVersion}</code></p>
                  <p>Resolved Version ID: <code>{manifest.resolvedArtifactVersionId}</code></p>
                  <p>Resolved content hash: <code>{manifest.resolvedContentHash}</code></p>
                  <h3>Dependency Skill instructions</h3>
                  <pre>{dependency.version.content.instructions}</pre>
                  <h4>Dependency Knowledge files</h4>
                  {dependency.version.content.knowledgeFiles.length
                    ? dependency.version.content.knowledgeFiles.map((file) => (
                      <section className="knowledge-file" key={file.path}>
                        <h5>{file.path}</h5>
                        <pre>{file.content}</pre>
                      </section>
                    ))
                    : <p>No dependency Knowledge files.</p>}
                </li>
              ))}</ol>
              : <p>No direct dependencies; the immutable empty manifest is ready.</p>}
          </section>
        )}

        <form className="create-form" onSubmit={(event) => void runTest(event)}>
          <h2>Test configuration</h2>
          <label className="field" htmlFor="playground-api-key">
            <span>Gemini API key</span>
            <input
              id="playground-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => updateApiKey(event.target.value)}
            />
            <span className="field-help">Your key stays in this page's memory and is sent directly from this browser to Google. PearlHub does not receive or store it. Browser extensions and compromised devices may still access it. Clear it when finished.</span>
          </label>
          {apiKey && <button className="secondary-button" type="button" onClick={clearApiKey}>Clear Gemini API key</button>}
          <label className="field" htmlFor="playground-model">
            <span>Verified Gemini model</span>
            <input id="playground-model" value={PLAYGROUND_GEMINI_MODEL} readOnly />
          </label>
          <label className="field" htmlFor="playground-input">
            <span>Test input</span>
            <textarea id="playground-input" rows={5} value={userInput} onChange={(event) => { setUserInput(event.target.value); setExecution(null); }} />
          </label>
          {!apiKey.trim() && <p className="field-help">A Gemini API key is required to run the test.</p>}
          {runError && <p className="create-error" role="alert">{runError}</p>}
          <button
            className="primary-button"
            type="submit"
            disabled={running || loading || !source || !resolutionRun || !apiKey.trim()
              || !userInput.trim() || !source.version.content.instructions.trim()}
          >
            {running ? "Testing with Gemini…" : "Run Skill test"}
          </button>
        </form>

        {execution && (
          <section className="create-success" aria-labelledby="playground-result-heading">
            <h2 id="playground-result-heading">Gemini response</h2>
            <p>Source Version: <code>{execution.sourceVersion}</code></p>
            <p>Resolution run: <code>{execution.run.runId}</code></p>
            <p>Manifest hash: <code>{execution.run.manifestHash}</code></p>
            <pre>{execution.result.text}</pre>
            <p>Model version: {execution.result.modelVersion ?? "Not returned"}</p>
            <p>Prompt tokens: {execution.result.promptTokenCount ?? "Not returned"}</p>
            <p>Response tokens: {execution.result.responseTokenCount ?? "Not returned"}</p>
          </section>
        )}
      </section>
    </main>
  );
}

function describeLoadError(error: unknown, timedOut: boolean): string {
  if (timedOut) return "Loading the source or dependency content timed out. Check the API connection and try again.";
  if (error instanceof PlaygroundContentError) return error.message;
  if (error instanceof DraftRequestError) {
    if (error.status === 401) return "PearlHub rejected the developer bearer token. Check it and try again.";
    if (error.status === 403) return "Only the source Artifact owner or an authorized writer can resolve dependencies.";
    if (error.status === 404 || error.status === 410) return "The source or a required Artifact Version is not currently available.";
    if (error.status === 409 || error.code === "VERSION_CONTENT_UNAVAILABLE") return "Source or dependency Version content is unavailable; testing is blocked.";
    if (error.code === "DEPENDENCY_RESOLUTION_FAILED") return "A direct dependency could not be resolved or is not currently readable. No target details are disclosed.";
    if (error.status === 0) return "Could not reach PearlHub. Check the API connection and try again.";
  }
  return "Could not load the source Version, resolution manifest, or exact dependency content.";
}
