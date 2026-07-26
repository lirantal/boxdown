# Start Command

## Commands

```sh
boxdown start
boxdown codex
boxdown claude
boxdown opencode
boxdown antigravity
```

`start` targets the current directory by default and accepts:

```sh
--workspace <path>
--recreate
--verbose
```

Use `boxdown setup` when you want to prepare the devcontainer and SSH/app
integration without opening an interactive shell.

Start does not require a completed setup. It performs a fresh runtime-readiness
check, then writes workspace inventory metadata and creates the generated state
needed for the devcontainer. It does not install the setup-only SSH alias or
external application integrations.

`boxdown shell` remains supported as an alias for `boxdown start`, but `start`
is the canonical command used in help and documentation.
`boxdown cc` remains supported as an alias for `boxdown claude`, but `claude`
is the canonical command used in help and documentation.

The coding-agent aliases start or reuse the same workspace devcontainer and
launch the selected CLI directly:

- `boxdown codex` launches `codex`.
- `boxdown claude` launches `claude`.
- `boxdown opencode` installs/updates OpenCode when needed, then launches
  `opencode`.
- `boxdown antigravity` installs/updates Antigravity when needed, then launches
  `agy`.

Container bring-up pulls the public release-matched image
`ghcr.io/lirantal/boxdown:<Boxdown-version>`, which includes Codex, Claude
Code, Snyk, 1Password, and AMD64 APM. It does not build Dev Container Features
or shared tools locally. An uncached pull needs network access but no GHCR
login. OpenCode and Antigravity remain lazy installs so projects that do not
use them avoid the extra disk usage.

The image contains neither workspaces nor credentials. Boxdown adds those as
per-workspace mounts and runtime state when creating the container. Codex and
Claude retain their throttled best-effort refreshes after startup. Snyk,
1Password, and AMD64 APM advance only with a Boxdown release and recreation;
APM stays deferred on ARM64 until you explicitly opt in to a Python-based
installation.

Pass agent-specific arguments after `--` so Boxdown options stay unambiguous:

```sh
boxdown claude -- --continue
```

## Flow

1. Resolve the workspace to a real absolute path.
2. Ensure per-workspace SSH key material exists.
3. Generate a Boxdown-owned devcontainer config.
4. Install or reuse the pinned Dev Containers CLI.
5. Run `devcontainer up --workspace-folder <repo> --override-config <config>`.
6. Run container lifecycle hooks, including a throttled Codex/Claude refresh.
7. Print a dynamic port hint when the configured published port is mapped.
8. Run `devcontainer exec ... bash` to open an interactive shell.

Coding-agent aliases use the same startup flow but skip the port hint, run a
best-effort refresh for the selected agent, and exec the agent binary instead of
opening `bash`.

Startup progress is concise by default. Raw Docker, Dev Containers CLI,
lifecycle hook, and coding-agent install/update logs are captured; on failure,
Boxdown prints the failed step and a short output tail. Pass `--verbose` to
stream the full startup output before the interactive shell or agent takes over.

## Terminal Width

Some terminal UIs behave poorly when a host terminal reports an extremely wide
PTY, especially from embedded terminals. Before opening the shell, Boxdown
clamps interactive terminal width to 120 columns when the reported width is
larger.

Before starting the interactive shell or a coding-agent command, Boxdown also
checks whether the container recognizes the forwarded `TERM` value. If the
container does not have terminfo for a host-specific terminal such as Ghostty,
Boxdown falls back to `xterm-256color` while preserving truecolor support with
`COLORTERM=truecolor`.

Override the default width when you want a wider layout:

```sh
BOXDOWN_TTY_MAX_COLUMNS=180 boxdown start
```

Disable the normalization entirely when you want the container shell to use the
host terminal size unchanged:

```sh
BOXDOWN_TTY_NORMALIZE=0 boxdown start
```

## Recreate

`--recreate` passes `--remove-existing-container` to the Dev Containers CLI.
Use it when changing create-time settings such as image, mounts, or Docker
`runArgs`.

Run Claude Code and complete `/login` on the host, then run `boxdown start
--recreate` to recover the credential in an existing container.

Workspaces created before the release-matched image remain on their existing
container. Switch them only with `boxdown start --recreate` or
`boxdown setup --recreate`; the migration is one-time and does not modify the
workspace.

Existing containers created before Boxdown adopted runtime-mounted secrets
must be recreated once. After recreation, Boxdown-provided secrets remain
ordinary Bash-session environment variables but are absent from Docker
container configuration and `docker inspect`.

## Port Hint

The v1 asset config publishes container port `3000` with a dynamic host port.
After `up`, Boxdown asks Docker for the mapped host binding and prints the
result as an HTTP URL when available.

For dev servers that choose another port after the container is already running,
use the SSH tunnel command instead. Interactive terminals can omit `--port` to
be prompted for the mapping:

```sh
boxdown tunnel
boxdown tunnel --port 3030
boxdown tunnel --workspace /path/to/project --port 3030
```

This is the preferred path for host browsers and the Codex in-app browser when a
server is listening on container-local `localhost`.
