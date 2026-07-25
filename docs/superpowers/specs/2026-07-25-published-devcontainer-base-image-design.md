# Published Devcontainer Base Image

## Goal

Replace Boxdown's per-machine Dev Container Feature build with a public,
release-matched multi-platform image published to GitHub Container Registry
(GHCR). A fresh `boxdown start` or `boxdown setup` should pull a prepared
image instead of building Features and installing Boxdown's shared tools on the
user's machine.

The change keeps Boxdown's workspace-specific configuration, secret handling,
SSH proxy, and coding-agent refresh behavior. It makes the shared toolchain a
CI-built product artifact.

## Current State

Boxdown does not currently have a Dockerfile. Its packaged
`assets/devcontainer/devcontainer.json` uses the pinned
`node:24-trixie-slim` image and six Dev Container Features. The Dev Containers
CLI applies those Features by building a derived image locally. Its
`postCreateCommand` then installs OpenSSH, Python, APM, Codex, Claude Code,
1Password CLI, Snyk, and workspace dependencies. Codex and Claude Code are
also refreshed by a throttled helper during later starts.

This has two costs on a cold machine: the user needs a working local Buildx
environment and must wait for Feature/tool downloads before the container is
ready. It also permits differences caused by local cache state and installer
availability.

## Scope

This design adds a published base image, its CI/release lifecycle, package
version synchronization, validation, migration messaging, and documentation.

It does not add a generic tool-update command, change the existing runtime
mount boundaries, package credentials or workspace files into an image, or
automatically recreate existing containers. Python opt-in is a future feature;
this change preserves the existing bootstrap script as its implementation
primitive but does not add a new Python command or option.

## Image Contents

### Base and platforms

The image is built from the same digest-pinned `node:24-trixie-slim` OCI index
that Boxdown currently uses. Each release publishes one OCI manifest list with
`linux/amd64` and `linux/arm64` child images. Docker selects the appropriate
child image for the user's machine.

The Dockerfile uses the existing non-root `node` user as its runtime user. It
uses `apt-get` with `--no-install-recommends`, deletes apt/package-manager
caches in the same layer, and deletes temporary installers and download
archives. It must not copy the repository, workspace dependencies, secrets,
SSH material, or host configuration into the final image.

### Default tools

The image contains only the common Boxdown runtime and the agreed default
tooling:

- Node 24 and its npm runtime from the upstream base image;
- Git, sudo/common shell utilities, ripgrep, GitHub CLI, and OpenSSH server;
- Codex and Claude Code;
- Snyk, 1Password CLI, and Agent Package Manager (APM).

The image build installs every downloaded third-party binary from a
version/checksum lock manifest. Platform-specific URLs and checksums are
explicit. OCI labels identify the source repository, source revision, Boxdown
package version, and tool-lock revision.

### Deliberately lazy tooling

The image excludes Python, pipx, uv, OpenCode, and Antigravity. It also
excludes project dependencies. Python's existing `python-bootstrap.sh` remains
available for a future explicit, persisted per-workspace Python opt-in; when
that feature is introduced, it will run inside the workspace container and
will rerun after a deliberate recreation. OpenCode and Antigravity retain the
existing lazy `ensure` behavior when their Boxdown commands are invoked.

`deps-install.sh` remains a post-create concern because dependencies belong to
the workspace, not the shared image.

## Devcontainer and Lifecycle Changes

The packaged `assets/devcontainer/devcontainer.json` changes from a Node image
plus `features` and `overrideFeatureInstallOrder` to a single
release-matched GHCR `image` reference. It keeps ports, runtime mounts,
remote-user configuration, and lifecycle command declarations. The generated
per-workspace config continues to mount the packaged Boxdown assets at
`/opt/boxdown/devcontainer`, so existing lifecycle scripts remain callable.

`postCreateCommand` is reduced to workspace-specific work:

- copy/sanitize Git configuration and configure optional commit signing;
- source Boxdown runtime secrets;
- configure workspace Git settings;
- create SSH runtime state and authorize the workspace public key; and
- install workspace dependencies.

It no longer installs the shared image tools. `postStartCommand` still prepares
the SSH runtime and calls the existing throttled Codex/Claude update helper.
The image build creates valid initial stamps for that helper under the `node`
user's home directory, preventing a newly created container from immediately
performing an update check. Once the existing interval has elapsed, Codex and
Claude continue to refresh in the writable workspace container exactly as they
do today.

Snyk, 1Password CLI, and APM are fixed at the version of the base image. They
advance through a later Boxdown release and a deliberate container recreation;
there is no new `boxdown tools update` command.

## Image Identity and Version Synchronization

Every published package version maps to a full image tag:

```text
ghcr.io/lirantal/boxdown:<package-version>
```

For example, `boxdown@1.4.0` references
`ghcr.io/lirantal/boxdown:1.4.0`. Boxdown only consumes full package-version
tags. The release workflow may also publish `1` and `latest` for humans, but
the CLI never references moving tags.

The Changesets version command is extended to synchronize the image reference
in packaged devcontainer assets after it updates `package.json`. A repository
test asserts that the packaged image tag exactly equals the package version.

Version tags are write-once by release policy. Before publishing, CI checks
whether the tag already exists. It may reuse it only when its OCI labels match
the expected source revision and version; a mismatched existing tag fails the
release. This makes retrying an npm publication safe without permitting an
image tag to be retargeted.

## CI and Release Design

