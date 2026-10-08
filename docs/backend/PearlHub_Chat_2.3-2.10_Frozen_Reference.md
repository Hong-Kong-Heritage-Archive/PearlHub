# PearlHub Backend Architecture — Frozen Reference
## Chat 2.3–2.10

> **Purpose:** GitHub Copilot reference for implementing the PearlHub backend.
>
> **Status:** Frozen architectural decisions through Chat 2.10.
>
> **Core principle:** PearlHub is open-source, permanently free, consumer/community-first, and portability is a core design principle.

---

## 1. Architecture Overview

PearlHub backend follows a layered / hexagonal-style architecture:

```text
HTTP / Hono
    ↓
Application Use Cases
    ↓
Domain Model & Invariants
    ↓
Repository Ports
    ↓
Infrastructure Adapters
    ↓
PostgreSQL / external systems
```

The key rule is:

> **Hono owns HTTP; Application owns use cases; Domain owns business rules; Infrastructure owns external systems; Cloud Run only owns the runtime.**

The Domain and Application layers must not depend on Hono, Firebase, PostgreSQL, Cloud Run, OpenAPI implementation details, or Gemini SDKs.

---

# 2.3 — API Contract

## Frozen Decisions

- API contract is defined with **OpenAPI 3.1**.
- OpenAPI is the contract between clients and the backend.
- Runtime routing, validation, serialization, and error responses must not silently diverge from the OpenAPI contract.
- API implementation is an adapter around the Application layer.
- API routes must not contain business rules.
- API routes must not directly access PostgreSQL.

Conceptually:

```text
OpenAPI 3.1
    ↓
HTTP Adapter / Hono
    ↓
Application Use Case
```

The API contract should remain independent from the persistence implementation.

---

# 2.4 — HTTP Adapter / Framework

## Frozen Decisions

- HTTP framework: **Hono**.
- Runtime/deployment target: **Google Cloud Run**.
- Deployment model: one standard OCI/Docker container running the Hono application.
- Do **not** design the application as Cloud Run Functions / function-per-operation.
- Hono must remain portable and should not be tightly coupled to GCP.
- GCP-specific services belong in Infrastructure.

## Layer Responsibilities

### Router

Maps HTTP routes to handlers.

Router must not:

- implement business logic
- access the database directly
- implement Domain invariants

### Middleware

Handles HTTP-level concerns such as:

- request ID
- logging
- authentication
- HTTP-level authorization integration
- request validation
- centralized error handling

### Handler

A thin HTTP → Application adapter.

Responsibilities:

1. Extract request data.
2. Validate/map request data.
3. Obtain authenticated principal.
4. Invoke the Application use case.
5. Map the result to an HTTP response.

Handlers must not implement Domain business rules.

### Application

Orchestrates use cases and authorization.

### Domain

Owns business rules and invariants.

### Repository Ports

Abstract persistence from Application/Domain.

### Infrastructure

Implements PostgreSQL, storage, GitHub, authentication adapters, etc.

## Suggested Structure

```text
backend/
├── src/
│   ├── app/
│   │   ├── create-app.ts
│   │   ├── router.ts
│   │   └── middleware/
│   │       ├── auth.ts
│   │       ├── error-handler.ts
│   │       ├── request-id.ts
│   │       └── logging.ts
│   ├── http/
│   │   ├── routes/
│   │   │   ├── artifacts.ts
│   │   │   ├── versions.ts
│   │   │   ├── forks.ts
│   │   │   ├── imports.ts
│   │   │   └── compatibility.ts
│   │   ├── handlers/
│   │   │   ├── artifacts/
│   │   │   ├── versions/
│   │   │   └── forks/
│   │   ├── dto/
│   │   │   ├── artifact.dto.ts
│   │   │   └── error.dto.ts
│   │   └── openapi/
│   │       ├── document.ts
│   │       └── schemas.ts
│   ├── application/
│   ├── domain/
│   └── infrastructure/
├── openapi/
│   └── openapi.yaml
├── Dockerfile
└── package.json
```

`create-app.ts` is the composition root and constructs Infrastructure adapters, Repository implementations, Application use cases, handlers, routes, and middleware.

## Testing Boundary

- Hono HTTP tests can mock Application dependencies.
- Application tests can mock Repository ports.
- Domain tests require no Hono, Cloud Run, PostgreSQL, or Firebase.

