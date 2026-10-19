import { serve } from "@hono/node-server";
import { MemoryArtifactContentStore } from "./adapters/content-store.js";
import { parseDevelopmentCorsOrigins } from "./http/development-cors.js";
import { DevelopmentOnlyFakeAuthenticator } from "./http/testing/development-fake-authenticator.js";
import { createPostgresRuntime, requireDatabaseUrl } from "./runtime.js";

const environment = process.env.NODE_ENV ?? "development";
if (environment === "production") {
  throw new Error("No production authenticator is configured; refusing to start the HTTP server.");
}
if (process.env.PEARLHUB_AUTH_MODE !== "development-fake") {
  throw new Error("Set PEARLHUB_AUTH_MODE=development-fake only for local development.");
}

const userId = process.env.DEV_AUTH_USER_ID;
const token = process.env.DEV_AUTH_TOKEN;
if (!userId || !token) {
  throw new Error("DEV_AUTH_USER_ID and DEV_AUTH_TOKEN are required for development authentication.");
}

const portText = process.env.PORT ?? "8080";
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port number.");
}

const corsOrigins = environment === "development"
  ? parseDevelopmentCorsOrigins(process.env.PEARLHUB_DEV_CORS_ORIGINS)
  : undefined;

const runtime = await createPostgresRuntime({
  databaseUrl: requireDatabaseUrl(),
  authenticator: new DevelopmentOnlyFakeAuthenticator(userId, token),
  contentStore: new MemoryArtifactContentStore(),
  ...(corsOrigins === undefined ? {} : { corsOrigins }),
});
const server = serve(
  { fetch: runtime.app.fetch, port },
  ({ port: boundPort }) => console.log(`PearlHub HTTP server listening on port ${boundPort}.`),
);

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    server.close(async (error) => {
      if (error) {
        console.error("HTTP server shutdown failed.");
        process.exitCode = 1;
      }
      try {
        await runtime.close();
      } catch {
        console.error("PostgreSQL pool shutdown failed.");
        process.exitCode = 1;
      }
    });
  });
}
