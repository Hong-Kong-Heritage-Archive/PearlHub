# PearlHub Thin UI

This isolated `web/` application is a small Next.js App Router + TypeScript client for Artifact discovery. It uses the repository's Node 22 baseline. Frontend dependencies and the npm lockfile are kept separate from the backend.

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

The value is a public API origin/base path, not a credential. Configure the backend to allow the frontend origin when the browser runs on a different origin.

## Supported features and limitations

- Search by Artifact name or slug, repeated tag filters, sort field/direction, visibility narrowing, and page-size controls.
- Cursor-based “Load more” uses the opaque cursor returned by the API and deduplicates Artifact IDs.
- Loading, empty, validation, network/API error, retry, and discovery-unavailable states.
- Uses only the documented `GET /api/v1/artifacts` endpoint. Visibility and access control remain entirely server-side.
- No authentication UI or real production login is available in this repository, so discovery is anonymous and Artifact creation is not exposed.
- No detail page, editing, publishing, import, or other Artifact workflows are part of this phase.

## Checks

From this directory, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` run the frontend checks.
