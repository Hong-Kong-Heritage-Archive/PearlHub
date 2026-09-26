# 01 — Domain Model

## Artifact

An Artifact is the stable identity of a Pearl.

Fields:

- `id`
- `ownerId`
- `name`
- `slug`
- `visibility`
- `status`
- `createdAt`
- `updatedAt`

### Immutable identity

The following are immutable after creation:

- `name`
- `slug`
- `ownerId`

Slug uniqueness is owner-scoped:

`UNIQUE(owner_id, slug)`

Example:

- `@alice/my-pearl`
- `@bob/my-pearl`

may both exist.

## Visibility

- `private`
- `unlisted`
- `public`

## Status

- `active`
- `tombstone`

Visibility and status are separate concepts.

A deleted Artifact becomes:

- `status = tombstone`
- `visibility = unlisted`

The Artifact is not physically deleted.

## Artifact Version

Fields:

- `id`
- `artifactId`
- `version`
- `contentHash`
- `contentLocation`
- `createdAt`
- `publishedAt`

Version format is SemVer 2.x.

Examples:

- `1.0.0`
- `1.1.0`
- `1.1.1`
- `2.0.0`

Do not use `v1`, `latest`, `stable`, or date strings as version identities.

Published versions are immutable.

`latest` may exist as an API/resolver convenience concept, but is not a version.

## Lineage

Fork creates permanent PearlHub lineage.

Clone creates no PearlHub lineage.

GitHub Import creates provenance metadata and is not a Fork.

MVP lineage relationship type:

- `fork`

No Merge or Branch in v0.1.

## Dependency

A dependency belongs to an Artifact Version.

Fields:

- source `artifactVersionId`
- target `artifactId`
- `declaredRange`

The declared range is a SemVer range such as `^2.1.0`.

A dependency resolution records:

- declared range through the dependency
- resolved `ArtifactVersionId`
- resolution timestamp

## Compatibility Report

A compatibility report points to an Artifact Version.

It may optionally point to a target Artifact Version.

The report payload is stored as structured JSON.

## Provenance

Provenance is separate from lineage.

A GitHub import records source metadata such as:

- source type
- source URL
- source ref
- import time

It must not create a Fork lineage relationship.

## Pearl Content

The canonical Pearl content is a JSON object with a SemVer 2.x `version`, a `skill` object, and a `knowledge` array. Nested Skill and Knowledge fields are extensible JSON; this contract does not define additional field-level requirements.

For v0.1, Skill is an Artifact/Embedded Skill hybrid rather than a separate Artifact identity.

The domain parser rejects non-JSON values and malformed top-level structure. GitHub-imported content without a version is rejected; no defaulting rule is defined. The GitHub source ref remains provenance metadata and is not used as the Pearl version.

The domain model should not depend on a particular object-storage provider.
