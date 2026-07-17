# Runtime Secret Environment Design

## Goal

Keep Boxdown-provided secrets available as ordinary environment variables in
container user sessions without placing their values in Docker container
configuration, the workspace, or Boxdown's persistent state and logs.

This design covers `ANTHROPIC_API_KEY`, `SNYK_TOKEN`, and
`OP_SERVICE_ACCOUNT_TOKEN`. It also prevents the Docker inspection command
used for image metadata from logging the complete container configuration.

## Non-goals

- Migrating, deleting, or rewriting legacy `.env.development` files.
- Adding a `boxdown doctor --fix-secrets` command.
- Preventing a user who can enter the container from reading secrets that are
  deliberately available to that user's session.
- Changing GitHub CLI authentication refresh, which already passes its host
  token over stdin and redacts it from the workspace log.

## Security Model

The user has requested compatibility with the current developer experience:
the three values above remain ordinary environment variables in Bash-based
container sessions. This intentionally permits session processes to read them.

The protection boundary is against accidental exposure outside that session:

- Docker inspection must not contain secret values.
- The repository and its `.env.development` file must not be created,
  modified, or removed by Boxdown secret handling.
- Boxdown's persistent workspace data and `boxdown.log` must not contain
  secret values.
- Secret files are short-lived, host-private runtime state and are mounted
  read-only into the container.

## Architecture

### Host runtime secret state

`WorkspaceContext` gains a per-workspace runtime-secret directory under a
user-private runtime root. The root uses `XDG_RUNTIME_DIR` when available and
a user-private directory under the system temporary directory otherwise. It
is distinct from `workspaceDataDir`, which is persistent and contains logs and
metadata.

The directory and each secret file are created with owner-only permissions
(`0700` directory, `0600` files). The three files use fixed names matching
their environment variables. No secret value appears in generated
configuration, command arguments, progress output, metadata, or diagnostics.

The host-side `initializeCommand` refreshes this directory before each
Dev Container startup:

1. It creates the runtime directory safely.
2. It writes `ANTHROPIC_API_KEY` and `SNYK_TOKEN` only when each corresponding
   host environment value is non-empty.
3. It retrieves `OP_SERVICE_ACCOUNT_TOKEN` from the existing 1Password item
   only when `op` is available and can read it.
4. It atomically replaces files for available values and removes files for
   unavailable values, preventing a stale token from a previous start.

Failures to retrieve 1Password or an absent host variable are informational
and non-blocking. The affected variable is absent from the next container
session.

### Generated Dev Container configuration

The base `runArgs` no longer includes:

```text
--env-file ${localWorkspaceFolder}/.env.development
```

The base `containerEnv` no longer includes secret values via `localEnv`.
`NODE_ENV` remains ordinary non-secret configuration.

Boxdown's generated configuration adds a read-only bind mount from the host
runtime-secret directory to `/run/boxdown/secrets`. It may contain non-secret
bootstrap configuration such as `BASH_ENV` and the mounted directory path,
but never a secret value.

Because mounts are create-time settings, `boxdown start --recreate` is needed
for an already-created container to receive the new mount. New containers get
it automatically through every Boxdown lifecycle path (`setup`, `start`,
`codex`, and the other coding-agent commands).

### Container session bootstrap

A mounted Boxdown bootstrap script reads only the fixed secret files, then
exports values that are present. It never echoes values or shell source lines.
It handles missing or unreadable files by leaving the corresponding variable
unset.

The generated configuration sets the non-secret `BASH_ENV` path so
non-interactive Bash processes source the bootstrap. The container setup also
installs the bootstrap in the `node` user's Bash startup path for interactive
shells and SSH sessions. Boxdown's direct shell and coding-agent launch
scripts source it explicitly before `exec` as an additional deterministic
path.

Consequently, an ordinary Bash session can use, for example,
`$ANTHROPIC_API_KEY`, `$SNYK_TOKEN`, and `$OP_SERVICE_ACCOUNT_TOKEN` as it can
today. Docker's configured environment contains only the bootstrap path and
other non-secret values, so `docker inspect` cannot reveal secret contents.

### Workspace file handling

The initialization hook stops creating or editing `.env.development`. The
post-start hook stops deleting it. Boxdown therefore treats that file as
project-owned in all cases.

This release deliberately does not modify legacy files. A pre-existing
`OP_SERVICE_ACCOUNT_TOKEN` value remains the user's responsibility to remove
or rotate. Documentation will state that Boxdown no longer reads the file and
that users should remove a legacy accidental entry manually.

### Logging and Docker inspection

Boxdown currently runs `docker inspect --format '{{json .}}'` only to record
the image ID and image name. The full payload includes `.Config.Env`, and the
command logger writes all child output even when it is not mirrored to the
terminal.

The implementation replaces that command with a narrow template that returns
only the image ID and configured image name. Its parser accepts that narrow,
non-sensitive output; it never parses a complete inspect object.

The workspace logger also gains structural redaction for assignments of the
three Boxdown secret variable names. This is a defense-in-depth backstop for
legacy logs or future accidental command output, not the primary protection.
Existing value-based redaction remains for dynamically acquired GitHub tokens.

## Lifecycle and Cleanup

- `initializeCommand` is the only writer of runtime secret files.
- `down` and `purge` remove the runtime-secret directory after stopping or
  removing the associated container.
- A new start refreshes values atomically, so no previous value remains when a
  host value is absent or 1Password lookup fails.
- Runtime secret state is never written below `workspaceDataDir` and is never
  included in status output.
- Existing workspaces require `boxdown start --recreate` to replace the old
  Docker environment configuration. Boxdown will not automatically migrate
  existing containers or `.env.development` files.

## Diagnostics and Documentation

Startup output may state whether the optional 1Password token was available,
but must not print values, file contents, or paths that encode secret data.
`boxdown doctor` verifies that the runtime-secret mount is constructible and
that the generated configuration contains neither the legacy `--env-file`
argument nor secret `containerEnv` entries. Missing optional values are
warnings, not failures.

Documentation will explain:

- which host values Boxdown forwards;
- that they are exposed to Bash sessions but not Docker configuration;
- that `.env.development` is project-owned and ignored by Boxdown;
- that `--recreate` is required for existing containers; and
- how to manually remove and rotate a legacy 1Password token if it was
  previously written to a workspace or log.

## Test Strategy

Tests will cover:

- host secret-state creation, owner-only modes, atomic refresh, and removal of
  stale files without printing values;
- success, missing host values, missing `op`, and failed 1Password lookup as
  non-blocking cases;
- generated configuration contains the read-only runtime mount and contains no
  `--env-file`, secret `containerEnv` keys, or secret values;
- `.env.development` is neither created nor altered by initialization or
  post-start hooks;
- interactive, non-interactive, SSH, and Boxdown coding-agent Bash launch
  paths export available values and leave unavailable values unset;
- image inspection uses only a narrow projection and workspace logs never
  receive a synthetic inspect environment value;
- logger structural redaction for all three known keys;
- doctor warnings and mount probes, with optional-secret absence non-fatal;
- focused tests first, then the full test suite, lint, build, Bash syntax
  checks, and `git diff --check`.

## Decision Record

The chosen design favors compatibility over strict command-level least
privilege. The three values are intentionally ordinary environment variables
inside Bash sessions. If this causes unacceptable in-container exposure or
developer-experience problems, a future design may replace session bootstrap
with per-command wrappers. That change would be a deliberate compatibility
break and is not part of this work.
