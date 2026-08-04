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

## Cursor SSH Integration State

When the Cursor SSH target is selected, Boxdown updates Cursor's public user
settings file and writes a non-secret ownership record at:

```text
~/.local/share/boxdown/workspaces/<workspace-hash>/cursor-integration.json
```

The versioned record tracks each managed `(alias, settingsPath)` mapping and
whether Boxdown owns its `remote.SSH.remotePlatform.<alias>` Linux value. It is
outside the repository so one workspace can retain multiple alias or
settings-path entries without changing project files. During cleanup, peer
records under the same data root prevent one workspace from removing a mapping
still owned by another workspace.

Cursor settings defaults are macOS
`~/Library/Application Support/Cursor/User/settings.json`, Linux
`${XDG_CONFIG_HOME:-~/.config}/Cursor/User/settings.json`, and Windows
`%APPDATA%\Cursor\User\settings.json`. `BOXDOWN_CURSOR_SETTINGS` overrides the
complete path for tests or local development; it must not be empty.

Cursor integration mutations use the data-root lock
`<dataRoot>/cursor-integration.lock`, and ownership discovery is limited to the
same resolved data root. Retain the same `BOXDOWN_DATA_HOME` or `XDG_DATA_HOME`
choice across install, targeted uninstall, unqualified uninstall, and purge.
Changing it deliberately creates a separate state universe, so cleanup cannot
prove ownership of records under the earlier root. Targeted Cursor uninstall
processes the selected alias; unqualified uninstall and purge process every
recorded mapping before deleting the workspace data directory.

If complete integration cleanup fails, purge retains the workspace data and its
ownership record for a safe retry while continuing Docker, runtime, and cache
cleanup. An unrelated Docker failure does not retain workspace data.

## Workspace Toolchain State

When a workspace has a confirmed toolchain selection, Boxdown keeps its plan
and result below persistent workspace data:

```text
~/.local/share/boxdown/workspaces/<workspace-hash>/toolchains/plan.json
~/.local/share/boxdown/workspaces/<workspace-hash>/toolchains/result/result.json
```

The plan is Boxdown-owned input: it records the schema version, selection,
resolved versions, evidence, resolution sources, and a fingerprint. The result
is Boxdown-owned output: it records the plan fingerprint, aggregate and
per-runtime synchronization states, and timestamps. Neither file is created in
the target repository.

For a workspace with a plan, generated configuration makes the plan file
available read-only at `/opt/boxdown/state/toolchains/plan/plan.json` and
makes the separate result file available read-write at
`/opt/boxdown/state/toolchain-results/result.json`. The split lets the
container observe the user-confirmed plan while writing only bounded lifecycle
results. Legacy workspaces with no plan receive neither mount.

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

Only `auth` agent-profile sources are mounted at a read-only staging path below
`/opt/boxdown/agent-profile-source`. During container creation, the profile
bootstrap makes container-local writable copies in the canonical homes:
`/home/node/.agents`, `/home/node/.codex`, `/home/node/.claude`, and, when
applicable, `/home/node/.claude.json`. `full` is not staged: it uses live,
read-write host mounts at the canonical destinations, so container changes
persist to the host immediately.

`auth` stages the complete `~/.agents` tree, available file-backed Codex auth,
and available supported file-backed Claude credentials. On Linux and WSL, the
Claude source is `~/.claude/.credentials.json`, or
`$CLAUDE_CONFIG_DIR/.credentials.json`; on Windows it is
`%USERPROFILE%\.claude\.credentials.json`, or the equivalent configured path.
The bootstrap copies those credentials into the container-local home, so Claude
can refresh its copy without changing the host credential file. Missing or
unreadable credential sources are non-fatal.

`full` mounts opaque complete Codex and Claude homes, `~/.agents`, and a
separate `.claude.json` when applicable, directly from the host. These mounts
are intentionally read-write: changes inside the container persist to the host
immediately. On macOS, Claude credentials in Keychain are not mounted. A runtime
`ANTHROPIC_API_KEY`, when available and the tier is not `none`, remains the
supported alternative. Never use `full` for an untrusted workspace.

A custom mount at, above, or below a canonical profile destination is externally
managed. Boxdown skips the matching `auth` staging input and copy, or its `full`
live mount, rather than writing over it.

A malformed CSV string mount, or any unresolved `${...}` expression anywhere
in a string mount, makes all canonical profile destinations externally managed.
For a structured mount, every present serialized `type`, `src`/`source`, and
`dst`/`target`/`destination` field is checked. A non-string value, unresolved
`${...}`, comma, double quote, carriage return, line feed, or NUL makes all
canonical profile destinations externally managed. This includes substitutions
confined to the type or source fields. Opaque unknown fields are not interpreted
as mount grammar. The original mount is preserved unchanged. Status reports
only canonical destination names and never reports substitution values.

Static symlinks observed during traversal are reproduced as links, and a
final-component regular file changed to a symlink after classification fails
closed. Recursive directory traversal is path-based: concurrent host
replacement of a traversed parent directory during container creation is
outside the isolation guarantee and may fail or copy best-effort from the
replacement. Do not mutate selected source trees while a container is being
created.

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

When requested, Boxdown configures Cursor only through the settings path above.
It does not launch Cursor, install an extension, edit SQLite or
`workspaceStorage`, write remote history, or synthesize a Dev Containers
authority. The Cursor-specific settings and ownership behavior is documented in
[SSH config and proxy workflow](./ssh-config-and-proxy.md#cursor-target).

## Generated Changes

Boxdown starts from `assets/devcontainer/devcontainer.json` and rewrites:

- `name`, to include the workspace basename.
- `initializeCommand`, to call the host asset script with the target workspace
  and host Git config snapshot paths.
- `postCreateCommand`, to call mounted container assets.
- `postStartCommand`, to call mounted container assets.
- `mounts`, to add the read-only asset mount, public-key mount, host Git config
  snapshot mount, runtime secret mount, and `auth` read-only staging mounts or
  `full` live, read-write host mounts. A confirmed toolchain plan additionally
  adds its read-only plan mount and separate read-write result mount.
- `containerEnv`, to point SSH bootstrap at the mounted public key and actual
  container workspace, and record the non-secret selected profile as
  `BOXDOWN_AGENT_PROFILE`.

The target repository is still the Dev Container workspace via
`--workspace-folder`.

Mounts are create-time container settings. Run `boxdown start --recreate` after
changing a profile selection or full-profile mount configuration. Recreate also
seeds a fresh container-local `auth` copy; live `full` host profile content does
not need synchronization. A legacy workspace needs the same recreation the
first time it gains a toolchain plan, because those two mounts must be created.
