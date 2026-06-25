# Start Command

## Commands

```sh
boxdown start
boxdown codex
boxdown claude
boxdown cc
boxdown opencode
boxdown antigravity
```

`start` targets the current directory by default and accepts:

```sh
--workspace <path>
--recreate
```

`boxdown shell` remains supported as an alias for `boxdown start`, but `start`
is the canonical command used in help and documentation.

The coding-agent aliases start or reuse the same workspace devcontainer and
launch the selected CLI directly:

- `boxdown codex` launches `codex`.
- `boxdown claude` and `boxdown cc` launch `claude`.
- `boxdown opencode` launches `opencode`.
- `boxdown antigravity` launches `agy`.

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
6. Run container lifecycle hooks, including a best-effort coding-agent CLI refresh.
7. Print a dynamic port hint when the configured published port is mapped.
8. Run `devcontainer exec ... bash` to open an interactive shell.

Coding-agent aliases use the same startup flow but skip the port hint, run a
best-effort refresh for the selected agent, and exec the agent binary instead of
opening `bash`.

## Terminal Width

Some terminal UIs behave poorly when a host terminal reports an extremely wide
PTY, especially from embedded terminals. Before opening the shell, Boxdown
clamps interactive terminal width to 120 columns when the reported width is
larger.

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
Use it when changing create-time settings such as image, features, mounts, or
Docker `runArgs`.

## Port Hint

The v1 asset config publishes container port `3000` with a dynamic host port.
After `up`, Boxdown asks Docker for the mapped host binding and prints the
result as an HTTP URL when available.

For dev servers that choose another port after the container is already running,
use the SSH tunnel command instead:

```sh
boxdown tunnel --port 3030
boxdown tunnel --workspace /path/to/project --port 3030
```

This is the preferred path for host browsers and the Codex in-app browser when a
server is listening on container-local `localhost`.
