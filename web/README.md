# PearlHub Thin UI

This isolated `web/` application is a small Next.js 16 App Router + TypeScript client for Artifact discovery and the Draft-to-publish content workflow. Next.js requires Node.js 20.9 or newer; frontend CI currently runs Node.js 26, while backend CI runs Node.js 22. Frontend dependencies and the npm lockfile are kept separate from the backend.

## Local development

Start PostgreSQL and the API from the repository root in one terminal:

```sh
sh scripts/setup-env.sh
set -a && . ./.env && set +a
docker compose up -d postgres
npm install
npm run db:migrate
npm start
```

For an existing or manually migrated database, follow the backend's [development environment guide](../docs/backend/DEV_ENVIRONMENT_SETUP.md) before running migrations.

The backend needs the local development fake-auth variables in `.env` to start. Discovery is anonymous by default; owners can enter a temporary bearer token to include their private Artifacts. This fake authenticator is development-only and is not a PearlHub login flow.

In a second terminal:

```sh
cd web
npm ci
npm run dev
```

Open <http://localhost:3000>. Configure `NEXT_PUBLIC_PEARLHUB_API_BASE_URL` before starting or building the frontend; there is no hard-coded API-host fallback. For the local backend's default port:

```sh
NEXT_PUBLIC_PEARLHUB_API_BASE_URL=http://localhost:8080 npm run dev
```

To use another backend origin, set the same variable to that origin. If it is missing or invalid, API requests show a configuration error instead of silently targeting a local server.

The value is a public API origin/base path, not a credential. In development mode, the backend allows the default frontend origins `http://localhost:3000` and `http://127.0.0.1:3000`. Set `PEARLHUB_DEV_CORS_ORIGINS` in the backend environment to a comma-separated list of exact HTTP(S) origins if your frontend uses another origin. This allowlist is enabled only in development; the UI calls the configured API directly and does not proxy requests.

## Supported features and limitations

