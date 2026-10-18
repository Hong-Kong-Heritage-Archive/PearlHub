"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  DiscoveryRequestError,
  requestArtifacts,
  type ArtifactDiscoveryPage,
  type ArtifactOrder,
  type ArtifactSort,
  type ArtifactSummary,
  type ArtifactVisibility,
  type DiscoveryFilters,
} from "../lib/discovery";

const defaultFilters: DiscoveryFilters = {
  q: "",
  tags: [],
  sort: "createdAt",
  order: "desc",
  limit: 20,
  visibility: "",
};

const tagPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const searchDebounceMs = 250;

interface DiscoveryState {
  items: ArtifactSummary[];
  nextCursor: string | null;
  pageCount: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  unavailable: boolean;
}

const initialState: DiscoveryState = {
  items: [],
  nextCursor: null,
  pageCount: 0,
  loading: true,
  loadingMore: false,
  error: null,
  unavailable: false,
};

export default function ArtifactDiscovery() {
  const [filters, setFilters] = useState(defaultFilters);
  const [state, setState] = useState(initialState);
  const [tagDraft, setTagDraft] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const loadMoreController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({
      items: [],
      nextCursor: null,
      pageCount: 0,
      loading: true,
      loadingMore: false,
      error: null,
      unavailable: false,
    });

    const timeout = window.setTimeout(() => {
      void requestArtifacts(filters, null, controller.signal)
        .then((page) => {
          if (!controller.signal.aborted) setState(makeLoadedState(page));
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setState(makeErrorState(error));
        });
    }, searchDebounceMs);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
      loadMoreController.current?.abort();
      loadMoreController.current = null;
    };
  }, [filters, retryCount]);

  function updateFilters(update: Partial<DiscoveryFilters>) {
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setState((current) => ({
      ...current,
      items: [],
      nextCursor: null,
      pageCount: 0,
      loading: true,
      loadingMore: false,
      error: null,
      unavailable: false,
    }));
    setFilters((current) => ({ ...current, ...update }));
  }

  function addTags(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidates = tagDraft.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
    if (candidates.length === 0) {
      setTagError("Enter one or more tags separated by commas.");
      return;
    }
    if (candidates.some((tag) => tag.length > 50 || !tagPattern.test(tag))) {
      setTagError("Tags must use lowercase letters, numbers, and single hyphens (up to 50 characters).");
      return;
    }
    if (new Set([...filters.tags, ...candidates]).size !== filters.tags.length + candidates.length) {
      setTagError("Each tag can only be added once.");
      return;
    }
    if (filters.tags.length + candidates.length > 10) {
      setTagError("You can filter by at most 10 tags.");
      return;
    }
    setTagError(null);
    setTagDraft("");
    updateFilters({ tags: [...filters.tags, ...candidates] });
  }

  function removeTag(tag: string) {
    setTagError(null);
    updateFilters({ tags: filters.tags.filter((activeTag) => activeTag !== tag) });
  }

  function clearFilters() {
    setTagError(null);
    setTagDraft("");
    updateFilters(defaultFilters);
  }

  async function loadMore() {
    if (!state.nextCursor || state.loadingMore) return;
    const controller = new AbortController();
    loadMoreController.current = controller;
    setState((current) => ({ ...current, loadingMore: true, error: null, unavailable: false }));
    try {
      const page = await requestArtifacts(filters, state.nextCursor, controller.signal);
      if (!controller.signal.aborted) setState((current) => appendPage(current, page));
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        setState((current) => ({
          ...current,
          loadingMore: false,
          error: getErrorMessage(error),
          unavailable: error instanceof DiscoveryRequestError && error.status === 503,
        }));
      }
    } finally {
      if (loadMoreController.current === controller) loadMoreController.current = null;
    }
  }

  return (
    <main className="page-shell">
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="PearlHub home">PearlHub</Link>
        <p>Discover portable, community-built Pearls.</p>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">PEARLHUB DIRECTORY</p>
        <h1 id="page-title">Discover Pearls</h1>
        <p className="intro-copy">
          Search and explore published Artifacts. Visibility and access are always determined by PearlHub.
        </p>
      </section>

      <section className="filter-panel" aria-label="Artifact filters">
        <label className="field search-field">
          <span>Search by name or slug</span>
          <input
            type="search"
            value={filters.q}
            maxLength={100}
            placeholder="Try “research assistant”"
            onChange={(event) => updateFilters({ q: event.target.value })}
          />
        </label>

        <form className="tag-form" onSubmit={addTags} noValidate>
          <label className="field" htmlFor="tag-filter">
            <span>Filter by tags</span>
            <input
              id="tag-filter"
              value={tagDraft}
              maxLength={510}
              placeholder="rag, language-model"
              aria-describedby={tagError ? "tag-error tag-help" : "tag-help"}
              aria-invalid={tagError !== null}
              onChange={(event) => {
                setTagDraft(event.target.value);
                setTagError(null);
              }}
            />
          </label>
          <button className="secondary-button add-tag-button" type="submit">Add tags</button>
          <p className="field-help" id="tag-help">Comma-separated; up to 10 lowercase kebab-case tags.</p>
          {tagError && <p className="field-error" id="tag-error" role="alert">{tagError}</p>}
          {filters.tags.length > 0 && (
            <ul className="tag-list" aria-label="Selected tags">
              {filters.tags.map((tag) => (
                <li className="tag-chip" key={tag}>
                  <span>{tag}</span>
                  <button type="button" aria-label={`Remove ${tag} tag`} onClick={() => removeTag(tag)}>×</button>
                </li>
              ))}
            </ul>
          )}
        </form>

        <div className="select-grid">
          <label className="field" htmlFor="sort-filter">
            <span>Sort by</span>
            <select
              id="sort-filter"
              value={filters.sort}
              onChange={(event) => updateFilters({ sort: event.target.value as ArtifactSort })}
            >
              <option value="createdAt">Date created</option>
              <option value="updatedAt">Date updated</option>
              <option value="name">Name</option>
            </select>
          </label>
          <label className="field" htmlFor="order-filter">
            <span>Direction</span>
            <select
              id="order-filter"
              value={filters.order}
              onChange={(event) => updateFilters({ order: event.target.value as ArtifactOrder })}
            >
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </select>
          </label>
          <label className="field" htmlFor="limit-filter">
            <span>Per page</span>
            <select
              id="limit-filter"
              value={filters.limit}
              onChange={(event) => updateFilters({ limit: Number(event.target.value) })}
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
          <label className="field" htmlFor="visibility-filter">
            <span>Visibility filter</span>
            <select
              id="visibility-filter"
              value={filters.visibility}
              onChange={(event) => updateFilters({
                visibility: event.target.value as ArtifactVisibility | "",
              })}
            >
              <option value="">Default access</option>
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
            </select>
          </label>
        </div>
        <p className="field-help visibility-help">
          Filters only narrow what the API allows you to see; they never grant access.
        </p>
        <div className="filter-actions">
          <button className="secondary-button" type="button" onClick={clearFilters}>Clear filters</button>
        </div>
      </section>

      <section className="results-section" aria-labelledby="results-title">
        <div className="results-heading">
          <div>
            <p className="eyebrow">THE DIRECTORY</p>
            <h2 id="results-title">Artifacts</h2>
          </div>
          {!state.loading && !state.error && (
            <p className="result-count" aria-live="polite">
              Showing {state.pageCount} {state.pageCount === 1 ? "Artifact" : "Artifacts"} in this API page
            </p>
          )}
        </div>

        {state.loading && (
          <p className="status-panel" role="status" aria-live="polite">Loading Artifacts…</p>
        )}
        {!state.loading && state.error && state.items.length === 0 && (
          <div className="status-panel error-panel" role="alert">
            <h3>{state.unavailable ? "Discovery is temporarily unavailable" : "We couldn’t load Artifacts"}</h3>
            <p>{state.error}</p>
            <button className="secondary-button" type="button" onClick={() => setRetryCount((count) => count + 1)}>
              Try again
            </button>
          </div>
        )}
        {!state.loading && !state.error && state.items.length === 0 && (
          <div className="status-panel empty-panel">
            <h3>No Artifacts found</h3>
            <p>Try a different search or clear your filters.</p>
          </div>
        )}
        {!state.loading && state.items.length > 0 && (
          <ul className="artifact-list" aria-label="Artifact results">
            {state.items.map((artifact) => <ArtifactCard artifact={artifact} key={artifact.id} />)}
          </ul>
        )}
        {state.error && state.items.length > 0 && (
          <p className="inline-error" role="alert">{state.error}</p>
        )}
        {state.nextCursor && !state.loading && (
          <div className="load-more-wrap">
            <button
              className="load-more-button"
              type="button"
              onClick={() => void loadMore()}
              disabled={state.loadingMore}
            >
              {state.loadingMore
                ? "Loading more…"
                : state.error && state.items.length > 0 ? "Retry loading more" : "Load more"}
            </button>
          </div>
        )}
      </section>

      <footer className="site-footer">
        <p>Anonymous discovery is available. Sign-in and Artifact creation are not part of this preview.</p>
      </footer>
    </main>
  );
}

