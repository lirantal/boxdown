# Setup Command

## Command

```sh
boxdown setup
boxdown setup --target codex
boxdown setup --target claude
boxdown setup --recreate
```

`setup` prepares the current workspace for remote tools without opening an
interactive shell. It accepts:

```sh
--workspace <path>
--alias <name>
--recreate
--target <name>
--verbose
```

## Flow

1. Resolve the workspace to a real absolute path.
2. Ensure per-workspace SSH key material exists.
3. Generate a Boxdown-owned devcontainer config.
4. Run `devcontainer up --workspace-folder <repo> --override-config <config>`.
5. Install or update the Boxdown-managed SSH alias.
6. Optionally install selected SSH targets such as Codex or Claude.

`setup` prints plain progress sections by default. Docker, Dev Containers CLI,
and lifecycle hook output is captured and only summarized if a command fails.
Pass `--verbose` to stream the raw build and hook logs to the terminal.

Boxdown also appends the managed setup output to the workspace command log at:

```text
~/.local/share/boxdown/workspaces/<workspace-hash>/boxdown.log
```

The log is written regardless of `--verbose`; the flag only changes terminal
streaming.

When `--target codex` is provided, Boxdown writes the Codex app config entry for
the same alias and container-side project path used by:

```sh
boxdown ssh install --target codex
```

When `--target claude` is provided, Boxdown writes the Claude app SSH remote
entry for the same alias used by:

```sh
boxdown ssh install --target claude
```

When no target is provided, Boxdown uses the same optional target prompt as
`boxdown ssh install`. In non-interactive shells, setup skips target
registration unless `--target` is provided.

`setup` does not open a shell, launch a coding-agent CLI, or keep a tunnel in the
foreground. Use `boxdown start`, `boxdown codex`, or `boxdown tunnel` for those
foreground workflows. Those commands log Boxdown-managed startup steps, but do
not tee full interactive shell, agent, or tunnel session bytes into the log.