---

# 2.5 — Authentication

## Frozen Decisions

- Prototype Identity Provider: **Firebase Authentication**.
- Authentication boundary is **OIDC/JWT-oriented**.
- Firebase-specific logic is confined to an Authentication Adapter / Infrastructure.
- Hono authentication middleware authenticates incoming requests.
- Application receives an abstract `AuthenticatedPrincipal`.
- Application and Domain must not depend directly on the Firebase SDK or Firebase-specific claims.

## AuthenticatedPrincipal

```ts
export type AuthenticatedPrincipal = {
  userId: string
  subject: string
  roles: string[]
}
```

Potential future abstraction:

```ts
type Principal = UserPrincipal | ServicePrincipal
```

Service principals can be deferred.

## Request Flow

```text
Client
  ↓
Firebase Authentication
  ↓
Firebase ID Token
  ↓
Cloud Run
  ↓
Hono Authentication Middleware
  ↓
AuthenticatedPrincipal
  ↓
Application
  ↓
Domain
```

Hono Context may contain the request-scoped principal:

```ts
c.set("principal", principal)
```

But Application must not depend on Hono Context.

The Handler extracts the principal and passes it into the Application command.

## Critical Security Rule

Never trust a client-supplied owner/user identity.

For example:

```ts
ownerId = command.principal.userId
```

not:

```ts
ownerId = command.ownerId
```

## Authentication vs Authorization

These are separate concerns:

```text
Authentication
    = Who are you?

Authorization
    = Are you allowed to perform this operation?

Domain Invariant
    = Is this state transition valid?
```

---

# 2.6 — Authorization Policy / Permission Model

## Frozen Visibility Semantics

PearlHub has three normal visibility values:

```ts
export enum ArtifactVisibility {
  Public = "public",
  Private = "private",
  Unlisted = "unlisted",
}
```

### Public

- Discoverable
- Readable by anonymous users

### Unlisted

- Not discoverable
- Requires the secret URL
- Requires an authenticated user
- Any authenticated user with the secret URL can read
- Only Owner/Admin may fork

### Private

- Owner only for normal reading
- Admin may read

Tombstone is **not** a visibility value.

A Tombstone has:

```text
status = Tombstone
visibility = Unlisted
```

## Permission Matrix

| Operation | Anonymous | Authenticated | Owner | Admin |
|---|---:|---:|---:|---:|
| Read Public | Yes | Yes | Yes | Yes |
| Read Private | No | No | Yes | Yes |
| Read Unlisted with secret URL | No | Yes | Yes | Yes |
| Fork Public | No | Yes | Yes | Yes |
| Fork Private | No | No | No | Yes |
| Fork Unlisted | No | No | Yes | Yes |
| Read Tombstone | No | No | No | Yes |
| Restore Tombstone | No | No | No | Yes |
| Create Artifact | No | Yes | Yes | Yes |
| Edit metadata | No | No | Yes | Yes |
| Change visibility | No | No | Yes | Yes |
| Create Version | No | No | Yes | Yes |
| Delete Artifact | No | No | Yes | Yes |

Owner is a resource relationship, not an RBAC role.

Admin is not an omnipotent database user and cannot bypass Domain immutability/invariants.

## Tombstone Rules

- Normal users cannot read Tombstones.
- Admin can read Tombstones.
- Admin can restore a Tombstone.
- Restore preserves Artifact identity, owner, name, slug, lineage, and historical versions.
- Restore must not rewrite lineage or historical snapshots.

---

# 2.7 — Authorization Implementation Boundary

## Frozen Responsibility Split

```text
Hono
  → authenticates

Application
  → authorizes

Domain
  → validates business invariants

Infrastructure
  → persists
```

Authorization policy interface:

```ts
export interface AuthorizationPolicy {
  can(
    principal: AuthenticatedPrincipal,
    permission: Permission,
    resource?: AuthorizationResource,
  ): boolean
}
```

Recommended permission enum:

```ts
export enum Permission {
  ArtifactRead = "artifact:read",
  ArtifactUpdate = "artifact:update",
  ArtifactDelete = "artifact:delete",
  ArtifactRestore = "artifact:restore",
  VersionCreate = "version:create",
  ArtifactFork = "artifact:fork",
  ArtifactClone = "artifact:clone",
  ArtifactImport = "artifact:import",
  CompatibilityRead = "compatibility:read",
  CompatibilityCreate = "compatibility:create",
}
```

