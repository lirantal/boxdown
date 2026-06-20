# Lifecycle Commands

## Commands

```sh
boxdown list
boxdown list --json
boxdown status
boxdown status --json
boxdown stop
boxdown down
boxdown doctor
```

Workspace-targeting commands accept `--workspace <path>`. `status` also accepts
`--alias <name>` so its output can match a custom SSH host alias.

## List

`list` shows every workspace with Boxdown metadata under the data root,
regardless of the directory where the command is run. Human output includes
`STATE`, `REPO`, `PATH`, `SSH ALIAS`, and `CONTAINER` columns.

`list --json` prints the same inventory as structured JSON. Docker state is
best-effort: if Docker is unavailable, entries still print and their container
state is `unknown`. If a recorded repository path no longer exists, the entry is
shown as `missing`.

## Status

`status` reports the resolved workspace, generated config path, cache/data
paths, SSH key paths, SSH alias, and the matching Docker container state. Human
output color-codes healthy values in green and missing or unhealthy values in
red.

`status --json` prints the same information as structured JSON for scripts.
`status` exits 0 only when the generated config exists, devcontainer assets
exist, SSH key material exists, the runtime public key exists, and the
workspace container is running. Missing setup or a stopped/absent container is
reported in the output and exits nonzero.

## Stop and Down

`stop` stops the workspace devcontainer when it is running. If the container is
already stopped or absent, it prints a short message and exits 0.

`down` removes the workspace devcontainer with Docker. It does not remove
Boxdown cache, generated config, data directories, or SSH keys.

## Doctor

`doctor` validates required host prerequisites: Node, Docker CLI, Docker
daemon access, SSH tools, packaged devcontainer assets, and Boxdown's packaged
`@devcontainers/cli` dependency.

GitHub CLI auth is optional. Missing or unauthenticated `gh` is reported as a
warning rather than a failure.
