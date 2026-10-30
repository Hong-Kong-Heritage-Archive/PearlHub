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

## UpdateArtifactMetadata

Input:

- authenticated actor ID
- Artifact ID
- partial metadata containing `visibility`

Rules:

- only the Artifact owner may update metadata
- visibility must be `private`, `unlisted`, or `public`
- `visibility` is currently the only mutable Artifact metadata field
- identity, lifecycle state, Versions, content, dependencies, lineage, and provenance remain unchanged
- do not create a Draft or Artifact Version

## GetArtifactVersionDependencies

Input:

- caller ID, if authenticated
- Artifact ID
- exact published Version SemVer

Rules:

- use the existing Artifact and Version read-authorization policy
- return only declarations recorded for the exact Version
- include persisted resolution history only through the declaration's stored resolution records
- return resolved SemVer values, not internal database identifiers
- an absent resolution is an empty history; do not calculate or persist a resolution during GET
- do not return target Artifact metadata

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

Input:

- actor ID
- source Artifact ID
- exact source Version SemVer
- new name, slug, and initial visibility

Steps:

1. authorize source access using the existing read policy
2. verify the source Artifact is active and the exact Version exists
3. reject a missing or incomplete immutable content snapshot
4. create a private owner-bound Draft with the selected Version's content and dependency declarations
5. do not set Fork origin or provenance
6. publish only through the existing Draft Publish workflow, creating the new Artifact and initial `0.1.0` Version atomically
7. do not create PearlHub lineage or copy dependency resolutions

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
3. choose the highest eligible version by SemVer precedence, not lexical
   string ordering; prerelease versions are excluded by default
4. record declared range and resolved Artifact Version

The resolver must never mutate a published Artifact Version.

## CreateCompatibilityReport

Create a report associated with a specific Artifact Version and optional target Artifact Version.
