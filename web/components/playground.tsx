"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  getPublishedVersion,
  getVersionDependencies,
  resolveVersionDependencies,
  DraftRequestError,
  type ArtifactVersionDependencies,
  type PublishedVersion,
} from "../lib/drafts";
import {
  buildLaunchPackage,
  buildProviderLaunchTarget,
  EXTERNAL_AI_PROVIDERS,
  LAUNCH_PACKAGE_CLIPBOARD_MAX_BYTES,
  launchPackageSizeInBytes,
  LaunchPackageError,
  makeLaunchPackageFilename,
  PROVIDER_PREFILL_MAX_URL_BYTES,
  serializeLaunchPackageMarkdown,
  type ExternalAIProvider,
  type LaunchPackage,
} from "../lib/external-playground";

interface PreparedLaunch {
  launchPackage: LaunchPackage;
  markdown: string;
  sizeBytes: number;
}

interface HandoffMessage {
  kind: "status" | "error";
  text: string;
}

export default function Playground({ artifactId, version }: { artifactId: string; version: string }) {
  const requestId = useRef(0);
  const [token, setToken] = useState("");
  const [source, setSource] = useState<PublishedVersion | null>(null);
  const [dependencyHistory, setDependencyHistory] = useState<ArtifactVersionDependencies | null>(null);
  const [prepared, setPrepared] = useState<PreparedLaunch | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [handoffMessage, setHandoffMessage] = useState<HandoffMessage | null>(null);

  useEffect(() => () => {
    requestId.current += 1;
  }, []);

  async function prepareLaunchPackage() {
    if (!token.trim()) {
      setLoadError("Enter the source Artifact owner's developer bearer token to resolve dependencies.");
      return;
    }

    const currentRequestId = ++requestId.current;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    setLoading(true);
    setLoadError(null);
    setHandoffMessage(null);
    setSource(null);
    setDependencyHistory(null);
    setPrepared(null);

    try {
      const [published, history] = await Promise.all([
        getPublishedVersion(artifactId, version, token, controller.signal),
        getVersionDependencies(artifactId, version, token, controller.signal),
      ]);
      if (currentRequestId !== requestId.current) return;
      setSource(published);
      setDependencyHistory(history);

      if (history.dependencies.some((dependency) => dependency.resolutionState === "redacted")) {
        setLoadError("Dependency resolution is unavailable because prior dependency access is redacted. No Launch Package was prepared.");
        return;
      }

      const resolution = await resolveVersionDependencies(artifactId, version, token, controller.signal);
      if (currentRequestId !== requestId.current) return;
      const resolvedDependencies = await Promise.all(resolution.dependencies.map(async (manifest) => ({
        manifest,
        published: await getPublishedVersion(
          manifest.targetArtifactId,
          manifest.resolvedVersion,
          token,
          controller.signal,
        ),
      })));
      if (currentRequestId !== requestId.current) return;

      const launchPackage = buildLaunchPackage(published, resolution, resolvedDependencies);
      const markdown = serializeLaunchPackageMarkdown(launchPackage);
      setPrepared({ launchPackage, markdown, sizeBytes: launchPackageSizeInBytes(markdown) });
    } catch (error: unknown) {
      if (currentRequestId !== requestId.current) return;
      setLoadError(describeLoadError(error, controller.signal.aborted));
    } finally {
      clearTimeout(timeout);
      if (currentRequestId === requestId.current) setLoading(false);
    }
  }

  function launchProvider(provider: ExternalAIProvider) {
    if (!prepared) return;

    const adapter = EXTERNAL_AI_PROVIDERS[provider];
    const target = buildProviderLaunchTarget(provider, prepared.markdown);
    const supportsPrefill = "prefillParameter" in adapter;
    window.open(target.url, "_blank", "noopener,noreferrer");

    if (prepared.sizeBytes > LAUNCH_PACKAGE_CLIPBOARD_MAX_BYTES) {
      const prefillMessage = target.promptPrefilled
        ? `${adapter.name} should open with the prompt prefilled; PearlHub does not submit it. `
        : supportsPrefill
          ? `${adapter.name} opened without prefill because the package exceeds PearlHub's ${PROVIDER_PREFILL_MAX_URL_BYTES.toLocaleString()}-byte URL limit. `
          : `${adapter.name} should open in a new tab. `;
      setHandoffMessage({
        kind: "status",
        text: `${prefillMessage}Automatic clipboard copy was skipped because the package exceeds the ${LAUNCH_PACKAGE_CLIPBOARD_MAX_BYTES.toLocaleString()}-byte clipboard threshold. Download it, then manually copy and paste its full contents, or try Copy Launch Package.`,
      });
      return;
    }

    const copySuccessMessage = target.promptPrefilled
      ? `${adapter.name} should open with the Launch Package prefilled. PearlHub does not submit it; the package is also copied as a fallback.`
      : supportsPrefill
        ? `${adapter.name} opened without prefill because the package exceeds PearlHub's ${PROVIDER_PREFILL_MAX_URL_BYTES.toLocaleString()}-byte URL limit. Launch Package copied; paste it into the new chat and start testing.`
        : `${adapter.name} should open in a new tab. Launch Package copied; paste it into the provider chat and start testing.`;
    void copyLaunchPackage(copySuccessMessage);
  }

  async function copyLaunchPackage(
    successMessage = "Launch Package copied. Switch to the provider tab, paste it into a regular conversation, and start testing. PearlHub does not submit it for you.",
  ) {
    if (!prepared) return;
    try {
      if (typeof navigator.clipboard?.writeText !== "function") {
        throw new Error("Clipboard access is unavailable in this browser.");
      }
      await navigator.clipboard.writeText(prepared.markdown);
      setHandoffMessage({
        kind: "status",
        text: successMessage,
      });
    } catch {
      setHandoffMessage({
        kind: "error",
        text: "Clipboard access failed. The complete Launch Package remains visible below for manual selection and copying.",
      });
    }
  }

  function downloadLaunchPackage() {
    if (!prepared || !source) return;
    let objectUrl: string | null = null;
    try {
      objectUrl = URL.createObjectURL(new Blob([prepared.markdown], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = makeLaunchPackageFilename(source);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }, 0);
      setHandoffMessage({ kind: "status", text: "Launch Package download started. Confirm the file in your browser's download list." });
    } catch {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setHandoffMessage({ kind: "error", text: "The Launch Package download could not be started. Use Copy Launch Package or manually copy the visible package." });
    }
  }

  const largePackage = prepared !== null && prepared.sizeBytes > LAUNCH_PACKAGE_CLIPBOARD_MAX_BYTES;

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
        <h1>External AI Playground</h1>
        <p className="intro-copy">Prepare a portable, version-pinned Launch Package and continue testing in the selected provider's own conversation experience. PearlHub does not submit prompts, automate provider pages, or execute Skill code.</p>
      </section>

      <section className="create-panel">
        <h2>Selected Artifact Version</h2>
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
          <span className="field-help">Used only with PearlHub's access-checked API to load this Version and resolve its direct dependencies. It is not included in the Launch Package.</span>
        </label>
        <button className="primary-button" type="button" onClick={() => void prepareLaunchPackage()} disabled={loading}>
          {loading ? "Preparing Launch Package…" : "Prepare Launch Package"}
        </button>
        <p role="status" aria-live="polite">
          {loading ? "Preparing the version-pinned Launch Package."
            : prepared ? "Launch Package ready."
              : "No complete Launch Package is prepared."}
        </p>
        {loadError && <p className="create-error" role="alert">{loadError}</p>}

        {source && (
          <article className="published-version">
            <h2>{source.artifact.name} ({source.artifact.slug}) — {source.version.version}</h2>
            <p>Selected Skill: <strong>{source.artifact.name}</strong> (this Artifact Version uses the current single-instructions Skill representation).</p>
            <h3>Canonical Skill instructions</h3>
            <pre>{source.version.content.instructions || "Skill instructions are empty; a Launch Package cannot be prepared."}</pre>
            <h3>Source Knowledge files ({source.version.content.knowledgeFiles.length})</h3>
            {source.version.content.knowledgeFiles.length
              ? <ul>{source.version.content.knowledgeFiles.map((file) => <li key={file.path}>{file.path}</li>)}</ul>
              : <p>No source Knowledge files.</p>}
            <h3>Direct dependency declarations ({source.version.content.dependencies.length})</h3>
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

        {prepared && (
          <section aria-labelledby="launch-package-heading">
            <h2 id="launch-package-heading">Launch Package ready</h2>
            <p>Skill: <strong>{prepared.launchPackage.manifest.source.skillName}</strong></p>
            <p>Knowledge files: {prepared.launchPackage.knowledgeFiles.length
              + prepared.launchPackage.dependencies.reduce((count, dependency) => count + dependency.knowledgeFiles.length, 0)}</p>
            <p>Direct dependencies: {prepared.launchPackage.manifest.resolution.dependencies.length}</p>
            <p>Resolution run: <code>{prepared.launchPackage.manifest.resolution.runId}</code></p>
            <p>Manifest hash: <code>{prepared.launchPackage.manifest.resolution.manifestHash}</code></p>
            {prepared.launchPackage.manifest.resolution.dependencies.length
              ? <ol>{prepared.launchPackage.manifest.resolution.dependencies.map((dependency) => (
                <li key={dependency.dependencyId}>
                  <p>Declared range: <code>{dependency.declaredRange}</code></p>
                  <p>Resolved Artifact Version ID: <code>{dependency.resolvedArtifactVersionId}</code></p>
                  <p>Exact resolved version: <code>{dependency.resolvedVersion}</code></p>
                </li>
              ))}</ol>
              : <p>No dependencies are declared; the exact empty resolution manifest is included.</p>}
            <p>Launch Package size: {prepared.sizeBytes.toLocaleString()} bytes.</p>
            {largePackage && (
              <p className="field-error" role="alert">
                This package exceeds the {LAUNCH_PACKAGE_CLIPBOARD_MAX_BYTES.toLocaleString()}-byte clipboard threshold, so automatic clipboard copy is skipped. Download it, then manually copy and paste the complete contents into the provider chat, or try Copy Launch Package. Nothing is truncated.
              </p>
            )}

            <h3>Choose an external provider</h3>
            <div className="create-actions">
              <button className="primary-button" type="button" onClick={() => launchProvider("gemini")}>Launch in Gemini</button>
              <button className="primary-button" type="button" onClick={() => launchProvider("chatgpt")}>Launch in ChatGPT</button>
              <button className="primary-button" type="button" onClick={() => launchProvider("claude")}>Launch in Claude</button>
              <button className="primary-button" type="button" onClick={() => launchProvider("grok")}>Launch in Grok</button>
              <button className="secondary-button" type="button" onClick={() => void copyLaunchPackage()}>Copy Launch Package</button>
              <button className="secondary-button" type="button" onClick={downloadLaunchPackage}>Download Launch Package</button>
            </div>
            <p>
              If a provider tab was blocked, open it directly:
              {" "}<a href={EXTERNAL_AI_PROVIDERS.gemini.entryPoint} target="_blank" rel="noopener noreferrer">Gemini</a>
              {" "}<a href={EXTERNAL_AI_PROVIDERS.chatgpt.entryPoint} target="_blank" rel="noopener noreferrer">ChatGPT</a>
              {" "}<a href={EXTERNAL_AI_PROVIDERS.claude.entryPoint} target="_blank" rel="noopener noreferrer">Claude</a>
              {" "}<a href={EXTERNAL_AI_PROVIDERS.grok.entryPoint} target="_blank" rel="noopener noreferrer">Grok</a>
            </p>
            {handoffMessage && (
              <p className={handoffMessage.kind === "error" ? "create-error" : "field-help"}
                role={handoffMessage.kind === "error" ? "alert" : "status"}>
                {handoffMessage.text}
              </p>
            )}
            <p className="field-help">
              ChatGPT, Claude, and Grok use prompt-prefill URLs when the full URL is within PearlHub's {PROVIDER_PREFILL_MAX_URL_BYTES.toLocaleString()}-byte limit. Actual prefill depends on provider sign-in and input behavior. Larger URLs open a regular chat without prefill; the package is copied when it fits the clipboard threshold, otherwise download and manually paste it. Gemini opens without prefill. PearlHub never submits the prompt. Gemini Gem setup is optional and must be done manually; ChatGPT launch opens a regular chat and does not create a Custom GPT.
            </p>
            <p className="field-help">
              Prefill URLs contain the complete Launch Package and send it to the external provider; the prompt may be visible in browser history or provider-side logs. Pasting also shares all included Skill, Knowledge, and dependency content with that provider, which handles it under its own policies. Only share content you are authorized to send there.
            </p>
            <label className="field" htmlFor="launch-package-content">
              <span>Complete Launch Package (manual copy fallback)</span>
              <textarea
                id="launch-package-content"
                rows={14}
                readOnly
                value={prepared.markdown}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
          </section>
        )}
      </section>
    </main>
  );
}

function describeLoadError(error: unknown, timedOut: boolean): string {
  if (timedOut) return "Loading the source or dependency content timed out. Check the API connection and try again.";
  if (error instanceof LaunchPackageError) return `${error.message} No Launch Package was prepared.`;
  if (error instanceof DraftRequestError) {
    if (error.status === 401) return "PearlHub rejected the developer bearer token. Check it and try again.";
    if (error.status === 403) return "Only the source Artifact owner or an authorized writer can resolve dependencies.";
    if (error.status === 404 || error.status === 410) return "The source or a required Artifact Version is not currently available.";
    if (error.status === 409 || error.code === "VERSION_CONTENT_UNAVAILABLE") return "Source or dependency Version content is unavailable; package preparation is blocked.";
    if (error.code === "DEPENDENCY_RESOLUTION_FAILED") return "A direct dependency could not be resolved or is not currently readable. No target details are disclosed and no Launch Package was prepared.";
    if (error.status === 0) return "Could not reach PearlHub. Check the API connection and try again.";
  }
  return "Could not load the source Version, resolution manifest, or exact dependency content.";
}