Visibility can be represented by a separate policy:

```ts
export interface ArtifactVisibilityPolicy {
  canRead(
    principal: AuthenticatedPrincipal | null,
    artifact: Artifact,
    hasSecretUrl: boolean,
  ): boolean
}
```

Firebase must not appear inside `AuthorizationPolicy`.

Resource ownership checks compare the authenticated principal with the persisted resource owner, for example:

```ts
principal.userId === artifact.ownerId
```

## Authorization Order

A mutation should conceptually follow:

```text
Authenticate
    ↓
Authorize
    ↓
Load Domain Entity
    ↓
Validate Domain Invariants
    ↓
Persist
```

Authorization is Application responsibility; Domain invariants remain mandatory even when authorization succeeds.

---

# 2.8 — Application Use Cases

## Frozen Responsibility

The Application layer owns Artifact/Version lifecycle use cases.

Use cases:

```text
Artifact
- CreateArtifact
- GetArtifact
- UpdateArtifactMetadata
- ChangeArtifactVisibility
- DeleteArtifact
- RestoreArtifact

Version
- CreateArtifactVersion
- GetArtifactVersion
- ListArtifactVersions

Lineage
- ForkArtifact
- CloneArtifact

Import
- ImportArtifactFromGitHub

Compatibility
- CreateCompatibilityReport
- GetCompatibilityReport
```

Playground remains a separate concern.

## Use Case Boundary

Use cases must not know about:

- Hono
- Firebase
- Cloud Run
- PostgreSQL
- OpenAPI implementation
- Gemini SDK

Every mutation receives an `AuthenticatedPrincipal`.

Example:

```ts
export interface UseCase<TCommand, TResult> {
  execute(command: TCommand): Promise<TResult>
}
```

## Ownership

The authoritative owner is derived from the authenticated principal.

```ts
ownerId = command.principal.userId
```

The client cannot choose the authoritative owner.

## Artifact Lifecycle

Delete is a lifecycle transition:

```text
ACTIVE
   ↓ delete
TOMBSTONE
```

Restore:

```text
TOMBSTONE
   ↓ restore
ACTIVE
```

No normal physical deletion.

## Version Creation

The backend computes the canonical content hash.

Do not trust a client-supplied authoritative content hash.

Exact hashing algorithm and canonical serialization are deferred to the relevant implementation/schema work.

## Fork

Fork produces:

```text
New Artifact
+
Permanent ForkRelationship
```

Fork relationship creation must be atomic with creation of the new Artifact.

## Clone

Clone produces:

```text
New Artifact
+
No PearlHub lineage
```

## GitHub Import

GitHub import produces:

```text
New Artifact
+
GitHub provenance/source metadata
```

It is **not** a Fork and must not create PearlHub lineage.

## Application Boundary Rule

Application orchestrates operations but must not bypass Domain rules by directly writing invalid lifecycle/status state.

---

# 2.9 — Domain Model & Invariants

## Core Principle

> **2.8 defines what to do; 2.9 defines what PearlHub domain objects are and what state transitions must never violate.**

Domain has no dependency on:

- Hono
- Firebase
- PostgreSQL
- Cloud Run
- OpenAPI
- Gemini SDK

## Domain Objects

Primary domain concepts:

```text
Artifact
ArtifactVersion
ForkRelationship / Lineage
Dependency
Visibility
Lifecycle Status
ContentHash
KnowledgeFile
```

## Artifact

Conceptual shape:

```ts
type Artifact = {
  id: ArtifactId
  name: ArtifactName
  slug: ArtifactSlug
  ownerId: UserId
  visibility: ArtifactVisibility
  status: ArtifactStatus
  createdAt: Date
  updatedAt: Date
}
```

The entity should control state transitions through methods rather than arbitrary field setters.

Examples:

```text
changeVisibility()
updateMetadata()
delete()
restore()
```

## Immutable Artifact Fields

These are permanently immutable:

```text
id
name
slug
ownerId
```

Artifact cannot be renamed or owner-transferred.

## Lifecycle Status

```ts
export enum ArtifactStatus {
  Active = "active",
  Tombstone = "tombstone",
}
```

Valid states:

```text
Active + Public
Active + Private
Active + Unlisted

Tombstone + Unlisted
```

Tombstone must not have Public or Private visibility.

