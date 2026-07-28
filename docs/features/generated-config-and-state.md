# Generated Config and State

## Why Generate Config

The reusable devcontainer source is packaged with Boxdown, not copied into
target repositories. A literal packaged `devcontainer.json` still contains
repo-local lifecycle paths, so Boxdown generates a workspace-specific override
config before starting a container.

The generated config lets Boxdown keep target repositories clean while still
using the Dev Containers CLI as the lifecycle owner.

## Config Location

Generated config is written under:

```text
~/.cache/boxdown/workspaces/<workspace-hash>/devcontainer.json
```

`BOXDOWN_CACHE_HOME` overrides the cache root. `XDG_CACHE_HOME` is honored when
the Boxdown-specific override is not set.

## Persistent State

Workspace data is written under:

```text
~/.local/share/boxdown/workspaces/<workspace-hash>/
```

`BOXDOWN_DATA_HOME` overrides the data root. `XDG_DATA_HOME` is honored when the
Boxdown-specific override is not set.

SSH private keys live in persistent data. A public-key-only runtime directory is
used for the container mount.

Boxdown-managed lifecycle command output is appended to one per-workspace log
file:

```text
~/.local/share/boxdown/workspaces/<workspace-hash>/boxdown.log
```

The log is append-only across lifecycle runs. Each run starts a timestamped
section and records Boxdown-managed command output, Docker/devcontainer child
process output, and command exit codes. Full interactive shell, agent, and
tunnel session bytes are not tee'd into the log.

The log lives with the workspace's persistent data so `boxdown status` can show
its path and `boxdown purge` removes it with the rest of the workspace data.

Each touched workspace also records inventory metadata at:

```text
~/.local/share/boxdown/workspaces/<workspace-hash>/metadata.json
```

`boxdown list` reads these metadata files as its source of truth, then enriches
entries with best-effort Docker state.

Metadata may also record the last inspected Docker image ID for the workspace so
`boxdown purge` can remove that exact image even after the container is gone.

## Runtime Secret State

`ANTHROPIC_API_KEY`, `SNYK_TOKEN`, and the optional 1Password service-account
token are written to owner-only files in a per-workspace runtime directory,
separate from persistent workspace data. Boxdown mounts that directory
read-only at `/run/boxdown/secrets`; only non-secret mount and Bash-bootstrap
paths appear in generated Docker configuration. The `none` agent profile
suppresses `ANTHROPIC_API_KEY`; the other runtime secrets are unchanged.

Bash sessions load available files as ordinary environment variables. Missing
host values and failed 1Password lookup are non-blocking. `boxdown down` and
`boxdown purge` remove the workspace runtime directory after container removal.
Boxdown does not use or modify project `.env.development` files.

## Agent profile staging and authentication

Every agent profile source is mounted at a read-only staging path below
`/opt/boxdown/agent-profile-source`. During container creation, the profile
bootstrap makes container-local writable copies in the canonical homes:
`/home/node/.agents`, `/home/node/.codex`, `/home/node/.claude`, and, when
applicable, `/home/node/.claude.json`. Boxdown never mounts a selected host
source at one of those canonical destinations, and there is no reverse
synchronization from the container to the host.

`auth` stages the complete `~/.agents` tree, available file-backed Codex auth,
and available supported file-backed Claude credentials. On Linux and WSL, the
Claude source is `~/.claude/.credentials.json`, or
`$CLAUDE_CONFIG_DIR/.credentials.json`; on Windows it is
`%USERPROFILE%\.claude.credentials.json`, or the equivalent configured path.
The bootstrap copies those credentials into the container-local home, so Claude
can refresh its copy without changing the host credential file. Missing or
unreadable credential sources are non-fatal.

`full` stages opaque complete Codex and Claude homes, `~/.agents`, and a
separate `.claude.json` when applicable. The bootstrap treats full directories
and `~/.agents` as required when they were staged: a copy failure stops creation
and identifies only the top-level source, never credential contents. On macOS,
Claude credentials in Keychain are not copied. A runtime `ANTHROPIC_API_KEY`,
when available and the tier is not `none`, remains the supported alternative.

A custom mount at, above, or below a canonical profile destination is externally
managed. Boxdown skips the matching staging input and copy rather than writing
over it.

## MCP server configuration

`auth` does not copy Codex `config.toml`, user-scoped Claude configuration, or
a Claude MCP projection. Move portable MCP configuration into the repository
using the relevant project-scoped mechanism, or select `full` when you need the
opaque user-scoped configuration. Project `.mcp.json` and other committed agent
configuration remain visible through the workspace mount in every tier.

Full-profile MCP definitions can still refer to host-only command paths,
environment variables, sockets, or native dependencies. Install the required
runtime and provide its environment inside the container before relying on them.

## External App Config

External app integration config is not Boxdown workspace state. Boxdown writes
it only when an SSH install target is selected from an interactive
`boxdown setup` or `boxdown ssh install` prompt, or requested explicitly with
`boxdown setup --target <name>` or `boxdown ssh install --target <name>`.
Non-interactive runs without `--target` install only the SSH alias and leave
external app config unchanged.

When requested, Boxdown writes Codex's app config at:

```text
~/.codex/codex-app/config.json
```

`BOXDOWN_CODEX_APP_CONFIG` overrides this path for tests and local development.
The Codex entry refers to the Boxdown-managed SSH alias and the canonical
container-side workspace path `/workspaces/<repo-name>`. Codex owns later
global-state records and sidebar entries it creates from that config, but
`boxdown ssh uninstall` removes the matching Codex sidebar cache entry when
unregistering the project.

When requested, Boxdown writes Claude's SSH remote config at:

```text
~/Library/Application Support/Claude/ssh_configs.json
```

`BOXDOWN_CLAUDE_SSH_CONFIGS` overrides this path for tests and local
development. The Claude entry refers to the Boxdown-managed SSH alias and adds
that alias to Claude's trusted host list.

## Generated Changes

Boxdown starts from `assets/devcontainer/devcontainer.json` and rewrites:

- `name`, to include the workspace basename.
- `initializeCommand`, to call the host asset script with the target workspace
  and host Git config snapshot paths.
- `postCreateCommand`, to call mounted container assets.
- `postStartCommand`, to call mounted container assets.
- `mounts`, to add the read-only asset mount, public-key mount, host Git config
  snapshot mount, runtime secret mount, and profile-specific read-only staging
  mounts below `/opt/boxdown/agent-profile-source`.
- `containerEnv`, to point SSH bootstrap at the mounted public key and actual
  container workspace, and record the non-secret selected profile as
  `BOXDOWN_AGENT_PROFILE`.

The target repository is still the Dev Container workspace via
`--workspace-folder`.

Mounts are create-time container settings. A profile selection or source change
does not update a stopped or running existing container; run
`boxdown start --recreate` to seed a fresh container-local copy.
