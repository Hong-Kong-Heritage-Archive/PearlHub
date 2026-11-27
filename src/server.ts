import { serve } from "@hono/node-server";
import { MemoryArtifactContentStore } from "./adapters/content-store.js";
import { resolveServerAuthenticationConfig } from "./authentication-config.js";
import { parseDevelopmentCorsOrigins } from "./http/development-cors.js";
import { createPostgresRuntime, requireDatabaseUrl } from "./runtime.js";

const environment = process.env.NODE_ENV ?? "development";
const authentication = resolveServerAuthenticationConfig(process.env);

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
  ...authentication,
  contentStore: new MemoryArtifactContentStore(),
  ...(corsOrigins === undefined ? {} : { corsOrigins }),
});
const server = serve(
  { fetch: runtime.app.fetch, port, hostname: "0.0.0.0" },
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
