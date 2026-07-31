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

### Varlock credential proxy mode

When the workspace has a `.env.schema` and [varlock](https://varlock.dev) is
installed (the workspace's `node_modules/.bin/varlock` is preferred, then a
global install on `PATH`), initialization routes secrets through varlock's
credential proxy instead of writing plaintext secret files. It reuses the
workspace's running `varlock proxy` session or boots one (headless, with
schema reload disabled), then writes proxy wiring into the runtime-secret
directory: a sourceable `varlock.env` (placeholder values plus `HTTP(S)_PROXY`
and CA-bundle variables pointing at the host proxy through
`host.docker.internal`) and a `varlock-ca/` directory with the proxy CA
certificates. Real secret values then never enter the container; the proxy
substitutes them at the network boundary on the host and scrubs them from
responses. The per-secret plaintext files are removed in this mode.

Because varlock resolves values on the host, the schema can pull secrets from
any varlock plugin (1Password, Bitwarden, AWS Secrets Manager, HashiCorp
Vault, Doppler, and others) or varlock's built-in local encryption, without
those managers' tokens entering the container.

Set `BOXDOWN_VARLOCK=0` to skip proxy detection,
`BOXDOWN_VARLOCK_PROXY_SESSION=<id>` to select a specific session, and
`BOXDOWN_VARLOCK_BOOT_TIMEOUT_SECONDS` (default 30) to bound the boot wait.
The booted daemon logs to `varlock-proxy-start.log` in the workspace runtime
directory and keeps running after `boxdown down`; stop it with plain `kill`
using the PID from `varlock proxy status`. When varlock is absent or the
proxy cannot start, behavior falls back to plaintext secret files.

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

## Generated Changes

Boxdown starts from `assets/devcontainer/devcontainer.json` and rewrites:

- `name`, to include the workspace basename.
- `initializeCommand`, to call the host asset script with the target workspace
  and host Git config snapshot paths.
- `postCreateCommand`, to call mounted container assets.
- `postStartCommand`, to call mounted container assets.
- `mounts`, to add the read-only asset mount, public-key mount, host Git config
  snapshot mount, runtime secret mount, and `auth` read-only staging mounts or
  `full` live, read-write host mounts.
- `containerEnv`, to point SSH bootstrap at the mounted public key and actual
  container workspace, and record the non-secret selected profile as
  `BOXDOWN_AGENT_PROFILE`.

The target repository is still the Dev Container workspace via
`--workspace-folder`.

Mounts are create-time container settings. Run `boxdown start --recreate` after
changing a profile selection or full-profile mount configuration. Recreate also
seeds a fresh container-local `auth` copy; live `full` host profile content does
not need synchronization.
