import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { ListArtifactsService } from "../application/discovery.js";
import type { DraftWorkflow } from "../application/services.js";
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

const draftContentSchema = z.object({
  instructions: z.string(),
  knowledgeFiles: z.array(z.object({ path: z.string(), content: z.string() }).strict()),
  dependencies: z.array(z.object({ targetArtifactId: z.string().min(1), declaredRange: z.string() }).strict()),
}).strict().openapi("DraftContent");
const draftInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().regex(artifactSlugPattern),
  visibility: z.enum(["private", "unlisted", "public"]),
  content: draftContentSchema,
}).strict().openapi("DraftInput");
const draftResponseSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  artifactId: z.string().nullable(),
  baseVersionId: z.string().nullable(),
  name: z.string(),
  slug: z.string(),
  visibility: z.enum(["private", "unlisted", "public"]),
  content: draftContentSchema,
  state: z.enum(["active", "published", "discarded"]),
  revision: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).openapi("Draft");

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

const publishedVersionResponseSchema = z.object({
  artifact: artifactResponseSchema,
  version: z.object({
    id: z.string(),
    artifactId: z.string(),
    version: z.string(),
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    publishedAt: z.string().datetime(),
    content: z.object({
      instructions: z.string(),
      knowledgeFiles: z.array(z.object({
        path: z.string(),
        content: z.string(),
        contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      })),
      dependencies: z.array(z.object({ targetArtifactId: z.string(), declaredRange: z.string() })),
    }),
  }),
}).openapi("PublishedVersion");

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
  summary: "Create an Artifact (retired)",
  description: "Retired: create a Draft and publish it to create its Artifact identity atomically.",
  deprecated: true,
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
    410: {
      description: "Artifact creation must use the Draft and Publish workflow.",
      content: { "application/json": { schema: errorResponseSchema } },
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

const createDraftRoute = createRoute({
  method: "post", path: "/api/v1/drafts", tags: ["Drafts"], summary: "Create a private Draft",
  security: [{ BearerAuth: [] }],
  request: { body: { required: true, content: { "application/json": { schema: draftInputSchema } } } },
  responses: { 201: { description: "Draft created.", content: { "application/json": { schema: draftResponseSchema } } }, 400: { description: "Invalid Draft.", content: { "application/json": { schema: errorResponseSchema } } }, 401: { description: "Authentication is required.", content: { "application/json": { schema: errorResponseSchema } } } },
});
const draftIdParams = z.object({ draftId: z.string().min(1) });
const artifactVersionParams = z.object({ artifactId: z.string().min(1), version: z.string().min(1) });
const artifactIdParams = z.object({ artifactId: z.string().min(1) });
const revisionBody = z.object({ revision: z.number().int().positive() }).strict();
const publishRoute = createRoute({
  method: "post", path: "/api/v1/drafts/{draftId}/publish", tags: ["Drafts"], summary: "Publish a Draft",
  security: [{ BearerAuth: [] }], request: { params: draftIdParams, body: { required: true, content: { "application/json": { schema: revisionBody } } } },
  responses: { 201: { description: "Artifact and immutable version published atomically.", content: { "application/json": { schema: publishedVersionResponseSchema } } }, 400: { description: "Invalid Draft or version.", content: { "application/json": { schema: errorResponseSchema } } }, 401: { description: "Authentication is required.", content: { "application/json": { schema: errorResponseSchema } } }, 409: { description: "Stale Draft, slug, or version conflict.", content: { "application/json": { schema: errorResponseSchema } } } },
});
const getDraftRoute = createRoute({
  method: "get", path: "/api/v1/drafts/{draftId}", tags: ["Drafts"], summary: "Read a Draft",
  security: [{ BearerAuth: [] }], request: { params: draftIdParams },
  responses: { 200: { description: "Owner-authorized Draft.", content: { "application/json": { schema: draftResponseSchema } } }, 401: { description: "Authentication is required.", content: { "application/json": { schema: errorResponseSchema } } }, 404: { description: "Draft not found.", content: { "application/json": { schema: errorResponseSchema } } } },
});
const updateDraftRoute = createRoute({
  method: "put", path: "/api/v1/drafts/{draftId}", tags: ["Drafts"], summary: "Update a Draft",
  security: [{ BearerAuth: [] }], request: { params: draftIdParams, body: { required: true, content: { "application/json": { schema: draftInputSchema.extend({ revision: z.number().int().positive() }) } } } },
  responses: { 200: { description: "Draft updated.", content: { "application/json": { schema: draftResponseSchema } } }, 400: { description: "Invalid Draft.", content: { "application/json": { schema: errorResponseSchema } } }, 401: { description: "Authentication is required.", content: { "application/json": { schema: errorResponseSchema } } }, 409: { description: "Stale Draft revision.", content: { "application/json": { schema: errorResponseSchema } } } },
});
const deleteDraftRoute = createRoute({
  method: "delete", path: "/api/v1/drafts/{draftId}", tags: ["Drafts"], summary: "Discard a Draft",
  security: [{ BearerAuth: [] }], request: { params: draftIdParams, query: z.object({ revision: z.coerce.number().int().positive() }) },
  responses: { 204: { description: "Draft discarded." }, 401: { description: "Authentication is required.", content: { "application/json": { schema: errorResponseSchema } } }, 409: { description: "Stale Draft revision.", content: { "application/json": { schema: errorResponseSchema } } } },
});
const listVersionsRoute = createRoute({
  method: "get", path: "/api/v1/artifacts/{artifactId}/versions", tags: ["Artifact Versions"], summary: "List published versions",
  security: [{}, { BearerAuth: [] }], request: { params: artifactIdParams },
  responses: { 200: { description: "Published versions of a visible Artifact.", content: { "application/json": { schema: z.array(publishedVersionResponseSchema) } } }, 404: { description: "Artifact not found.", content: { "application/json": { schema: errorResponseSchema } } }, 409: { description: "A legacy version has no stored PostgreSQL content snapshot.", content: { "application/json": { schema: errorResponseSchema } } } },
});
const getVersionRoute = createRoute({
  method: "get", path: "/api/v1/artifacts/{artifactId}/versions/{version}", tags: ["Artifact Versions"], summary: "Read a published version",
  security: [{}, { BearerAuth: [] }], request: { params: artifactVersionParams },
  responses: { 200: { description: "Complete immutable version snapshot.", content: { "application/json": { schema: publishedVersionResponseSchema } } }, 404: { description: "Artifact or version not found.", content: { "application/json": { schema: errorResponseSchema } } } },
});
const workCopyRoute = createRoute({
  method: "post", path: "/api/v1/artifacts/{artifactId}/versions/{version}/work-copy", tags: ["Drafts"], summary: "Create a Draft work-copy",
  security: [{ BearerAuth: [] }], request: { params: artifactVersionParams },
  responses: { 201: { description: "New Draft based on the selected immutable version.", content: { "application/json": { schema: draftResponseSchema } } }, 401: { description: "Authentication is required.", content: { "application/json": { schema: errorResponseSchema } } }, 409: { description: "An active Draft already exists or source content is unavailable.", content: { "application/json": { schema: errorResponseSchema } } } },
});

type HttpEnvironment = {
  Variables: {
    principal: AuthenticatedPrincipal;
  };
};

export interface HttpAppDependencies {
  listArtifacts: Pick<ListArtifactsService, "execute">;
  drafts?: DraftWorkflow;
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
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      maxAge: 600,
    }));
  }

  app.use("/api/v1/artifacts", async (context, next) => {
    if (context.req.method !== "POST" || context.req.path !== "/api/v1/artifacts") {
      await next();
      return;
    }
    const principal = await dependencies.authenticator.authenticate(context.req.raw.headers);
    if (!principal) throw new DomainError("UNAUTHENTICATED", "Authentication is required.");
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
    throw new DomainError("ARTIFACT_CREATION_REQUIRES_DRAFT", "Create a Draft and publish it to create an Artifact.");
  });

  app.openapi(createDraftRoute, async (context) => {
    const actor = await requirePrincipal(dependencies.authenticator, context.req.raw.headers);
    if (!dependencies.drafts) throw new Error("Draft workflow is not configured.");
    const draft = await dependencies.drafts.create({ actorId: actor.userId, ...context.req.valid("json") });
    return context.json(toDraftResponse(draft), 201);
  });
  app.openapi(getDraftRoute, async (context) => {
    const actor = await requirePrincipal(dependencies.authenticator, context.req.raw.headers);
    if (!dependencies.drafts) throw new Error("Draft workflow is not configured.");
    return context.json(toDraftResponse(await dependencies.drafts.get({ actorId: actor.userId, draftId: context.req.valid("param").draftId })), 200);
  });
  app.openapi(updateDraftRoute, async (context) => {
    const actor = await requirePrincipal(dependencies.authenticator, context.req.raw.headers);
    if (!dependencies.drafts) throw new Error("Draft workflow is not configured.");
    const { revision, ...input } = context.req.valid("json");
    return context.json(toDraftResponse(await dependencies.drafts.update({ actorId: actor.userId, draftId: context.req.valid("param").draftId, revision, ...input })), 200);
  });
  app.openapi(deleteDraftRoute, async (context) => {
    const actor = await requirePrincipal(dependencies.authenticator, context.req.raw.headers);
    if (!dependencies.drafts) throw new Error("Draft workflow is not configured.");
    await dependencies.drafts.discard({ actorId: actor.userId, draftId: context.req.valid("param").draftId, revision: context.req.valid("query").revision });
    return context.body(null, 204);
  });
  app.openapi(publishRoute, async (context) => {
    const actor = await requirePrincipal(dependencies.authenticator, context.req.raw.headers);
    if (!dependencies.drafts) throw new Error("Draft workflow is not configured.");
    const result = await dependencies.drafts.publish({ actorId: actor.userId, draftId: context.req.valid("param").draftId, revision: context.req.valid("json").revision });
    return context.json(toPublishedResponse(result.artifact, result.version), 201);
  });
  app.openapi(workCopyRoute, async (context) => {
    const actor = await requirePrincipal(dependencies.authenticator, context.req.raw.headers);
    if (!dependencies.drafts) throw new Error("Draft workflow is not configured.");
    const { artifactId, version } = context.req.valid("param");
    return context.json(toDraftResponse(await dependencies.drafts.createWorkCopy({ actorId: actor.userId, artifactId, version })), 201);
  });
  app.openapi(listVersionsRoute, async (context) => {
    if (!dependencies.drafts) throw new Error("Draft workflow is not configured.");
    const principal = await dependencies.authenticator.authenticate(context.req.raw.headers);
    const { artifactId } = await context.req.valid("param");
    const result = await dependencies.drafts.listPublishedVersions({ actorId: principal?.userId ?? null, artifactId });
    if (result.versions.some((version) => !version.contentSnapshot || !isCompleteSnapshot(version.contentSnapshot))) {
      throw new DomainError("VERSION_CONTENT_UNAVAILABLE", "One or more legacy Artifact Versions have no PostgreSQL content snapshot.");
    }
    return context.json(result.versions.map((version) => toVersionResponse(result.artifact, version, requireCompleteSnapshot(version.contentSnapshot))), 200);
  });
  app.openapi(getVersionRoute, async (context) => {
    if (!dependencies.drafts) throw new Error("Draft workflow is not configured.");
    const principal = await dependencies.authenticator.authenticate(context.req.raw.headers);
    const { artifactId, version } = await context.req.valid("param");
    const result = await dependencies.drafts.getPublishedVersion({ actorId: principal?.userId ?? null, artifactId, version });
    return context.json(toVersionResponse(result.artifact, result.version, requireCompleteSnapshot(result.version.contentSnapshot)), 200);
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

function toDraftResponse(draft: import("../domain/draft.js").Draft) {
  const value = draft.snapshot();
  return { ...value, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() };
}

interface CompleteSnapshot {
  [key: string]: unknown;
  instructions: string;
  knowledgeFiles: Array<{ path: string; content: string; contentHash: string }>;
  dependencies: Array<{ targetArtifactId: string; declaredRange: string }>;
}

function toVersionResponse(
  artifact: import("../domain/artifact.js").Artifact,
  version: import("../domain/artifact-version.js").ArtifactVersion,
  content: CompleteSnapshot,
) {
  return {
    artifact: toArtifactResponse(artifact),
    version: {
      id: version.id, artifactId: version.artifactId, version: version.version, contentHash: version.contentHash,
      publishedAt: version.publishedAt.toISOString(), content,
    },
  };
}

function toPublishedResponse(artifact: import("../domain/artifact.js").Artifact, version: import("../domain/artifact-version.js").ArtifactVersion) {
  return toVersionResponse(artifact, version, requireCompleteSnapshot(version.contentSnapshot));
}

function isCompleteSnapshot(content: Record<string, unknown> | null): content is CompleteSnapshot {
  if (!content) return false;
  return typeof content.instructions === "string"
    && Array.isArray(content.knowledgeFiles)
    && content.knowledgeFiles.every((file) => file !== null && typeof file === "object"
      && "path" in file && typeof file.path === "string"
      && "content" in file && typeof file.content === "string"
      && "contentHash" in file && typeof file.contentHash === "string")
    && Array.isArray(content.dependencies)
    && content.dependencies.every((dependency) => dependency !== null && typeof dependency === "object"
      && "targetArtifactId" in dependency && typeof dependency.targetArtifactId === "string"
      && "declaredRange" in dependency && typeof dependency.declaredRange === "string");
}

function requireCompleteSnapshot(content: Record<string, unknown> | null): CompleteSnapshot {
  if (!isCompleteSnapshot(content)) {
    throw new DomainError("VERSION_CONTENT_UNAVAILABLE", "This legacy Artifact Version has no PostgreSQL content snapshot.");
  }
  return content;
}

async function requirePrincipal(authenticator: Authenticator, headers: Headers): Promise<AuthenticatedPrincipal> {
  const principal = await authenticator.authenticate(headers);
  if (!principal) throw new DomainError("UNAUTHENTICATED", "Authentication is required.");
  return principal;
}
