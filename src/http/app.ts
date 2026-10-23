import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { ListArtifactsService } from "../application/discovery.js";
import type { DeleteArtifactService, DraftWorkflow, ImportDraftService } from "../application/services.js";
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
  tags: z.array(z.string()).optional(),
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
  forkOrigin: z.object({ artifactId: z.string(), versionId: z.string() }).nullable(),
  provenance: z.object({
    sourceType: z.string(),
    sourceUrl: z.string(),
    sourceRef: z.string(),
    importedAt: z.string().datetime(),
  }).nullable(),
  state: z.enum(["active", "published", "discarded"]),
  revision: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).openapi("Draft");
const draftSummaryResponseSchema = z.object({
  id: z.string(),
  artifactId: z.string().nullable(),
  baseVersionId: z.string().nullable(),
  name: z.string(),
  slug: z.string(),
  visibility: z.enum(["private", "unlisted", "public"]),
  state: z.literal("active"),
  revision: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).openapi("DraftSummary");
const draftIdParams = z.object({ draftId: z.string().min(1) });
const artifactVersionParams = z.object({ artifactId: z.string().min(1), version: z.string().min(1) });
const artifactIdParams = z.object({ artifactId: z.string().min(1) });

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
      tags: z.array(z.string()).optional(),
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
const forkRoute = createRoute({
  method: "post", path: "/api/v1/artifacts/{artifactId}/fork", tags: ["Forks"], summary: "Create a Fork Draft",
  description: "Copies the selected immutable Version into a private Draft. The Artifact and permanent lineage are created atomically when the Draft is first published.",
  security: [{ BearerAuth: [] }],
  request: {
    params: artifactIdParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            sourceVersion: z.string().min(1).max(128),
            name: z.string().trim().min(1).max(200),
            slug: z.string().regex(artifactSlugPattern),
            visibility: z.enum(["private", "unlisted", "public"]),
          }).strict(),
        },
      },
    },
  },
  responses: {
    201: { description: "Editable Fork Draft created from the selected Version.", content: { "application/json": { schema: draftResponseSchema } } },
    400: { description: "Invalid Fork request or unavailable source snapshot.", content: { "application/json": { schema: errorResponseSchema } } },
    401: { description: "Authentication is required.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "The caller cannot read the source Artifact.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "Source Artifact or Version was not found.", content: { "application/json": { schema: errorResponseSchema } } },
    410: { description: "Source Artifact has been tombstoned.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});
const deleteArtifactRoute = createRoute({
  method: "delete", path: "/api/v1/artifacts/{artifactId}", tags: ["Artifacts"], summary: "Tombstone an Artifact",
  security: [{ BearerAuth: [] }],
  request: { params: artifactIdParams },
  responses: {
    204: { description: "Artifact tombstoned; historical content and relationships are retained." },
    401: { description: "Authentication is required.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "The caller cannot delete this Artifact.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "Artifact was never found.", content: { "application/json": { schema: errorResponseSchema } } },
    410: { description: "Artifact has already been tombstoned.", content: { "application/json": { schema: errorResponseSchema } } },
    500: { description: "Unexpected internal error.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});
const importBodySchema = z.discriminatedUnion("sourceType", [
  z.object({
    sourceType: z.literal("pasted"),
    name: z.string().trim().min(1).max(200),
    slug: z.string().regex(artifactSlugPattern),
    visibility: z.enum(["private", "unlisted", "public"]),
    content: z.string().min(1).max(1_048_576),
  }).strict(),
  z.object({
    sourceType: z.literal("github"),
    name: z.string().trim().min(1).max(200),
    slug: z.string().regex(artifactSlugPattern),
    visibility: z.enum(["private", "unlisted", "public"]),
    sourceUrl: z.string().min(1).max(2_048),
  }).strict(),
]).openapi("ImportRequest");
const importRoute = createRoute({
  method: "post", path: "/api/v1/imports/github", tags: ["Imports"], summary: "Create an Import Draft",
  description: "Accepts pasted Markdown/Skill content or fetches an allowlisted raw.githubusercontent.com URL. Returns an editable Draft; publication is a separate operation.",
  security: [{ BearerAuth: [] }],
  request: { body: { required: true, content: { "application/json": { schema: importBodySchema } } } },
  responses: {
    201: { description: "Editable Import Draft created.", content: { "application/json": { schema: draftResponseSchema } } },
    400: { description: "Invalid input, unsupported URL, or invalid content.", content: { "application/json": { schema: errorResponseSchema } } },
    401: { description: "Authentication is required.", content: { "application/json": { schema: errorResponseSchema } } },
    502: { description: "GitHub source could not be retrieved.", content: { "application/json": { schema: errorResponseSchema } } },
    504: { description: "GitHub source request timed out.", content: { "application/json": { schema: errorResponseSchema } } },
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
const listDraftsRoute = createRoute({
  method: "get", path: "/api/v1/drafts", tags: ["Drafts"], summary: "List the caller's active Drafts",
  security: [{ BearerAuth: [] }],
  responses: {
    200: { description: "Active Draft summaries owned by the authenticated caller.", content: { "application/json": { schema: z.array(draftSummaryResponseSchema) } } },
    401: { description: "Authentication is required.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});
const revisionBody = z.object({ revision: z.number().int().positive() }).strict();
const publishRoute = createRoute({
  method: "post", path: "/api/v1/drafts/{draftId}/publish", tags: ["Drafts"], summary: "Publish a Draft",
  description: "Publishing an Artifact work-copy applies its Draft visibility to the Artifact in the same transaction that creates the next immutable Version.",
  security: [{ BearerAuth: [] }], request: { params: draftIdParams, body: { required: true, content: { "application/json": { schema: revisionBody } } } },
  responses: { 201: { description: "Artifact and immutable version published atomically.", content: { "application/json": { schema: publishedVersionResponseSchema } } }, 400: { description: "Invalid Draft or version.", content: { "application/json": { schema: errorResponseSchema } } }, 401: { description: "Authentication is required.", content: { "application/json": { schema: errorResponseSchema } } }, 409: { description: "Stale Draft, slug, or version conflict.", content: { "application/json": { schema: errorResponseSchema } } }, 410: { description: "The Artifact associated with this Draft has been tombstoned.", content: { "application/json": { schema: errorResponseSchema } } } },
});
const getDraftRoute = createRoute({
  method: "get", path: "/api/v1/drafts/{draftId}", tags: ["Drafts"], summary: "Read a Draft",
  security: [{ BearerAuth: [] }], request: { params: draftIdParams },
  responses: { 200: { description: "Owner-authorized Draft.", content: { "application/json": { schema: draftResponseSchema } } }, 401: { description: "Authentication is required.", content: { "application/json": { schema: errorResponseSchema } } }, 404: { description: "Draft not found.", content: { "application/json": { schema: errorResponseSchema } } } },
});
const updateDraftRoute = createRoute({
  method: "put", path: "/api/v1/drafts/{draftId}", tags: ["Drafts"], summary: "Update a Draft",
  description: "For an Artifact work-copy, changing Draft visibility takes effect on the Artifact only when the updated Draft revision is published.",
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
  responses: { 200: { description: "Published versions of a visible Artifact.", content: { "application/json": { schema: z.array(publishedVersionResponseSchema) } } }, 404: { description: "Artifact not found.", content: { "application/json": { schema: errorResponseSchema } } }, 409: { description: "A legacy version has no stored PostgreSQL content snapshot.", content: { "application/json": { schema: errorResponseSchema } } }, 410: { description: "Artifact has been tombstoned.", content: { "application/json": { schema: errorResponseSchema } } } },
});
const getVersionRoute = createRoute({
  method: "get", path: "/api/v1/artifacts/{artifactId}/versions/{version}", tags: ["Artifact Versions"], summary: "Read a published version",
  security: [{}, { BearerAuth: [] }], request: { params: artifactVersionParams },
  responses: { 200: { description: "Complete immutable version snapshot.", content: { "application/json": { schema: publishedVersionResponseSchema } } }, 404: { description: "Artifact or version not found.", content: { "application/json": { schema: errorResponseSchema } } }, 410: { description: "Artifact has been tombstoned.", content: { "application/json": { schema: errorResponseSchema } } } },
});
const workCopyRoute = createRoute({
  method: "post", path: "/api/v1/artifacts/{artifactId}/versions/{version}/work-copy", tags: ["Drafts"], summary: "Create a Draft work-copy",
  security: [{ BearerAuth: [] }], request: { params: artifactVersionParams },
  responses: { 201: { description: "New Draft based on the selected immutable version.", content: { "application/json": { schema: draftResponseSchema } } }, 401: { description: "Authentication is required.", content: { "application/json": { schema: errorResponseSchema } } }, 409: { description: "An active Draft already exists or source content is unavailable.", content: { "application/json": { schema: errorResponseSchema } } }, 410: { description: "Artifact has been tombstoned.", content: { "application/json": { schema: errorResponseSchema } } } },
});

type HttpEnvironment = {
  Variables: {
    principal: AuthenticatedPrincipal;
  };
};

export interface HttpAppDependencies {
  listArtifacts: Pick<ListArtifactsService, "execute">;
  drafts?: DraftWorkflow;
  deleteArtifact?: Pick<DeleteArtifactService, "execute">;
  importDraft?: Pick<ImportDraftService, "execute">;
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
    const input = context.req.valid("json");
    const { name, slug, visibility, content } = input;
    const draft = await dependencies.drafts.create({ actorId: actor.userId, name, slug, visibility, content });
    return context.json(toDraftResponse(draft), 201);
  });
  app.openapi(forkRoute, async (context) => {
    const actor = await requirePrincipal(dependencies.authenticator, context.req.raw.headers);
    if (!dependencies.drafts) throw new Error("Draft workflow is not configured.");
    const { artifactId } = context.req.valid("param");
    const draft = await dependencies.drafts.createFork({ actorId: actor.userId, sourceArtifactId: artifactId, ...context.req.valid("json") });
    return context.json(toDraftResponse(draft), 201);
  });
  app.openapi(deleteArtifactRoute, async (context) => {
    const actor = await requirePrincipal(dependencies.authenticator, context.req.raw.headers);
    if (!dependencies.deleteArtifact) throw new Error("Artifact deletion is not configured.");
    await dependencies.deleteArtifact.execute({ actorId: actor.userId, artifactId: context.req.valid("param").artifactId });
    return context.body(null, 204);
  });
  app.openapi(importRoute, async (context) => {
    const actor = await requirePrincipal(dependencies.authenticator, context.req.raw.headers);
    if (!dependencies.importDraft) throw new Error("Import workflow is not configured.");
    const body = context.req.valid("json");
    const draft = await dependencies.importDraft.execute({ actorId: actor.userId, ...body });
    return context.json(toDraftResponse(draft), 201);
  });
  app.openapi(listDraftsRoute, async (context) => {
    const actor = await requirePrincipal(dependencies.authenticator, context.req.raw.headers);
    if (!dependencies.drafts) throw new Error("Draft workflow is not configured.");
    const drafts = await dependencies.drafts.list({ actorId: actor.userId });
    return context.json(drafts.map(toDraftSummaryResponse), 200);
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

function toDraftSummaryResponse(draft: import("../domain/draft.js").Draft) {
  const value = draft.snapshot();
  return {
    id: value.id,
    artifactId: value.artifactId,
    baseVersionId: value.baseVersionId,
    name: value.name,
    slug: value.slug,
    visibility: value.visibility,
    state: "active" as const,
    revision: value.revision,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
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