## Tombstone Invariants

A Tombstone:

1. Represents a deleted Artifact.
2. Has Unlisted visibility.
3. Retains an immutable snapshot.
4. Preserves lineage.
5. Is unreadable by normal users.
6. Can be restored only by Admin.
7. Restores to the same Artifact identity.
8. Preserves owner, name, slug, lineage, and historical versions.

## ArtifactVersion

Conceptual shape:

```ts
type ArtifactVersion = {
  id: ArtifactVersionId
  artifactId: ArtifactId
  version: SemVer
  instructions: string
  knowledgeFiles: KnowledgeFile[]
  contentHash: ContentHash
  createdAt: Date
}
```

Version is immutable after creation.

Immutable fields include:

```text
id
artifactId
version
instructions
knowledgeFiles
contentHash
```

Version identity and SemVer value are distinct concepts.

`SemVer` should be a Value Object responsible for parsing, validating, and comparing semantic versions.

## ContentHash

ContentHash is a Value Object.

It must be derived from canonical content.

The exact algorithm and canonical serialization are intentionally left for later implementation.

## KnowledgeFile

```ts
type KnowledgeFile = {
  path: KnowledgePath
  content: string
  contentHash: ContentHash
}
```

Invariants:

- Path is valid.
- Paths are unique within a Version.
- Hash matches the canonical file content.

## Dependency

```ts
type Dependency = {
  artifactId: ArtifactId
  versionRange: SemVerRange
}
```

Rules:

- Version range must be a valid SemVer range.
- Declared dependency range is immutable within a Version.
- Dependency resolution is separate from declaration.

Resolution records:

```text
declared range
+
resolved version
```

Playground/export can resolve the latest version satisfying the declared range.

## ForkRelationship

```ts
type ForkRelationship = {
  parentArtifactId: ArtifactId
  childArtifactId: ArtifactId
  sourceVersionId: ArtifactVersionId
  createdAt: Date
}
```

Rules:

- Parent and child must differ.
- Parent must exist.
- Child must exist.
- Relationship is immutable.
- Lineage cannot be rewritten.
- Deleting an Artifact does not destroy lineage.
- Fork creates lineage.
- Clone creates no lineage.

## Aggregate Boundary

Artifact is the primary lifecycle Aggregate Root.

ArtifactVersion is an immutable content entity associated with an Artifact, but should not require loading all Version content whenever the Artifact lifecycle is accessed.

Therefore:

```text
ArtifactRepository
ArtifactVersionRepository
```

remain separate.

The Application layer coordinates operations involving multiple repositories.

## Domain Errors

Domain errors must be framework-independent.

Examples:

```text
ArtifactAlreadyExistsError
ArtifactNotFoundError
InvalidArtifactStateError
ImmutableArtifactFieldError

VersionAlreadyExistsError
InvalidVersionError
InvalidVersionTransitionError

InvalidDependencyRangeError

InvalidLineageError
LineageAlreadyExistsError
```

## Invariant Catalogue

### Artifact

```text
A-01 id immutable
A-02 name immutable
A-03 slug immutable
A-04 owner immutable
A-05 owner exists
A-06 visibility valid
A-07 status valid
```

### Version

```text
V-01 Version belongs to one Artifact
V-02 Version uses valid SemVer
V-03 Version immutable after creation
V-04 Content hash matches canonical content
V-05 Duplicate Version identity forbidden
```

### Dependency

```text
D-01 Dependency target valid
D-02 Dependency range is valid SemVer range
D-03 Declared dependency range immutable
```

### Lineage

```text
L-01 parent != child
L-02 parent exists
L-03 child exists
L-04 relationship immutable
L-05 delete does not destroy lineage
L-06 clone creates no lineage
```

### Tombstone

```text
T-01 deleted Artifact
T-02 visibility = Unlisted
T-03 immutable snapshot
T-04 lineage preserved
T-05 normal users cannot read
T-06 restore preserves Artifact identity
```

---

# 2.10 — Repository Ports / Persistence Boundary

## Core Principle

> **Domain/Application define what must be persisted; Infrastructure defines how it is persisted.**

Application depends on Repository Ports.

PostgreSQL is an Infrastructure implementation detail.

```text
Application
    ↓
Repository Ports
    ↓
PostgreSQL Adapter
    ↓
PostgreSQL
```

## Repository Ports Are Not Generic CRUD

