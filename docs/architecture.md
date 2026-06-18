# Architecture

## Project Shape

Boxdown is a Node.js CLI package. The public contract is the `boxdown` binary,
not a JavaScript API.

Important directories:

- `src/` contains CLI orchestration, config generation, state resolution, and
  SSH helpers.
- `assets/devcontainer/` contains reusable devcontainer source copied from
  `gh-cp/.devcontainer`.
- `docs/` contains project and feature documentation.
- `__tests__/` contains unit tests for pure behavior.

## Runtime Model

Boxdown does not copy `.devcontainer/` into consumer repositories. Instead it:

1. Resolves the target workspace from `process.cwd()` or `--workspace`.
2. Creates per-workspace cache and data paths.
3. Ensures a per-workspace SSH key pair exists.
4. Generates a `devcontainer.json` outside the target repository.
5. Runs the Dev Containers CLI with `--workspace-folder` and
   `--override-config`.

This makes the target repository the workspace while Boxdown remains the owner
of reusable configuration and runtime assets.

## State Boundaries

Cache-like state belongs under `~/.cache/boxdown` or `BOXDOWN_CACHE_HOME`.
Persistent user state belongs under `~/.local/share/boxdown` or
`BOXDOWN_DATA_HOME`.

Per-workspace state is keyed by a hash of the resolved workspace path. This
prevents collisions between repositories with the same basename in different
folders.

## Container Asset Mounts

The generated config mounts `assets/devcontainer/` read-only into the container
at `/opt/boxdown/devcontainer`.

The container receives only a public SSH key mount. The private host key stays
on the host and is referenced from the user's SSH config.

## Important Invariants

- Boxdown must not create `.devcontainer/` in target repositories.
- Boxdown must not package or mount generated `.ssh/` private key material.
- Lifecycle scripts must work when run from mounted assets, not only from a
  repo-local `.devcontainer/` directory.
- SSH aliases must be workspace-specific and idempotently replaceable.
- `gh-cp` is a source for current devcontainer assets, but Boxdown must not
  modify the `gh-cp` repository.
