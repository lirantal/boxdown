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

Setup readiness runs before prompts or workspace state is written. A missing
Docker CLI fails immediately; a starting Docker daemon or discoverable Buildx
builder is polled once per second for up to 60 seconds. If this preflight fails,
setup leaves no workspace metadata, generated devcontainer config, or SSH key.

New setups pull the public release-matched image
`ghcr.io/lirantal/boxdown:<Boxdown-version>`, rather than building Dev
Container Features or shared tools locally. The first uncached pull needs
network access but no GHCR login. The image includes Codex, Claude Code, Snyk,
1Password, and AMD64 APM; OpenCode and Antigravity remain lazy installs. It
contains no workspaces or credentials, which Boxdown provides only through
per-workspace mounts and runtime state.

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

Codex and Claude retain throttled best-effort refreshes after startup. Snyk,
1Password, and AMD64 APM advance through a Boxdown release plus recreation;
APM is deferred on ARM64 until you explicitly opt in to a Python-based
installation. Existing workspaces switch to the published image only with
`boxdown setup --recreate` or `boxdown start --recreate`.