Do not design repositories as database-shaped CRUD APIs.

Bad:

```ts
interface ArtifactRepository {
  create(data: any): Promise<any>
  update(data: any): Promise<any>
  delete(id: string): Promise<void>
}
```

Prefer capability-oriented interfaces:

```ts
interface ArtifactRepository {
  findById(id: ArtifactId): Promise<Artifact | null>
  findBySlug(slug: ArtifactSlug): Promise<Artifact | null>
  save(artifact: Artifact): Promise<void>
}
```

Repository interfaces describe what the Application needs, not what PostgreSQL can do.

## ArtifactRepository

```ts
export interface ArtifactRepository {
  findById(id: ArtifactId): Promise<Artifact | null>

  findBySlug(slug: ArtifactSlug): Promise<Artifact | null>

  save(artifact: Artifact): Promise<void>
}
```

Search/discovery should not automatically be mixed into the aggregate repository.

A future `ArtifactSearchRepository` may provide:

```ts
search(criteria: ArtifactSearchCriteria): Promise<ArtifactSummary[]>
```

## ArtifactVersionRepository

```ts
export interface ArtifactVersionRepository {
  findById(id: ArtifactVersionId): Promise<ArtifactVersion | null>

  findByArtifactAndVersion(
    artifactId: ArtifactId,
    version: SemVer,
  ): Promise<ArtifactVersion | null>

  listByArtifact(
    artifactId: ArtifactId,
  ): Promise<ArtifactVersion[]>

  findLatest(
    artifactId: ArtifactId,
  ): Promise<ArtifactVersion | null>

  save(version: ArtifactVersion): Promise<void>
}
```

`findLatest()` must use correct SemVer ordering. Do not rely on naive string ordering for semantic versions.

## LineageRepository

```ts
export interface LineageRepository {
  findParent(
    artifactId: ArtifactId,
  ): Promise<ArtifactId | null>

  listChildren(
    artifactId: ArtifactId,
  ): Promise<ArtifactId[]>

  createForkRelationship(
    relationship: ForkRelationship,
  ): Promise<void>
}
```

Do not add update/delete methods for immutable Fork relationships.

## CompatibilityReportRepository

Compatibility reports are separate persistence entities and point to Artifact Versions.

```ts
export interface CompatibilityReportRepository {
  findById(
    id: CompatibilityReportId,
  ): Promise<CompatibilityReport | null>

  listForVersion(
    versionId: ArtifactVersionId,
  ): Promise<CompatibilityReport[]>

  save(
    report: CompatibilityReport,
  ): Promise<void>
}
```

## Unit of Work

Transaction boundaries are separate from repository capabilities.

Recommended abstraction:

```ts
export interface UnitOfWork {
  execute<T>(
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T>
}
```

Example transaction context:

```ts
export interface TransactionContext {
  artifacts: ArtifactRepository
  versions: ArtifactVersionRepository
  lineage: LineageRepository
}
```

## Atomic Operations

Fork must be atomic:

```text
BEGIN
  Create Artifact
  Create ForkRelationship
COMMIT
```

If either operation fails:

```text
ROLLBACK
```

Delete/Tombstone transition must also be atomic.

The architecture must never permit:

```text
Artifact changed/deleted
    ↓
Tombstone/lineage integrity operation fails
    ↓
inconsistent state
```

## Repository vs UnitOfWork

```text
Repository
    = how to load/save a particular capability/entity

UnitOfWork
    = which changes must commit atomically
```

Do not hide transaction semantics inside individual repository APIs such as:

```ts
artifactRepository.beginTransaction()
```

Transaction orchestration belongs to `UnitOfWork`.

## Persistence Mapping

Never cast database rows directly to Domain entities:

```ts
const artifact = dbRow as Artifact
```

Use explicit mappers:

```text
PostgreSQL Row
    ↓
Persistence Mapper
    ↓
Domain Entity
```

and:

```text
Domain Entity
    ↓
Persistence Mapper
    ↓
PostgreSQL Row
```

Infrastructure owns these mappers.

## Rehydrate vs Create

Domain creation and persistence rehydration are separate concepts.

```ts
Artifact.create(...)
```

creates a new Artifact and enforces creation rules.

```ts
Artifact.rehydrate(...)
```

restores a previously persisted valid state.

Repositories should use explicit rehydration rather than treating a database row as a newly created entity.

