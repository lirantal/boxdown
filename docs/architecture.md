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

New containers pull the public image whose tag exactly matches the installed
Boxdown version, `ghcr.io/lirantal/boxdown:<Boxdown-version>`. They do not
build Dev Container Features or shared tools locally. An uncached pull needs
network access but no GHCR login.

## State Boundaries

Cache-like state belongs under `~/.cache/boxdown` or `BOXDOWN_CACHE_HOME`.
Persistent user state belongs under `~/.local/share/boxdown` or
`BOXDOWN_DATA_HOME`.

Per-workspace state is keyed by a hash of the resolved workspace path. This
prevents collisions between repositories with the same basename in different
folders.

## Workspace Toolchains

Toolchain detection is a pure, root-only resolver. It reads only documented
marker files for Node.js, Python, Go, and Rust, validates their narrow formats,
and resolves a release-pinned version before any container lifecycle work. The
resolver returns a Boxdown-owned plan with evidence, selection source,
resolution source, compatibility notes, and a stable fingerprint. It does not
execute repository configuration or write to the repository.

The generated configuration is the external-state boundary: a confirmed plan
is mounted read-only and its lifecycle result directory is mounted read-write.
Container hooks consume only the mounted resolved plan, keeping runtime
installations, `mise` state, activation wrappers, and completion fingerprints
inside the container user's local state. A release-pinned `mise` runs with
configuration loading disabled, so repository `mise.toml`, `.tool-versions`,
hooks, tasks, and environment files cannot influence provisioning.

The plan/result fingerprint lets post-start retry failed provisioning or
dependency synchronization without treating a failed toolchain as a failed
container. Status consumes only these Boxdown-owned records. Adding the first
plan to a legacy container requires recreation because mounts are a container
create-time property.

## External App Integrations

External app configuration is optional. `boxdown setup` and `boxdown ssh
install` ask about optional targets in interactive terminals, while
non-interactive runs skip them unless `--target` is provided. For example,
`boxdown setup --target codex` or `boxdown ssh install --target codex` writes
Codex app remote project configuration under `~/.codex/codex-app/config.json`,
and `--target claude` writes Claude app SSH remote configuration under
`~/Library/Application Support/Claude/ssh_configs.json`, but neither file
becomes Boxdown workspace state.

Boxdown writes the Codex app config entry needed to point Codex at the
Boxdown-managed SSH alias and canonical container-side project path,
`/workspaces/<repo-name>`. On install, it migrates matching older
`/home/node/<repo-name>` project entries for the same alias. On uninstall, it
removes matching Codex app/sidebar entries for both the canonical and legacy
paths. Other Codex global state remains Codex-owned.

Boxdown writes the Claude SSH remote entry needed to point Claude at the same
Boxdown-managed SSH alias. On uninstall, it removes that matching Claude SSH
remote and trusted-host entry.

Each app integration is independently removable through `boxdown ssh uninstall
--target <name>`, which preserves the Boxdown-managed SSH alias. The target
registry owns each integration's lifecycle so future targets can participate in
the same cleanup flow. `boxdown ssh uninstall` without `--target` and
`boxdown purge` both perform full cleanup, removing the alias and all known
integrations.

## Container Asset Mounts

The generated config mounts `assets/devcontainer/` read-only into the container
at `/opt/boxdown/devcontainer`.

The `auth` default uses read-only staging mounts below
`/opt/boxdown/agent-profile-source`, then the post-create bootstrap makes a
container-local writable copy of supported file-backed authentication and the
complete host `~/.agents` tree. Changes to that copy do not write back to the
host.

The `full` tier instead exposes available host `~/.agents`, Codex, and Claude
profiles as live, read-write mounts at their canonical container destinations.
Changes made inside the container affect the host immediately. The `none` tier
omits host user-scoped profile data. Repository-scoped agent configuration is
outside this boundary because the workspace mount exposes it in every tier.

A custom mount at, above, or below a canonical profile destination is externally
managed. Boxdown skips the matching profile staging source and bootstrap copy,
or the corresponding `full` live mount, so custom-mount ownership and write
policy remain with the custom mount.

Profile lifecycle has three truth points:

```text
metadata selection -> generated profile intent -> container applied marker
```

Workspace metadata records the selected tier, generated configuration records
the source availability and create-time mount or copy intent, and the bootstrap
writes the container-local marker after setup succeeds. The generated config
also records Boxdown-managed `full` mounts by logical source name in
`BOXDOWN_AGENT_PROFILE_MANAGED_SOURCES`, without duplicating host paths in that
provenance metadata, so status can distinguish them from preserved user mounts.
`auth` writes its marker after a successful copy;
`full` writes `full:live` without copying profile data. Status compares all
three truth points. A mismatch requires recreation because Docker cannot add or
replace create-time mounts in an existing container. A legacy `full` marker
therefore requires recreation, while host changes under an active `full:live`
profile are visible immediately.

The container receives only a public SSH key mount. The private host key stays
on the host and is referenced from the user's SSH config.

## Container Lifecycle Tooling

The release image contains the shared tools: Codex, Claude Code, Snyk,
1Password, and APM on AMD64. OpenCode and Antigravity are still lazy installs.
The image contains no workspace or credentials; generated configuration supplies
workspace mounts and runtime credentials only when a container is created.

Container lifecycle hooks configure the workspace and SSH runtime. Codex and
Claude retain throttled best-effort refreshes during post-start and SSH proxy
setup, allowing their npm-backed installations to update without changing the
release image. Snyk, 1Password, and AMD64 APM update only through a Boxdown
release followed by recreation. APM is deferred on ARM64 until the user
explicitly opts into a Python-based installation.

Tool refreshes are container-side behavior, not generated config schema.
Failures should warn without making the devcontainer unusable. SSH proxy
refresh output must stay off stdout because stdout carries SSH traffic. Locking
and throttling belong in the shared helper so individual hooks do not duplicate
update logic.

## Important Invariants

- Boxdown must not create `.devcontainer/` in target repositories.
- Boxdown must not package or mount generated `.ssh/` private key material.
- The release image must not contain user workspaces or credentials.
- Lifecycle scripts must work when run from mounted assets, not only from a
  repo-local `.devcontainer/` directory.
- SSH aliases must be workspace-specific and idempotently replaceable.
- `gh-cp` is a source for current devcontainer assets, but Boxdown must not
  modify the `gh-cp` repository.
