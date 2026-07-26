# Setup Transparency Design

## Problem

Boxdown's normal interactive setup UI is intentionally concise. Its four
high-level steps communicate progress, but do not give a control-conscious user
a useful model of what Boxdown is doing to their machine. The existing
`--verbose` switch solves a different problem: it streams raw child-process
output. That output is useful in CI and for deep debugging, but it is a poor
way to explain Boxdown's lifecycle, state ownership, mounts, and safety
boundaries.

The product needs to make setup understandable without adding another
discoverability burden such as `--explain` or `--dry-run`.

## Goals

- Keep normal interactive setup compact and fast to scan.
- Make interactive `--verbose` a structured, chronological account of what
  Boxdown is doing and why.
- Preserve raw text streaming for CI and non-interactive consumers.
- Retain a full redacted managed-command log for diagnosis in every mode.
- Make Boxdown's ownership and non-ownership model easy to discover in the
  README.

## Non-goals

- Add a new explanation, preview, or dry-run flag.
- Change which resources Boxdown creates, mounts, or removes.
- Stream interactive shell, coding-agent, or tunnel session bytes into the
  managed command log.
- Change JSON output semantics.

## Output model

Boxdown will have four output behaviours, selected by context rather than by
new command-line surface area.

| Context | Behaviour |
| --- | --- |
| Interactive default | Existing compact animated checklist. |
| Interactive `--verbose` | Expanded structured lifecycle trace; no wall of raw child-process output. |
| CI or non-TTY | Existing raw text streaming, with simple textual status output. |
| JSON | No progress output. |

`--verbose` therefore means "more operational detail" in every context. Its
rendering differs appropriately: a human terminal receives structured detail,
while a log consumer receives raw command output.

The raw managed output continues to be appended to the workspace command log
regardless of interactive verbosity. Verbose interactive output and failure
messages must name that log path clearly so a user can inspect the complete
redacted subprocess output when needed.

## Interactive setup UX

### Normal mode

Keep the existing compact setup checklist. At the beginning of an interactive
setup, add one concise ownership statement:

```text
Boxdown keeps generated state outside this repository.
Run `boxdown status` to inspect managed paths and the command log.
```

This is an orientation cue, not a replacement for documentation or detailed
progress. It must not imply that Boxdown never changes host state: the command
still owns its documented cache/data, SSH, and selected app-integration state.

### Interactive `--verbose`

Render completed and in-progress lifecycle events as readable, append-only
text rather than a spinner or raw subprocess stream. Events are emitted from
the real workflow, not from a static marketing list. The trace must include
the existing runtime, identity, generated-config, container-start, SSH target,
GitHub-auth, and coding-agent work as applicable.

It also exposes meaningful lifecycle-hook markers, with a short explanation
and destination where useful. Typical setup output includes:

```text
Checking Docker and Buildx readiness
Preparing the workspace SSH identity
Writing the generated devcontainer configuration
  Generated state is outside the repository: ~/.local/share/boxdown/...
Starting the devcontainer
Configuring the container's writable Git configuration
Configuring commit-signing policy
Preparing the container SSH runtime
Installing workspace dependencies
Installing the workspace SSH alias
```

The precise set stays command-specific; for example, `start` has no SSH-alias
installation and `ssh-proxy` writes progress to stderr to preserve stdout for
SSH protocol traffic.

Warnings retain their current visibility in every non-JSON mode. A warning must
identify the affected optional capability and provide an actionable next step
when one exists; this design does not otherwise change commit-signing policy.

## Technical design

The present progress implementation treats `verbose` as both a rendering mode
and permission to mirror child stdout/stderr. Split those concerns:

- Introduce distinct progress/output modes for interactive checklist, detailed
  interactive trace, raw text, and none.
- Resolve `--verbose` plus an interactive TTY to the detailed interactive
  trace mode.
- Resolve CI or a non-TTY to raw text mode, whether or not `--verbose` was
  explicitly passed; preserve the current raw stream routing rules, including
  `ssh-proxy` stderr routing.
- Make command execution decide child-output mirroring from the raw-text mode,
  not from a generic `verbose` boolean.
- Preserve marker parsing in both interactive modes. Detailed mode turns those
  markers into readable lifecycle events rather than raw marker lines.

The implementation should use one structured event source shared by default
and detailed modes. This avoids duplicate lifecycle descriptions and ensures
that the verbose trace only claims work Boxdown actually performed.

Existing command logs remain the canonical full, redacted child-output record.
Add a reusable user-facing log-path line for detailed-mode completion and
failures where a workspace logger exists.

## Help and documentation

Update `--help` so relevant command synopses show `[--verbose]`. Describe the
flag precisely: it shows a detailed lifecycle trace in an interactive terminal
and streams raw command output in CI/non-interactive contexts.

Add a prominent README section titled **What Boxdown manages**. It must cover:

- generated configuration, persistent workspace data, runtime state, and the
  command log, all outside the repository;
- the host paths and credentials that are mounted or copied into the
  container, including their read-only/writable status where applicable;
- SSH aliases and optional Codex/Claude app integrations;
- what Boxdown deliberately does not do, including copying `.devcontainer`
  into the project or deleting repository files;
- the lifecycle boundary between `stop`, `down`, and `purge`.

The README is the durable explanatory source. CLI output remains short and
links users to `boxdown status` for the exact workspace paths instead of
duplicating the whole document on every setup.

## Error handling and compatibility

- JSON remains machine-readable and receives no progress or explanatory
  preamble.
- `ssh-proxy` continues to reserve stdout for the SSH stream; all structured
  or raw progress goes to stderr.
- Failure messages retain output-tail diagnostics and command-log paths.
- Existing non-TTY/CI consumers keep raw subprocess streaming, so log parsing
  does not regress.
- The command log remains redacted according to the existing secret-redaction
  policy.

## Verification

Add focused tests for:

- progress-mode resolution for interactive default, interactive `--verbose`,
  CI, non-TTY, and JSON;
- detailed trace rendering without child-output mirroring;
- raw mode retaining stdout/stderr mirroring and proxy stderr routing;
- lifecycle markers appearing as structured detailed events;
- a command-log path being shown for detailed interactive setup and failures;
- help synopses and option text describing the context-sensitive `--verbose`
  behaviour;
- README content describing the resource-ownership boundary.

Run the project test suite, lint, build, and `git diff --check` before
completion.