### Pull-request image validation

A new CI job runs when image inputs change: the Dockerfile and its helper or
lock files, devcontainer-image configuration, image tests, or image workflow
files. It builds the image without pushing, runs smoke tests as the non-root
`node` user, and verifies that the declared tools are executable:

- `node`, `git`, `gh`, `rg`, and `sshd`;
- `codex` and `claude`;
- `snyk`, `op`, and `apm`.

The job has no `packages: write` permission and never pushes from a pull
request, including from a fork. It records the measured image size and enforces
a checked-in budget. The first accepted implementation establishes the
baseline; later changes must stay within the documented allowed growth or
intentionally update the budget in review.

### Release publication

The existing release workflow continues to let Changesets create a release PR.
When the versioned release PR merges, its publish command becomes an ordered
release wrapper:

1. Determine the synchronized package/image version.
2. Set up QEMU and Buildx and authenticate to `ghcr.io` with the repository
   `GITHUB_TOKEN`.
3. Build, smoke-test, and push the AMD64/ARM64 manifest under the immutable
   full-version tag, then update the human-only moving tags.
4. Attach SBOM and build-provenance attestations, and verify the manifest has
   both required platforms and expected OCI labels.
5. Publish the npm package with Changesets.

The release job has only the permissions needed for this work: `contents: read`,
`packages: write`, `attestations: write`, and `id-token: write`, plus the
existing Changesets release permissions where required. Publishing the image
before npm guarantees that users cannot install an npm package whose referenced
image is missing.

If image publication fails, the npm publishing command does not run. If npm
publication fails after the image is present, a retry validates/reuses the
identical immutable tag before retrying npm publication. The workflow never
silently repoints a versioned tag.

### GHCR operation

The image name is `ghcr.io/lirantal/boxdown`. The Dockerfile adds the
`org.opencontainers.image.source` label so GitHub links the package to this
repository. The first publication creates a package that is private by default;
an administrator must set that container package to public once and confirm an
anonymous `docker pull`. Thereafter, Boxdown users require no registry login.

## Migration and User Experience

New workspaces pull the matching published image. The generated configuration
contains no Features, so the Dev Containers CLI does not invoke a local Feature
or Dockerfile build.

Existing Boxdown containers are deliberately not changed merely because the
user upgrades Boxdown. If Boxdown sees that a running or reused workspace is
backed by a legacy locally-built image, it prints a one-time actionable notice:

```text
This workspace uses Boxdown's legacy locally-built devcontainer image.
Run `boxdown start --recreate` to switch to the published Boxdown image.
```

`boxdown start --recreate` and `boxdown setup --recreate` are the explicit
migration paths. Existing containers remain functional until then. Existing
purge behavior continues to remove only the container image recorded for that
workspace; Boxdown does not delete shared image caches or old Feature caches
globally.

An unauthenticated-registry, missing-tag, or image-pull failure is surfaced as
the existing `devcontainer up` failure with its command log. Boxdown does not
fall back to building locally: doing so would conceal release/registry failures
and make the environment non-reproducible.

## Verification

Implementation must add or update tests for:

- synchronization between package version and GHCR image reference;
- absence of Dev Container Features in the generated packaged configuration;
- lock-manifest validity, supported platform coverage, and Dockerfile input
  policy;
- legacy-image detection and migration notice without forced recreation;
- generated configuration and lifecycle preservation for secrets, SSH,
  signing, ports, and agent mounts;
- coding-agent initial stamps and the continued throttled Codex/Claude refresh
  behavior;
- image smoke tests for every required default command as `node`;
- multi-platform release-manifest contents, OCI labels, SBOM/provenance
  publication, and size-budget enforcement; and
- release failure ordering: image publication failure prevents npm publication,
  while a retry only reuses an identical version tag.

Before merge, run focused Node tests, the full test suite, lint, build, shell
syntax checks for affected scripts, Dockerfile/image validation, and
`git diff --check`. The release workflow verifies the pushed manifest and its
attestations before npm publication.

## Alternatives Considered

### Retain local Dev Container Feature builds

This has no new registry-release lifecycle, but it keeps cold starts dependent
on local Buildx, Feature resolution, tool installers, and individual cache
state. It is less appropriate for Boxdown's reusable, opinionated base
environment.

### Publish an image from every `main` commit

This would make image changes available more quickly but permits an installed
npm package to consume a base image built from different source. It also makes
debugging and rollback less clear. Release-coupled tags make the package/image
contract explicit.

### Put every optional tool in the base image

Including Python development tooling, OpenCode, Antigravity, and workspace
dependencies would increase cold-pull time and image size for users who do not
need them. The chosen baseline contains the agreed common tools and leaves the
rest lazy.

### Add a generic `boxdown tools update` command

This would duplicate the current coding-agent refresh mechanism and blur the
boundary between an immutable published baseline and workspace-local updates.
Codex and Claude retain their existing automatic throttled refresh; the other
base tools advance with Boxdown image releases.

## Decision Record

Use a public, release-coupled, AMD64/ARM64 GHCR base image for Boxdown. Keep
the default image small by including the common runtime, Codex, Claude Code,
Snyk, 1Password CLI, and APM, while retaining Python and optional agents as
lazy capabilities. Preserve workspace-local hooks, secret boundaries, SSH
behavior, and Codex/Claude update cadence. Require explicit recreation for
legacy workspaces, and make CI image publication a prerequisite for npm
publication.
