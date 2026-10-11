# 04 — Application Services

Application services implement business use cases.

They may depend on repository interfaces, content-store interfaces, and transaction abstractions.

They must not depend on HTTP framework types.

## CreateArtifact

Input:

- actor/owner ID
- name
- slug
- visibility

Rules:

- validate name
- validate slug
- enforce owner-scoped uniqueness
- create active Artifact
- do not create a version automatically unless explicitly part of the command

## PublishVersion

Input:

- actor ID
- Artifact ID
- SemVer
- canonical Pearl content

Steps:

1. authorize actor
2. verify Artifact exists and is active
3. validate SemVer 2.x
4. canonicalize content
5. calculate content hash
6. store immutable content
7. create Artifact Version
8. create dependency declarations if present

A published version cannot be modified.

## ForkArtifact

Input:

- actor ID
- source Artifact ID
- new name
- new slug

Steps:

1. authorize source access
2. create new Artifact
3. establish `fork` lineage
4. copy the selected source content/version according to the application command
5. never mutate the source
6. copy dependency declarations to the new Artifact Version without copying dependency resolutions

## CloneArtifact

Create a new Artifact from source content and dependency declarations without creating PearlHub lineage. Dependency resolutions are not copied.

## DeleteArtifact

Delete means:

1. verify actor permission
2. atomically preserve a complete immutable snapshot and change status to `tombstone`
3. change visibility to `unlisted`
4. preserve lineage

No physical Artifact deletion.

Repeated delete of an already tombstoned Artifact is idempotent. If an Admin restores
the Artifact and it is later deleted again, the later transition appends another
snapshot rather than modifying the earlier one.

## RestoreArtifact

1. authorize the Admin restore operation
2. load the latest immutable pre-delete Artifact snapshot
3. restore the same Artifact ID, owner, name, and slug, using the captured visibility
4. retain the snapshot and all historical versions and lineage

The database snapshot stores immutable content hashes and locations, not content-store
objects. Successful content restoration therefore relies on the content store retaining
those referenced objects; a PostgreSQL transaction cannot provide cross-store rollback.

## ImportGitHub

Input:

- actor ID
- source URL

Steps:

1. fetch source
2. validate Pearl format
3. canonicalize content
4. calculate content hash
5. create Artifact/Version
6. create provenance metadata
7. do NOT create Fork lineage

## ResolveDependencies

Given dependency declarations:

1. interpret SemVer ranges
2. find compatible Artifact Versions
3. choose a resolved version according to resolver policy
4. record declared range and resolved Artifact Version

The resolver must never mutate a published Artifact Version.

## CreateCompatibilityReport

Create a report associated with a specific Artifact Version and optional target Artifact Version.
