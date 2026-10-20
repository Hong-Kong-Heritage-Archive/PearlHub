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

The backend needs the local development fake-auth variables in `.env` to start, but the discovery page itself makes anonymous requests and does not send a token. This fake authenticator is development-only and is not a PearlHub login flow.

In a second terminal:

```sh
cd web
npm ci
npm run dev
```

Open <http://localhost:3000>. The API base URL defaults to `http://localhost:8080`, matching the backend's `PORT` default. To use another backend origin, set `NEXT_PUBLIC_PEARLHUB_API_BASE_URL` before starting/building the frontend, for example:

```sh
NEXT_PUBLIC_PEARLHUB_API_BASE_URL=http://localhost:8081 npm run dev
```

The value is a public API origin/base path, not a credential. In development mode, the backend allows the default frontend origins `http://localhost:3000` and `http://127.0.0.1:3000`. Set `PEARLHUB_DEV_CORS_ORIGINS` in the backend environment to a comma-separated list of exact HTTP(S) origins if your frontend uses another origin. This allowlist is enabled only in development; the UI calls the configured API directly and does not proxy requests.

## Supported features and limitations

- Search by Artifact name or slug, repeated tag filters, sort field/direction, visibility narrowing, and page-size controls.
- Cursor-based “Load more” uses the opaque cursor returned by the API and deduplicates Artifact IDs.
- Loading, empty, validation, network/API error, retry, and discovery-unavailable states.
- Create Draft, find active private Drafts, edit/save with revision conflict handling, private preview, knowledge-file/dependency editing, and one-request Publish are provided through `GET/POST /api/v1/drafts`, `PUT /api/v1/drafts/{draftId}`, and `POST /api/v1/drafts/{draftId}/publish`.
- Published-version lists and immutable version views use `GET /api/v1/artifacts/{artifactId}/versions` and `GET /api/v1/artifacts/{artifactId}/versions/{version}`. The owner can create a work-copy from a selected version.
- Authenticated operations require a bearer token entered into a temporary developer-only password field. The token stays in component memory, is sent only to the configured API URL, and is never persisted in browser storage. It is not a production login flow.
- No production authentication or login flow is available. The developer token field is not a login system; the backend remains responsible for authentication and ownership.
- Direct `POST /api/v1/artifacts` is retired with HTTP 410 so a new Artifact cannot exist without its first version.
- All MVP Drafts and published snapshots are PostgreSQL-backed. Legacy versions created before migration 005 may have no recoverable complete content snapshot because the former content store was in-memory; those versions remain listed in persistence but cannot be read as full content or used for work-copy.
- Visibility and access control remain server-side. Drafts are private to their owner and never appear in discovery.

For local creation with the development-only fake authenticator, enter the `DEV_AUTH_TOKEN` value from your untracked root `.env` file. This token is for local development only and is not a production credential. Development CORS permits only the configured frontend origins and does not bypass the API's bearer-token requirement.

## Checks

From this directory, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` run the frontend checks.
