# Lifecycle Commands

## Commands

```sh
boxdown list
boxdown list --json
boxdown status
boxdown status --json
boxdown stop
boxdown down
boxdown purge
boxdown doctor
```

Workspace-targeting commands accept `--workspace <path>`. `down` also accepts
repeated `--workspace` flags to remove multiple workspace containers in order.
`status` accepts `--alias <name>` so its output can match a custom SSH host
alias.

## List

`list` shows every workspace with Boxdown metadata under the data root,
regardless of the directory where the command is run. Human output includes
`STATE`, `REPO`, `PATH`, `SSH ALIAS`, and `CONTAINER` columns.

`list --json` prints the same inventory as structured JSON. Docker state is
best-effort: if Docker is unavailable, entries still print and their container
state is `unknown`. If a recorded repository path no longer exists, the entry is
shown as `missing`.

## Status

`status` is read-only. It reports the resolved workspace, intended cache/data
paths, generated config path, SSH key paths, SSH alias, and the matching Docker
container state without recording the workspace in Boxdown metadata.

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

`purge` removes the workspace devcontainer with Docker, force-removes the exact
Docker image ID Boxdown can inspect or has recorded for the workspace, removes
Boxdown-managed SSH/Codex/Claude entries for the computed, recorded, and
provided aliases, and deletes the workspace's Boxdown cache/data directories. It
does not delete the target repository directory or files inside it.

To remove multiple workspace containers, repeat `--workspace`:

```sh
boxdown down --workspace /path/to/repo-a --workspace /path/to/repo-b
```

Batch `down` continues after individual workspace failures, but exits nonzero if
any requested workspace cannot be resolved or removed.

## Doctor

`doctor` validates required host prerequisites: Node, Docker CLI, Docker
daemon access, SSH tools, packaged devcontainer assets, and Boxdown's packaged
`@devcontainers/cli` dependency.

GitHub CLI auth is optional. Missing or unauthenticated `gh` is reported as a
warning rather than a failure.
