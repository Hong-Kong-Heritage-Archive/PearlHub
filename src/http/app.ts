import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { ListArtifactsService } from "../application/discovery.js";
import type { CreateArtifactUseCase } from "../application/services.js";
import { parseArtifactDiscoveryQuery } from "../contracts/discovery.js";
import { toArtifactDiscoveryResponse, toArtifactResponse } from "../contracts/dto.js";
import { DomainError } from "../domain/errors.js";
import type { AuthenticatedPrincipal, Authenticator } from "./authentication.js";
import { mapHttpError } from "./error-mapping.js";

const artifactSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const createArtifactBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().regex(artifactSlugPattern),
  visibility: z.enum(["private", "unlisted", "public"]),
}).strict().openapi("CreateArtifactRequest");

const artifactResponseSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  slug: z.string(),
  visibility: z.enum(["private", "unlisted", "public"]),
  status: z.enum(["active", "tombstone"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).openapi("Artifact");

const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
  }),
}).openapi("ApiError");

const artifactSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  visibility: z.enum(["private", "unlisted", "public"]),
  tags: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).openapi("ArtifactSummary");

const artifactDiscoveryResponseSchema = z.object({
  items: z.array(artifactSummarySchema),
  nextCursor: z.string().nullable(),
}).openapi("ArtifactDiscoveryPage");

const discoveryQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  tag: z.union([z.string(), z.array(z.string())]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(1024).optional(),
  sort: z.enum(["createdAt", "updatedAt", "name"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  visibility: z.enum(["public", "private", "unlisted"]).optional(),
}).strict();

const listArtifactsRoute = createRoute({
  method: "get",
  path: "/api/v1/artifacts",
  tags: ["Artifacts"],
  summary: "Discover Artifacts",
  description: "Lists active Artifacts visible to the caller, with optional text and tag filters.",
  security: [{}, { BearerAuth: [] }],
  request: { query: discoveryQuerySchema },
  responses: {
    200: {
      description: "Artifacts matching the discovery filters.",
      content: { "application/json": { schema: artifactDiscoveryResponseSchema } },
    },
    400: {
      description: "Malformed or invalid query parameters.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    500: {
      description: "Unexpected internal error.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    503: {
      description: "Discovery is unavailable until its index has been built.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

const createArtifactRoute = createRoute({
  method: "post",
  path: "/api/v1/artifacts",
  tags: ["Artifacts"],
  summary: "Create an Artifact",
  description: "Creates an Artifact owned by the authenticated internal user.",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: createArtifactBodySchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Artifact created.",
      content: { "application/json": { schema: artifactResponseSchema } },
    },
    400: {
      description: "Malformed or invalid request.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    401: {
      description: "Authentication is required.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    409: {
      description: "The owner already has an Artifact with this slug.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    500: {
      description: "Unexpected internal error.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

type HttpEnvironment = {
  Variables: {
    principal: AuthenticatedPrincipal;
  };
};

export interface HttpAppDependencies {
  createArtifact: CreateArtifactUseCase;
  listArtifacts: Pick<ListArtifactsService, "execute">;
  authenticator: Authenticator;
  corsOrigins?: string[];
}

export function createHttpApp(dependencies: HttpAppDependencies) {
  const app = new OpenAPIHono<HttpEnvironment>({
    defaultHook: (result) => {
      if (!result.success) {
        throw new DomainError("INVALID_REQUEST", "Request body is invalid.");
      }
    },
  });

  if (dependencies.corsOrigins !== undefined) {
    app.use("/api/*", cors({
      origin: dependencies.corsOrigins,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      maxAge: 600,
    }));
  }

  app.use("/api/v1/artifacts", async (context, next) => {
    if (context.req.method !== "POST") {
      await next();
      return;
    }
    const principal = await dependencies.authenticator.authenticate(context.req.raw.headers);
    if (!principal) {
      throw new DomainError("UNAUTHENTICATED", "Authentication is required.");
    }
    context.set("principal", principal);

    if (!context.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new DomainError("INVALID_REQUEST", "Content-Type must be application/json.");
    }
    try {
      await context.req.raw.clone().json();
    } catch {
      throw new DomainError("INVALID_REQUEST", "Request body must contain valid JSON.");
    }

    await next();
  });

  app.openapi(listArtifactsRoute, async (context) => {
    const principal = await dependencies.authenticator.authenticate(context.req.raw.headers);
    const query = parseArtifactDiscoveryQuery(new URL(context.req.url).searchParams, principal?.userId ?? null);
    const page = await dependencies.listArtifacts.execute(query);
    return context.json(toArtifactDiscoveryResponse(page), 200);
  });

  app.openapi(createArtifactRoute, async (context) => {
    const input = context.req.valid("json");
    const artifact = await dependencies.createArtifact.execute({
      actorId: context.get("principal").userId,
      ...input,
    });
    return context.json(toArtifactResponse(artifact), 201);
  });

  app.onError((error, context) => {
    const mapped = mapHttpError(error);
    if (mapped.status === 500) {
      console.error("Unhandled HTTP error");
    }
    return context.json(mapped.body, mapped.status);
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "BearerAuth", {
    type: "http",
    scheme: "bearer",
  });
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "PearlHub API",
      version: "1.0.0",
    },
  });

  return app;
}
