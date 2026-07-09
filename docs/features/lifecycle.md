# Lifecycle Commands

## Commands

```sh
boxdown list
boxdown list --details
boxdown list --json
boxdown list --format json
boxdown status
boxdown status --json
boxdown status --format json
boxdown stop
boxdown down
boxdown purge
boxdown doctor
```

Workspace-targeting commands accept `--workspace <path>`. `down` also accepts
repeated `--workspace` flags to remove multiple workspace containers in order.
`purge --workspace` also accepts the `PATH`, `SSH ALIAS`, or unambiguous `REPO`
value shown by `boxdown list`. `purge` does not accept repeated `--workspace`
flags. `status` accepts `--alias <name>` so its output can match a custom SSH
host alias.

## List

`list` shows every workspace with Boxdown metadata under the data root,
regardless of the directory where the command is run. Human output includes
`STATE`, `REPO`, `PATH`, and `CONTAINER` columns.

`list --details` prints one workspace per block with full copyable `path`,
`ssh alias`, and `container` values.

`list --json` and `list --format json` print the same inventory as structured
JSON. Docker state is best-effort and includes recorded SSH aliases: if Docker
is unavailable, entries still print and their container state is `unknown`. If a
recorded repository path no longer exists, the entry is shown as `missing`.

## Status

`status` is read-only. It reports the resolved workspace, intended cache/data
paths, generated config path, command log path, SSH key paths, SSH alias, and
the matching Docker container state without recording the workspace in Boxdown
metadata.

Human output distinguishes intended values from detected state. For example, an
SSH alias can be shown as a computed default even when the matching Boxdown SSH
config block has not been installed. Existing paths are labeled `exists`,
missing paths are labeled `missing`, and managed SSH config blocks are labeled
`installed`, `missing`, or `outdated`. Healthy values are color-coded green and
missing or unhealthy values are color-coded red.

`status --json` prints the same information as structured JSON for scripts.
`status` exits 0 only when the generated config exists, devcontainer assets
exist, SSH key material exists, the runtime public key exists, and the
workspace container is running. Missing setup or a stopped/absent container is
reported in the output and exits nonzero. Installing an SSH alias is optional
and is not required for a healthy status exit.

## Stop, Down, and Purge

`stop` stops the workspace devcontainer when it is running. If the container is
already stopped or absent, it prints a short message and exits 0.

`down` removes the workspace devcontainer with Docker. It does not remove
Boxdown cache, generated config, data directories, or SSH keys.

Lifecycle commands append managed output to the workspace command log under the
workspace data directory. `--verbose` only controls terminal streaming; it does
not disable or enable log persistence. Foreground interactive shell, agent, and
tunnel session bytes are not tee'd into the log.

`purge` removes the workspace devcontainer with Docker, force-removes the exact
Docker image ID Boxdown can inspect or has recorded for the workspace, removes
Boxdown-managed SSH/Codex/Claude entries for the computed, recorded, and
provided aliases, and deletes the workspace's Boxdown cache/data directories,
including the per-workspace command log. It does not delete the target
repository directory or files inside it.

`purge --workspace <value>` first treats `<value>` as a filesystem path. If that
path does not exist, it looks for an exact `PATH`, then `SSH ALIAS`, then `REPO`
match in Boxdown metadata. `PATH` and `REPO` are shown by `boxdown list`; use
`boxdown status`, `boxdown list --details`, or JSON list output for SSH aliases.
`REPO` must match exactly one workspace; if multiple known workspaces share the
same repo basename, use `PATH` or `SSH ALIAS`.

```sh
boxdown purge
boxdown purge --workspace my-repo-devcontainer
boxdown purge --workspace my-repo
boxdown purge --workspace /path/to/my-repo
```

To remove multiple workspace containers, repeat `--workspace`:

```sh
boxdown down --workspace /path/to/repo-a --workspace /path/to/repo-b
```

When `down` runs without `--workspace` from a directory that is not a known
Boxdown workspace, interactive terminals show a multi-select list of known
workspaces with existing repository paths. Non-interactive runs keep the
current-directory behavior.

Batch `down` continues after individual workspace failures, but exits nonzero if
any requested workspace cannot be resolved or removed.

When `purge` runs without `--workspace` from a tracked Boxdown workspace, it
purges that workspace after confirmation. When it runs without `--workspace`
from an untracked directory, interactive terminals show a multi-select list of
all tracked workspaces from `boxdown list`, including `running`, `exited`,
`absent`, `missing`, and `unknown` states. After selection, `purge` asks for one
destructive confirmation for the selected batch, then purges each selected
workspace in order. Batch purge continues after individual workspace failures,
but exits nonzero if any selected workspace fails.

Interactive `purge` runs ask for confirmation before removing devcontainer,
image, SSH/Codex integration, cache, and data state. Non-interactive purge runs
do not prompt so existing targeted scripts keep working. Non-interactive
`purge` from an untracked directory fails safely instead of treating the current
directory as a workspace.

## Doctor

`doctor` validates required host prerequisites: Node, Docker CLI, Docker
daemon access, SSH tools, packaged devcontainer assets, and Boxdown's packaged
`@devcontainers/cli` dependency.

GitHub CLI auth is optional. Missing or unauthenticated `gh` is reported as a
warning rather than a failure.
