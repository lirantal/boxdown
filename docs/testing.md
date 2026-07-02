# Testing

## Standard Checks

Run these before opening a PR:

```sh
pnpm run lint
pnpm run build
pnpm run test
```

`pnpm run lint` includes ESLint and markdown lint. Documentation under `docs/`
is intentionally linted.

## Unit Test Strategy

Unit tests should avoid starting Docker. Prefer pure tests for:

- CLI parsing and command aliases.
- Workspace path resolution and state directory selection.
- Generated devcontainer config shape.
- SSH config block creation and idempotent replacement.
- Codex app config target parsing, merge behavior, and idempotent project
  injection.
- Lifecycle status and doctor output formatting.
- Workspace metadata and list output formatting.
- Safety invariants, such as not packaging `.ssh/` key material.

Use temporary directories for workspace and state tests. Do not write to the
user's real SSH config or Codex app config in unit tests. Use
`BOXDOWN_CODEX_APP_CONFIG` or direct helper path overrides for Codex config
fixtures.

## Build and CLI Smoke Tests

After `pnpm run build`, smoke test the built binary:

```sh
node dist/bin/cli.cjs --help
```

Use a dry-run pack check when changing package assets or `package.json.files`:

```sh
npm pack --dry-run --json
```

Confirm `assets/devcontainer/**` is included and `.ssh/` is not.

## Manual Acceptance

Manual Docker acceptance is heavier and should be done intentionally:

```sh
boxdown start --workspace /path/to/repo
boxdown list
boxdown list --json
boxdown status --workspace /path/to/repo
boxdown status --workspace /path/to/repo --json
boxdown doctor --workspace /path/to/repo
boxdown ssh install --workspace /path/to/repo
boxdown ssh install --workspace /path/to/repo --target codex
ssh <repo-name>-devcontainer 'whoami && pwd'
boxdown down --workspace /path/to/repo-a --workspace /path/to/repo-b
boxdown purge --workspace /path/to/disposable-repo
```

When checking browser access, start a dev server inside the container and keep a
foreground tunnel open from the host:

```sh
boxdown tunnel --workspace /path/to/repo --port 3030
```

Confirm `http://localhost:3030/` works, then stop the tunnel with Ctrl-C.

Run this from at least two repositories when changing workspace isolation,
container lookup, SSH config generation, or generated config behavior.
