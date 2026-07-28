# Interactive Container Reuse Design

## Problem

Boxdown's direct interactive commands always invoke `devcontainer up`, even
when the workspace container is already running. This affects `boxdown start`
and the coding-agent commands, including `boxdown cc` (the alias for Claude
Code). It creates avoidable startup latency after an initial `boxdown setup`
or a previous direct interactive launch.

This is not a legacy-image migration issue. All of these commands generate the
same Boxdown devcontainer configuration and therefore select the same
published image after a requested recreation.

The SSH proxy and tunnel commands already reuse a running workspace container.
The direct interactive commands should give users the same fast re-entry
experience without weakening explicit provisioning or recreation semantics.

## Goals

- Reuse an already-running workspace devcontainer for `start` and every
  coding-agent command.
- Preserve the requested `--recreate` behaviour: it must always recreate the
  container instead of reusing it.
- Keep the requested agent's availability check before launching that agent.
- Retain the existing SSH proxy and tunnel reuse behaviour.
- Make the lifecycle policy explicit in user documentation.

## Non-goals

- Skip host-side SSH key, Git-signing, MCP configuration, or generated
  devcontainer-config preparation before a reuse decision.
- Change `setup` into a no-op when a container is already running.
- Change Docker-image selection, image migration, or the lifecycle hooks.
- Add a new CLI flag or a background container manager.

## Lifecycle policy

| Command family | Running-container policy |
| --- | --- |
| `boxdown setup` | Always use the provisioning lifecycle. It is the explicit command for applying setup and optional SSH/app integration changes. |
| `boxdown start` | Reuse a running workspace container. |
| `boxdown codex`, `claude`, `cc`, `opencode`, `antigravity` | Reuse a running workspace container, then ensure the requested agent CLI is available before executing it. |
| `boxdown ssh-proxy`, `tunnel` | Keep the existing reuse behaviour. |
| Any supported command with `--recreate` | Bypass reuse and invoke the existing remove-and-recreate path. |

## Technical design

The existing `startDevcontainer()` function already owns reuse semantics. When
called with `reuseRunning: true` and without `recreate: true`, it checks for a
container carrying the workspace label and returns its ID instead of invoking
the Dev Containers CLI.

`runCli()` will pass `reuseRunning: true` for the `start` branch and for the
shared `coding-agent` branch. Because the shared branch handles all public
agent names, this covers `cc` without a special case. `setup` will continue to
call `startDevcontainer()` without that option.

The reuse check remains in its current position, after Boxdown prepares the
workspace key, resolves signing, projects MCP configuration, and writes the
generated configuration. This preserves safe host-state validation and avoids
silently ignoring changed configuration. The optimization is deliberately
limited to avoiding the expensive `devcontainer up` call.

## Testing

Add focused lifecycle coverage for a workspace whose Docker container is
already running:

- `start` does not call the Dev Containers CLI's `up` command.
- `cc` and another non-Claude coding-agent command use the same behavior,
  proving that the shared coding-agent branch is covered rather than just the
  alias parser.
- Coding-agent reuse still runs the requested agent-availability preflight
  before the final exec command.
- `--recreate` continues to call `devcontainer up` with
  `--remove-existing-container`, even when the container is running.
- `setup` continues to use its full provisioning lifecycle.

Update the start/lifecycle documentation to distinguish reusable interactive
entry from explicit `setup` provisioning. The wording must not imply that
reuse skips the host-side configuration preparation.

## Compatibility and failure handling

- A stopped container continues through `devcontainer up` and the normal
  Dev Container lifecycle hooks.
- Reuse does not hide agent setup failures: a selected agent must still be
  installed or refreshed as needed before execution.
- Existing command logs, progress steps, and the `--verbose` detailed trace
  remain the source of diagnostics for container startup and agent preparation.

## Verification

Run the focused lifecycle tests first, then `pnpm test`, `pnpm run lint`,
`pnpm run build`, and `git diff --check` before declaring the implementation
complete.
