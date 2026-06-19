# Lifecycle Commands

## Commands

```sh
boxdown status
boxdown status --json
boxdown stop
boxdown down
boxdown doctor
```

All commands accept `--workspace <path>`. `status` also accepts `--alias <name>`
so its output can match a custom SSH host alias.

## Status

`status` reports the resolved workspace, generated config path, cache/data
paths, SSH key paths, SSH alias, and the matching Docker container state.

`status --json` prints the same information as structured JSON for scripts.
Missing or stopped containers are reported as normal status and still exit 0.

## Stop and Down

`stop` stops the workspace devcontainer when it is running. If the container is
already stopped or absent, it prints a short message and exits 0.

`down` removes the workspace devcontainer with Docker. It does not remove
Boxdown cache, generated config, data directories, or SSH keys.

## Doctor

`doctor` validates required host prerequisites: Node, npm, Docker CLI, Docker
daemon access, SSH tools, and packaged devcontainer assets.

GitHub CLI auth is optional. Missing or unauthenticated `gh` is reported as a
warning rather than a failure.