## Database Constraints

Database constraints are a final persistence-level integrity layer.

Examples:

```text
Artifact
  id        PRIMARY KEY
  slug      UNIQUE
  owner_id  NOT NULL

ArtifactVersion
  id
  artifact_id  FOREIGN KEY
  version
  UNIQUE(artifact_id, version)

ForkRelationship
  parent_artifact_id
  child_artifact_id
  UNIQUE(child_artifact_id)
```

Exact PostgreSQL schema, indexes, migrations, and SQL implementation are deferred to Chat 2.11.

Important principle:

> **Application validation improves behavior/UX; database constraints guarantee persistence-level integrity.**

Database constraints do not replace Domain business rules.

## Concurrency

Duplicate versions must be protected by database uniqueness as the final guarantee.

Application may perform an early existence check:

```ts
findByArtifactAndVersion(...)
```

but the database unique constraint must still protect against races.

Recommended future optimistic-concurrency boundary:

```ts
save(
  artifact: Artifact,
  expectedRevision: number,
): Promise<void>
```

The exact persisted concurrency field name/implementation is not frozen yet.

## Repository Errors

PostgreSQL-specific errors must not leak into Application/Domain.

Conceptually:

```text
PostgreSQL error
    ↓
Infrastructure adapter
    ↓
Application/domain-level error
    ↓
HTTP error mapping
```

For example, a duplicate version should become:

```text
VersionAlreadyExistsError
```

rather than exposing a PostgreSQL error code.

## Query vs Command

Do not force every read through aggregate repositories.

Potential future query ports:

```text
ArtifactSearchRepository
StatsQuery
CompatibilityQuery
DependencyResolutionRepository
PlaygroundRepository
```

A lightweight CQRS-style separation is acceptable:

```text
Commands
  → Application Use Cases
  → Domain
  → Repository Ports

Queries
  → Query Ports
  → optimized read models/repositories
```

Do **not** introduce full CQRS or Event Sourcing for MVP.

## Event Sourcing

Explicitly out of MVP scope:

```text
Event Sourcing
Event Store
Aggregate Event Replay
Full CQRS event architecture
```

PearlHub already models immutable Versions, lineage, and Tombstones without requiring Event Sourcing.

## Dependency Injection

Production:

```text
Postgres Client
    ↓
Postgres Repository Implementations
    ↓
Application Use Cases
    ↓
Hono Handlers
```

Tests may inject:

```text
In-memory Repository
or
Mock Repository
```

Application code must not change between implementations.

## Suggested PostgreSQL Infrastructure Structure

```text
src/infrastructure/postgres/

├── postgres-client.ts
├── transaction.ts
│
├── repositories/
│   ├── postgres-artifact-repository.ts
│   ├── postgres-version-repository.ts
│   ├── postgres-lineage-repository.ts
│   └── postgres-compatibility-repository.ts
│
└── mappers/
    ├── artifact-mapper.ts
    ├── version-mapper.ts
    └── lineage-mapper.ts
```

---

# 3. Global Copilot Rules

When generating or modifying PearlHub backend code, GitHub Copilot should follow these rules.

## Rule 1 — Layering

```text
HTTP/Hono
    ↓
Application
    ↓
Domain
    ↓
Repository Ports
    ↓
Infrastructure
```

Never reverse these dependencies.

## Rule 2 — No Infrastructure Leakage

Domain/Application must not import:

```text
Hono
Firebase SDK
PostgreSQL driver
ORM
Cloud Run SDK
GCP-specific APIs
Gemini SDK
```

## Rule 3 — No Business Logic in HTTP

Handlers/routes/middleware must not implement Artifact lifecycle or Domain invariants.

## Rule 4 — No Direct Database Access from Use Cases

Use Repository Ports.

## Rule 5 — No Client-Controlled Ownership

Always derive authoritative owner identity from `AuthenticatedPrincipal.userId`.

## Rule 6 — Preserve Immutability

Never add mutation paths for:

```text
Artifact.id
Artifact.name
Artifact.slug
Artifact.ownerId

ArtifactVersion.id
ArtifactVersion.artifactId
ArtifactVersion.version
ArtifactVersion.instructions
ArtifactVersion.knowledgeFiles
ArtifactVersion.contentHash

ForkRelationship
```

## Rule 7 — Tombstone Is Lifecycle, Not Visibility

