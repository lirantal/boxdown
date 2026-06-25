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

## External App Integrations

External app configuration is always explicit. For example,
`boxdown ssh-config install --target codex` writes Codex app remote project
configuration under `~/.codex/codex-app/config.json`, but it does not make that
file part of Boxdown workspace state.

Boxdown writes the Codex app config entry needed to point Codex at the
Boxdown-managed SSH alias and container-side project path. On uninstall, it also
removes the matching Codex global-state sidebar cache entry that Codex derived
from that app config. Other Codex global state remains Codex-owned.

## Container Asset Mounts

The generated config mounts `assets/devcontainer/` read-only into the container
at `/opt/boxdown/devcontainer`.

When the host has `~/.agents`, the generated config also mounts it read-only at
`/home/node/.agents` so host-global agent configuration is available inside the
container without being copied into target repositories.

When the host has file-backed Codex auth at `~/.codex/auth.json`, the generated
config mounts that single file read-only at `/home/node/.codex/auth.json`. It
does not mount the full host `~/.codex` directory.

The container receives only a public SSH key mount. The private host key stays
on the host and is referenced from the user's SSH config.

## Container Lifecycle Tooling

Boxdown-owned container assets install and refresh development tooling from
inside the devcontainer lifecycle. Coding-agent CLIs are refreshed through a
shared mounted utility: post-create runs an immediate install/update, while
post-start and SSH proxy setup run throttled best-effort refreshes for
already-running containers.

Tool refreshes are container-side behavior, not generated config schema.
Failures should warn without making the devcontainer unusable. SSH proxy
refresh output must stay off stdout because stdout carries SSH traffic. Locking
and throttling belong in the shared helper so individual hooks do not duplicate
update logic.

## Important Invariants

- Boxdown must not create `.devcontainer/` in target repositories.
- Boxdown must not package or mount generated `.ssh/` private key material.
- Lifecycle scripts must work when run from mounted assets, not only from a
  repo-local `.devcontainer/` directory.
- SSH aliases must be workspace-specific and idempotently replaceable.
- `gh-cp` is a source for current devcontainer assets, but Boxdown must not
  modify the `gh-cp` repository.
