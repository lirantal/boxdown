# GitHub Release Synchronization Design

## Context

Boxdown publishes npm packages and a release-matched GHCR image from the
`release` workflow. The workflow originally delegated publishing to
`changesets/action`, which also pushed a version tag and created a GitHub
Release from the matching `CHANGELOG.md` section.

The image lifecycle work moved npm publication into a later standalone
`changeset publish` command so image publication, verification, attestation,
and moving-tag updates finish before npm publication. That command cannot
publish the local Git tag or create the GitHub Release, leaving npm releases
2.0.0 and 2.1.0 without GitHub Releases.

## Options considered

1. Restore `publish` on `changesets/action`.
   This recreates releases, but publishes npm before the image lifecycle and
   violates the current release ordering guarantee.

2. Create a dedicated final release phase in the existing workflow.
   This preserves the image-before-npm contract, explicitly creates an
   annotated tag at the recorded release merge commit, and creates a GitHub
   Release using the existing Changesets changelog entry. This is the selected
   approach.

3. Add an independent tag-triggered release workflow.
   This separates concerns but introduces cross-workflow ordering and retry
   coordination, and is unnecessary for this single-package repository.

## Design

The release-state step will decide whether image and npm work is required from
npm registry metadata. A final GitHub Release helper runs on every successful
workflow execution and independently inspects the release and tag state for
`v<version>`.

The npm publication step will call Changesets with `--no-git-tag`. This avoids
an ephemeral tag at the workflow event SHA, which can differ from the release
merge commit when a failed release is retried.

After npm publication and all image checks, a final GitHub Release phase runs
on every successful workflow execution. It verifies correct existing release
state and repairs a missing release after npm is already published.

The phase will use `release_revision` as the tag target. It will create and
push an annotated `v<version>` tag only when missing, reject an existing tag
that points elsewhere, extract the exact matching entry from `CHANGELOG.md`,
and create the GitHub Release if absent. It will verify the resulting release
references the expected tag and commit.

This makes retries safe at every boundary:

- image/npm publication may be skipped after they already succeeded;
- a missing GitHub Release is repaired on a later main-branch run;
- an existing correct tag/release is left untouched; and
- an existing mismatched tag causes a visible failure rather than a silent,
  incorrectly-targeted release.

## Components

- `.github/workflows/release.yml` disables Changesets' automatic local tag and
  invokes the final release phase after npm publication on every successful
  workflow run.
- `scripts/create-github-release.ts` owns changelog extraction, release/tag
  validation, and the GitHub API calls. It receives release identity through
  environment variables so the workflow remains declarative.
- `__tests__/github-release.test.ts` verifies the helper's changelog and
  decision behavior. The existing workflow policy test verifies the release
  phase runs after npm publication and receives the release revision.
- `RELEASE.md` documents that normal releases are automated and describes the
  recovery behavior for a missing GitHub Release.

## Backfill

After the workflow repair is merged, create releases with the exact existing
changelog content for:

- `v2.0.0` targeting `29363c0b778cede34d0fa2ed591ddb3e7bed3cb5`.
- `v2.1.0` targeting `cc8a7ea3998066e1f4f7327e998220f68721163f`.

`v1.0.0` is an older npm-only release and may be backfilled separately for
complete historical parity. It is not required to repair the 2.x regression.

## Testing

Tests will be written before implementation. They will cover changelog entry
extraction, existing-release no-op behavior, missing-release repair behavior,
and mismatched-tag rejection. The release workflow policy test will assert
that GitHub Release creation follows npm publication and uses
`release_revision`, not `github.sha`.