Never model Tombstone as another visibility enum value.

Correct:

```text
status = Tombstone
visibility = Unlisted
```

## Rule 8 — Preserve Lineage

Delete must not remove Fork relationships.

Fork creates permanent lineage.

Clone creates no PearlHub lineage.

GitHub import creates provenance, not lineage.

## Rule 9 — Domain Invariants Always Apply

Admin authorization does not allow bypassing immutable Domain invariants.

## Rule 10 — Transactions

Operations that create multiple related records atomically must use `UnitOfWork`.

At minimum:

```text
Fork
Delete/Tombstone transition
```

## Rule 11 — Database Is Not the Domain

PostgreSQL constraints protect persistence integrity, but Domain rules remain authoritative business rules.

## Rule 12 — Explicit Mapping

Never use unchecked database-row-to-Domain casts.

## Rule 13 — Framework-Independent Errors

Do not leak Hono or PostgreSQL exceptions into Domain/Application.

## Rule 14 — No Premature Architecture

Do not introduce:

```text
full CQRS
Event Sourcing
microservices
function-per-use-case Cloud Run deployment
```

without a later explicit architectural decision.

## Rule 15 — Portability

PearlHub should remain deployable outside GCP.

Cloud Run is a runtime choice, not a Domain/Application dependency.

---

# 4. Current Frozen Architecture

```text
                         ┌──────────────────────┐
                         │      Client          │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ OpenAPI 3.1 Contract │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ Hono / HTTP Adapter  │
                         │ + Middleware         │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ Application Layer    │
                         │                      │
                         │ Use Cases            │
                         │ Authorization        │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ Domain Layer         │
                         │                      │
                         │ Artifact             │
                         │ Version              │
                         │ Lineage              │
                         │ Dependency           │
                         │ Invariants            │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ Repository Ports     │
                         │ + UnitOfWork         │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ Infrastructure       │
                         │                      │
                         │ PostgreSQL           │
                         │ Firebase Adapter     │
                         │ GitHub Adapter       │
                         │ Storage               │
                         └──────────────────────┘

                         Cloud Run = Runtime
```

---

# 5. Frozen vs Deferred

## Frozen Through 2.10

- OpenAPI 3.1 API contract
- Hono HTTP adapter
- Cloud Run container runtime
- Firebase Authentication prototype
- OIDC/JWT-oriented authentication boundary
- AuthenticatedPrincipal
- Application authorization boundary
- Public / Private / Unlisted semantics
- Tombstone lifecycle semantics
- Admin restore
- Artifact immutable identity fields
- Artifact lifecycle
- Immutable Versions
- SemVer / SemVerRange domain concepts
- ContentHash as canonical-content-derived value
- Fork vs Clone distinction
- GitHub Import as provenance, not lineage
- Application use-case boundaries
- Domain invariant ownership
- Repository Port boundary
- UnitOfWork transaction boundary
- Explicit persistence mapping
- Database constraints as final integrity protection
- No Event Sourcing / full CQRS for MVP
- Dependency injection / composition root
- Portability principle

## Deferred to Later Work

The following are deliberately not frozen here:

- Exact PostgreSQL table definitions
- Exact column types
- Exact indexes
- Exact SQL
- Migration tool and migration layout
- Exact PostgreSQL driver / ORM
- Exact content canonicalization algorithm
- Exact content-hash algorithm
- Exact optimistic-concurrency field
- Exact search implementation
- Semantic search
- Stats implementation
- Dependency resolution implementation
- Playground implementation
- Cloud Run production configuration
- Storage implementation details
- Detailed API endpoint schemas beyond the OpenAPI contract work
- Secret URL generation/storage mechanism
- Full service-principal model
- Full CQRS / event architecture

---

# 6. Next Step

**Chat 2.11 — PostgreSQL Persistence Mapping & Schema Implementation**

Expected focus:

```text
Domain
   ↓
Repository Ports
   ↓
PostgreSQL Adapter
   ↓
Tables / FK / UNIQUE / INDEX
   ↓
Transactions
   ↓
Migrations
```

Chat 2.11 should implement the persistence boundary without changing the frozen Domain/Application architecture above.

---

## PearlHub Terminology

Use **Pearl** / **PearlHub** consistently.

Do not revert to the earlier project terminology “GemHub” / “Gem” in new architecture or implementation unless referring to historical material.
