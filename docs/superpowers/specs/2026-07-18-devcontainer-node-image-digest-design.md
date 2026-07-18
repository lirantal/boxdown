# Devcontainer Node Image Digest Pinning

## Goal

Make Boxdown's packaged devcontainer base image reproducible across rebuilds
and host architectures while preserving the existing Node 24, Debian trixie,
and slim-image track. Keep the immutable image reference current through
reviewable automated pull requests.

## Scope

This change applies to the reusable devcontainer template at
`assets/devcontainer/devcontainer.json`. It does not change Boxdown's runtime
generation model, the Dev Container Feature pins, npm dependency automation,
or GitHub Actions dependency automation.

## Image Reference

The template will replace the mutable reference:

```text
node:24-trixie-slim
```

with the same tag plus `@sha256:` and the verified 64-hex-character
multi-platform index digest.

The implementation will resolve the current digest from the upstream Node
image registry and verify that it identifies the multi-platform image index,
not an architecture-specific child manifest. Keeping the tag documents the
intended Node 24 and Debian trixie slim update track. The digest makes the
actual selected index immutable, so AMD64 and ARM64 hosts resolve their
platform image from the same pinned release set.

The tag deliberately remains at Node major-version precision. Node patch
releases and upstream rebuilds stay explicit through digest-update pull
requests without moving Boxdown to another Node major or Debian variant.

## Update Automation

A root `renovate.json` will configure Renovate's native devcontainer manager.
The configuration will:

- enable only the devcontainer manager, avoiding overlap with the existing
  Dependabot npm and GitHub Actions configuration;
- extend devcontainer file matching to
  `assets/devcontainer/devcontainer.json`, which is outside Renovate's default
  root `.devcontainer` locations;
- disable Dev Container Feature updates so the existing digest-pinned Feature
  set remains outside this change;
- match only the `node` image dependency in the packaged template;
- preserve the `24-trixie-slim` tag and update its digest; and
- allow digest-refresh pull requests on a monthly schedule.

The Renovate GitHub app performs the registry lookup and opens the pull
request. Boxdown does not add a repository-owned scheduled workflow or a
repository token. Enabling the app for the repository is an operational
prerequisite outside the committed code.

## Documentation

The packaged devcontainer README will describe the tag-plus-index-digest
reference, its cross-platform reproducibility property, and Renovate's role in
refreshing it through auditable pull requests. Existing documentation about
the Node 24 trixie slim base and digest-pinned Features remains accurate.

## Test Strategy

A focused repository test will read the packaged devcontainer source and
assert that:

- its base image is exactly the intended `node:24-trixie-slim` tag followed by
  a 64-hex-character SHA-256 digest;
- the Renovate configuration enables only the devcontainer manager;
- the additional manager file pattern covers the packaged template;
- Feature dependencies are disabled; and
- the Node image rule enables digest pinning on the monthly schedule.

The test will be added before the production configuration changes and must be
observed failing for the missing digest and Renovate configuration. After the
change, verification will run the focused test, full test suite, lint, build,
JSON and JSON-with-comments parsing, registry inspection of the pinned index,
and `git diff --check`.

## Alternatives Considered

### Dependabot through a Dockerfile

Moving the base reference into a Dockerfile would let Dependabot's Docker
ecosystem update it, but it would change the devcontainer architecture solely
to accommodate the updater. GitHub's `devcontainers` ecosystem updates
Features rather than the `image` field, so it cannot directly maintain the
current template.

### Repository-owned scheduled workflow

A custom workflow could resolve the tag, edit the digest, and open pull
requests. It would duplicate registry, scheduling, authentication, and pull
request behavior already provided by Renovate and would add workflow and token
maintenance.

## Decision Record

Use Renovate's native devcontainer support and retain the human-readable
`node:24-trixie-slim` tag. Pin the verified multi-platform index digest and
scope automation to only that image in the packaged template. This yields
immutable rebuild inputs without broadening Boxdown's dependency automation
or changing its generated-devcontainer architecture.
