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
- SSH install target parsing and prompt behavior, including explicit target
  flags, prompt selection, prompt skip/cancel, and non-TTY fallback.
- SSH installation-result formatting: complete, warning, and incomplete
  outcomes; warning remediation before an app handoff; exit code `0` for
  warnings and `1` for failed writes; `--verbose`-only technical details; and
  narrow-terminal wrapping without truncating commands or URIs.
- Setup agent-profile selection, including single-choice raw and line input,
  cancellation before state writes, and non-interactive fallback.
- Codex app/global-state target installation, legacy path migration,
  and idempotent project injection.
- Cursor settings-path resolution on macOS, Linux/XDG, and Windows; JSONC
  platform mapping edits; SSH-config compatibility; URI command formatting;
  ownership records; shared-owner, multi-alias, lock, and cleanup behavior.
- Lifecycle status and doctor output formatting.
- Workspace metadata and list output formatting.
- Safety invariants, such as not packaging `.ssh/` key material.

Use temporary directories for workspace and state tests. Do not write to the
user's real SSH config, Codex app config, or Cursor settings in unit tests. Use
`BOXDOWN_CODEX_APP_CONFIG`, `BOXDOWN_CURSOR_SETTINGS`, or direct helper path
overrides for fixtures.

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
boxdown setup --workspace /path/to/repo
boxdown setup --workspace /path/to/repo --target codex
boxdown setup --workspace /path/to/repo --target claude
boxdown setup --workspace /path/to/repo --target cursor
boxdown setup --workspace /path/to/repo --target cursor --target codex
boxdown setup --workspace /path/to/repo --target codex --agent-profile auth
CI=1 boxdown setup --workspace /path/to/repo --target codex
boxdown start --workspace /path/to/repo
boxdown list
boxdown list --json
boxdown status --workspace /path/to/repo
boxdown status --workspace /path/to/repo --json
boxdown doctor --workspace /path/to/repo
boxdown ssh install --workspace /path/to/repo
boxdown ssh install --workspace /path/to/repo --target codex
boxdown ssh install --workspace /path/to/repo --target claude
boxdown ssh install --workspace /path/to/repo --target cursor
boxdown ssh uninstall --workspace /path/to/repo --target cursor
CI=1 boxdown ssh install --workspace /path/to/repo
ssh <repo-name>-devcontainer 'whoami && pwd'
boxdown down --workspace /path/to/repo-a --workspace /path/to/repo-b
boxdown purge --workspace /path/to/disposable-repo
```

The plain `ssh install` command should show the optional target selector when
run in an interactive terminal. The explicit `--target codex`, `--target
claude`, and `--target cursor` commands verify scriptable target installation,
and the `CI=1` command verifies the non-interactive skip path without blocking.
For a normal interactive success, confirm the completed checklist, final
outcome, and app-specific **Next step** appear inside one Boxdown rail. Check a
terminal narrower than 80 columns: prose may wrap, but the Cursor command and
URI must remain complete. Re-run the same command to confirm an idempotent
result without duplicate app configuration. Exercise a multi-target install in
which one target fails: the outcome must be incomplete with exit code `1`, show
the failed target's recovery, and retain next actions for other successful
targets. Also check a warning-only Cursor prerequisite result: it must exit
`0`, list the remediation before the open command, and never launch Cursor or
install its extension.

An installation outcome does not validate SSH connectivity. Run the explicit
`ssh <repo-name>-devcontainer 'whoami && pwd'` command separately when that
connection check is part of the acceptance test.

The first `setup --target codex` command should show the profile selector. The
`setup --target codex --agent-profile auth` command is fully explicit, and the
`CI=1 setup --target codex` command verifies the non-interactive fallback.
`setup --target cursor` should not show an agent-profile selector, while the
mixed Cursor/Codex command should still show it. After a Cursor install, use the
printed `cursor --folder-uri` command, then refresh Remote Explorer or restart
Cursor if needed. Confirm the warning-only `anysphere.remote-ssh` prerequisite
check never launches Cursor or installs an extension.

The plain `tunnel` command should prompt for ports in an interactive terminal.
Use `boxdown tunnel --workspace /path/to/repo --port 3030` when testing the
non-interactive or fully explicit path.

When checking browser access, start a dev server inside the container and keep a
foreground tunnel open from the host:

```sh
boxdown tunnel --workspace /path/to/repo
boxdown tunnel --workspace /path/to/repo --port 3030
```

Confirm `http://localhost:3030/` works, then stop the tunnel with Ctrl-C.

Run this from at least two repositories when changing workspace isolation,
container lookup, SSH config generation, or generated config behavior.
