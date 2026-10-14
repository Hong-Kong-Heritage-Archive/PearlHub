import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { CreateArtifactUseCase } from "../application/services.js";
import { toArtifactResponse } from "../contracts/dto.js";
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
  authenticator: Authenticator;
}

export function createHttpApp(dependencies: HttpAppDependencies) {
  const app = new OpenAPIHono<HttpEnvironment>({
    defaultHook: (result) => {
      if (!result.success) {
        throw new DomainError("INVALID_REQUEST", "Request body is invalid.");
      }
    },
  });

  app.use("/api/v1/artifacts", async (context, next) => {
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
