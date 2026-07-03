# Setup Command

## Command

```sh
boxdown setup
boxdown setup --target codex
boxdown setup --recreate
```

`setup` prepares the current workspace for remote tools without opening an
interactive shell. It accepts:

```sh
--workspace <path>
--alias <name>
--recreate
--target codex
```

## Flow

1. Resolve the workspace to a real absolute path.
2. Ensure per-workspace SSH key material exists.
3. Generate a Boxdown-owned devcontainer config.
4. Run `devcontainer up --workspace-folder <repo> --override-config <config>`.
5. Install or update the Boxdown-managed SSH alias.
6. Optionally register the alias as a Codex app remote project.

When `--target codex` is provided, Boxdown writes the Codex app config entry for
the same alias and container-side project path used by:

```sh
boxdown ssh install --target codex
```

When no target is provided and the command is running in an interactive TTY,
Boxdown prompts for a target. Press Enter to keep the default `none` choice.
In non-interactive shells, setup skips target registration unless `--target` is
provided.

`setup` does not open a shell, launch a coding-agent CLI, or keep a tunnel in the
foreground. Use `boxdown start`, `boxdown codex`, or `boxdown tunnel` for those
foreground workflows.