function ArtifactCard({ artifact }: { artifact: ArtifactSummary }) {
  return (
    <li className="artifact-card">
      <div className="card-topline">
        <p className="artifact-slug">{artifact.slug}</p>
        <span className={`visibility-badge visibility-${artifact.visibility}`}>
          {artifact.visibility}
        </span>
      </div>
      <h3>{artifact.name}</h3>
      {artifact.tags.length > 0
        ? <ul className="card-tags" aria-label={`${artifact.name} tags`}>{artifact.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>
        : <p className="no-tags">No tags</p>}
      <dl className="artifact-dates">
        <div>
          <dt>Created</dt>
          <dd><time dateTime={artifact.createdAt} title={artifact.createdAt}>{formatDate(artifact.createdAt)}</time></dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd><time dateTime={artifact.updatedAt} title={artifact.updatedAt}>{formatDate(artifact.updatedAt)}</time></dd>
        </div>
      </dl>
    </li>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function makeLoadedState(page: ArtifactDiscoveryPage): DiscoveryState {
  return {
    items: deduplicate(page.items),
    nextCursor: page.nextCursor,
    pageCount: page.items.length,
    loading: false,
    loadingMore: false,
    error: null,
    unavailable: false,
  };
}

function appendPage(current: DiscoveryState, page: ArtifactDiscoveryPage): DiscoveryState {
  return {
    ...current,
    items: deduplicate([...current.items, ...page.items]),
    nextCursor: page.nextCursor,
    pageCount: page.items.length,
    loadingMore: false,
    error: null,
    unavailable: false,
  };
}

function deduplicate(items: ArtifactSummary[]): ArtifactSummary[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function makeErrorState(error: unknown): DiscoveryState {
  return {
    items: [],
    nextCursor: null,
    pageCount: 0,
    loading: false,
    loadingMore: false,
    error: getErrorMessage(error),
    unavailable: error instanceof DiscoveryRequestError && error.status === 503,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof DiscoveryRequestError) return error.message;
  if (error instanceof Error && error.message === "The discovery response has an unexpected format.") {
    return error.message;
  }
  return "Unable to load Artifacts. Please try again.";
}