- Search by Artifact name or slug, repeated tag filters, sort field/direction, visibility narrowing, and page-size controls.
- Cursor-based “Load more” uses the opaque cursor returned by the API and deduplicates Artifact IDs.
- Loading, empty, validation, network/API error, retry, and discovery-unavailable states.
- Create Draft, find active private Drafts, edit/save with revision conflict handling, private preview, tag/knowledge-file/dependency editing, and one-request Publish are provided through `GET/POST /api/v1/drafts`, `PUT /api/v1/drafts/{draftId}`, and `POST /api/v1/drafts/{draftId}/publish`.
- Published-version lists and immutable version views use `GET /api/v1/artifacts/{artifactId}/versions` and `GET /api/v1/artifacts/{artifactId}/versions/{version}`. A specific selected Version can be Forked into a Draft with permanent lineage on publication, or Cloned into an independent Draft without lineage, using `POST /api/v1/artifacts/{artifactId}/fork` and `POST /api/v1/artifacts/{artifactId}/clone`.
- Published Version views read dependency resolution history and compatibility reports from the corresponding read-only `GET` endpoints. They distinguish `none`, `available`, and `redacted` dependency history, show declared ranges separately from resolved SemVer, and withhold redacted compatibility target IDs and report details. Compatibility reports are community evidence, not a platform guarantee; these reads do not trigger dependency resolution.
- The developer Playground is an **External AI Playground** for a selected immutable Version. It replaces the former single-turn PearlHub composer so Skills can use an external provider's own multi-turn conversation and model-native interaction UI. It loads the source snapshot, uses the authenticated bodyless `POST /api/v1/artifacts/{artifactId}/versions/{version}/dependency-resolutions` endpoint, then fetches each pinned dependency through the access-checked published-Version API. It verifies Version IDs, SemVer values and content hashes before preparing a Launch Package. The package captures the persisted run/manifest, declared ranges, exact resolved Versions, canonical Skill instructions and readable Knowledge content; it is a transient snapshot and is never silently re-resolved during provider hand-off.
- To test, choose Gemini, ChatGPT, Claude or Grok. Claude and Grok use `q` prompt-prefill links; ChatGPT prefill remains disabled (the `prompt` candidate has not passed manual QA), and Gemini has no prefill. Prefill is best-effort provider web-app behavior, not a stable URL API contract. Sign-in redirects may discard URL parameters, so check the provider composer; PearlHub never submits the prompt. The Launch Package is copied on explicit click when it fits the clipboard threshold.
- Provider entry points and current prefill configuration:

  | Provider | Entry point | Candidate parameter | Current status |
  |---|---|---|---|
  | Gemini | [gemini.google.com](https://gemini.google.com/) | None | Plain entry point; no prefill |
  | ChatGPT | [chatgpt.com](https://chatgpt.com/) | `prompt` (never fall back to `q`) | Disabled; not verified |
  | Claude | [claude.ai/new](https://claude.ai/new) | `q` | Enabled after user-reported signed-in manual testing; sign-in-return flow not independently verified |
  | Grok | [grok.com](https://grok.com/) | `q` | Enabled after user-reported signed-in manual testing; sign-in-return flow not independently verified |

- Manual browser observations: **2026-11-16, approximately 23:17 AEDT, Copilot integrated browser; signed out**. ChatGPT's plain entry point loaded, but the `?prompt=` candidate navigation failed (`ERR_FAILED`), so candidate prefill and non-submission are unverified. Claude redirected through sign-in/logout while preserving `q` in the return URL, but no composer was reached. Grok displayed the marker in a draft and an explicit “Send this message?” confirmation; it was not sent. Gemini's plain entry point loaded with an empty composer. At **23:35 AEDT on 2026-11-16**, the user reported signed-in manual testing for Claude and Grok and requested enabling their `q` links; browser/device and detailed outcome observations were not provided. Signed-out → sign-in → return behavior remains unverified for both.
- A prompt URL, if enabled, contains the complete Launch Package and sends it to the external provider; prompt text may be visible in browser history or provider-side logs. Users who prefer not to put package content in a URL should open the plain entry point and use Copy or Download. Pasting also shares included Skill, Knowledge and dependency content with the provider, which handles it under its own policies. Users should only share content they are authorized to send there.
- Knowledge file content is carried as UTF-8 text (`text/plain`); the current published-Version content contract provides file paths and strings, but no source MIME-type field.
- Launch Packages up to **65,536 UTF-8 bytes** are eligible for automatic clipboard transfer. For larger packages, automatic copy is skipped and the UI explicitly reminds users to download the Markdown file, then manually copy and paste its complete contents; the manual Copy Launch Package action remains available. Packages are never truncated, and clipboard/download use the same complete Markdown and manifest. The threshold is a PearlHub hand-off policy, not a provider input limit.
- The **8,192-byte** URL guard remains in the URL builder for any future explicitly enabled prefill adapter. If prefill is re-enabled, URLs over this limit must open the plain entry point and use copy/download instead; the guard is not a provider prompt-size guarantee.
- The package uses the current single-instructions Skill representation and includes direct dependencies only; it does not expand transitive dependencies.
- No Gemini API key or other provider credential is collected by PearlHub for this flow. Optional Gem or Custom GPT setup must be done manually in the provider's own UI; regular chat launch does not create or save those configurations.
- Import supports pasted Markdown/Skill content and a GitHub raw URL through `POST /api/v1/imports/github`; both return an editable Draft and GitHub provenance is shown in the Draft editor.
- The owner can create a work-copy from a selected version.
- The Artifact detail page includes an owner-only visibility editor. It compares `GET /api/v1/me`'s authenticated caller identity with the Artifact's `ownerId`; the API independently enforces owner authorization for `PATCH /api/v1/artifacts/{artifactId}`. The developer bearer token remains temporary, in-memory, and development-only. It is never decoded or persisted by the UI.
- My Drafts supports deleting an unpublished Draft with confirmation. Published-version views support tombstoning an Artifact with confirmation; the backend enforces ownership, preserves history, and makes repeat deletion return `410 ARTIFACT_GONE`.
- Authenticated operations require a bearer token entered into a temporary developer-only password field. The token stays in component memory, is sent only to the configured API URL, and is never persisted in browser storage. It is not a production login flow.
- No production authentication or login flow is available. The developer token field is not a login system; the backend remains responsible for authentication and ownership.
- Direct `POST /api/v1/artifacts` is retired with HTTP 410 so a new Artifact cannot exist without its first version.
- All MVP Drafts and published snapshots are PostgreSQL-backed. Legacy versions created before migration 005 may have no recoverable complete content snapshot because the former content store was in-memory; those versions remain listed in persistence but cannot be read as full content or used for work-copy.
- Visibility and access control remain server-side. Drafts are private to their owner and never appear in discovery.

For local creation with the development-only fake authenticator, enter the `DEV_AUTH_TOKEN` value from your untracked root `.env` file. An optional second development-only identity (`DEV_AUTH_USER_ID_2` and `DEV_AUTH_TOKEN_2`) supports owner/non-owner checks; configure both values and provision that user in the database as described in the backend environment guide. These values are only for local development and are not production credentials. Development CORS permits only the configured frontend origins and does not bypass the API's bearer-token requirement.

## Checks

From this directory, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` run the frontend checks.
