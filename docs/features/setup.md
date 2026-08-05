# Setup Command

## Command

```sh
boxdown setup
boxdown setup --target codex
boxdown setup --target claude
boxdown setup --target cursor
boxdown setup --target cursor --target codex
boxdown setup --recreate
boxdown setup --agent-profile full
boxdown setup --target codex --agent-profile auth
```

`setup` prepares the current workspace for remote tools without opening an
interactive shell. It accepts:

```sh
--workspace <path>
--alias <name>
--recreate
--agent-profile <tier>
--target <name>
--verbose
```

`--agent-profile` accepts `none`, `auth`, or `full`. Setup retains recorded
agent-profile metadata; only a workspace without a recorded profile defaults to
`auth`. The selected profile is recorded for later container-starting commands.
Changing it requires `--recreate` when a container already exists, because
Docker mount configuration and the container-local `auth` profile copy are
created together. `full` uses live, read-write host mounts, so recreate after
changing its mount configuration.

The profile-selector eligibility matrix is: during interactive setup, selecting
or explicitly supplying at least one Codex or Claude app target opens the
single-choice agent-profile selector when `--agent-profile` was not supplied.
Cursor alone does not open the agent-profile selector because Cursor uses the
managed SSH alias rather than a container agent profile. A mixed Cursor and
Codex or Claude selection still opens the selector. An explicit
`--agent-profile` skips the selector. Skipping every app target retains the
recorded profile, or uses `auth` for a new workspace, without another selector.
Non-interactive setup never asks and uses that same fallback.

Canceling either the target or agent-profile selector stops setup before
workspace state is written.

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

Setup is explicit provisioning and follows the full setup lifecycle even when
the workspace container is already running.

## Flow

1. Resolve the workspace to a real absolute path and run setup readiness.
2. Resolve app targets, using the optional target selector when appropriate.
3. Resolve the agent profile after target resolution, using its selector only
   when eligible.
4. Persist the resolved profile, then generate a Boxdown-owned devcontainer
   config with read-only staging mounts for `auth` or live host mounts for
   `full`.
5. Run `devcontainer up --workspace-folder <repo> --override-config <config>`.
6. Install or update the Boxdown-managed SSH alias and selected app targets.

When setup finishes its SSH and app configuration, the final result is
action-first: **Setup complete**, **Setup complete with warnings**, or **Setup
incomplete**. Complete means every requested configuration write succeeded;
warnings mean those writes succeeded but an optional prerequisite or follow-up
needs attention; incomplete means one or more requested writes failed. This
does not test an SSH connection or launch an app. Follow the app-specific
instruction under **Next step** instead.

Default successful interactive output shows the outcome and app-specific next
actions, not routine configuration paths. Run `boxdown setup --verbose` to add
identity, backup, ownership, URI, and diagnostic details; `boxdown status` also
reports workspace state. Commands and URIs are kept intact on narrow terminals
while prose wraps.

`setup` prints concise progress by default. In an interactive terminal,
`--verbose` shows a detailed lifecycle trace without streaming raw child
output. In CI or non-interactive output, Boxdown streams raw Docker, Dev
Containers CLI, and lifecycle-hook output.

Boxdown also appends the managed setup output to the workspace command log at:

```text
~/.local/share/boxdown/workspaces/<workspace-hash>/boxdown.log
```

The log is written in every mode. Interactive `--verbose` prints its concrete
path when setup completes.

When `--target codex` is provided, Boxdown writes the ChatGPT app config entry
for the same alias and container-side project path used by:

```sh
boxdown ssh install --target codex
```

When `--target claude` is provided, Boxdown writes the Claude app SSH remote
entry for the same alias used by:

```sh
boxdown ssh install --target claude
```

When `--target cursor` is provided, Boxdown configures Cursor's public Remote
SSH settings for the same alias and prints the URI plus the command to open
`/workspaces/<repo-name>`. It does not launch Cursor; run the printed command
yourself. See [SSH config and proxy workflow](./ssh-config-and-proxy.md#cursor-target)
for prerequisites, commands, and cleanup behavior.

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

`auth` sources are copied into container-local writable homes during container
creation and are not synchronized from the host after creation. `full` mounts
live, read-write host profiles instead, so profile changes inside the container
persist to the host immediately. Recreate after changing the selected profile
or full-profile mount configuration.
