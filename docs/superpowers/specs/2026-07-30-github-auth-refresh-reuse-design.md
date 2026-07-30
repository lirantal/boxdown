# GitHub Auth Refresh Reuse Design

## Goal

Make `boxdown refresh-gh-token` the only GitHub CLI auth-refresh command. It
must refresh a matching running workspace devcontainer in place and invoke the
normal devcontainer startup path only when no matching container is running.

Remove `boxdown refresh-gh-token-running` outright. It is not retained as an
alias or deprecated command.

## Command contract

`boxdown refresh-gh-token [--agent-profile <tier>]` resolves the requested
agent profile in the same way it does today: an explicit option wins, then
recorded workspace metadata, then the default `auth` profile.

The command has two paths:

1. When a workspace devcontainer is running, Boxdown verifies that the
   container reports the resolved profile. A match refreshes GitHub auth in
   place. A mismatch fails with the existing guidance to recreate via
   `boxdown start --recreate --agent-profile <tier>`.
2. When no workspace devcontainer is running, Boxdown performs its existing
   container lifecycle preparation, starts the devcontainer, validates the
   resulting profile, and refreshes GitHub auth.

The running-container path does not perform a Docker runtime readiness wait,
write workspace metadata, prepare an SSH identity, write startup config, or
invoke `devcontainer up`. GitHub auth refresh retains its own generated-config
step because it needs that configuration for the auth operation.

`--recreate` remains outside this command's documented interface and does not
form part of this change.

## Implementation shape

Keep startup behavior centralized in `startDevcontainer()`. Add or expose the
small profile-validation helper needed by the refresh fast path rather than
duplicating its inspection logic or error message in `main.ts`.

In the `refresh-gh-token` CLI branch, look up the running container before
choosing progress steps:

- A running container uses the existing `ghAuthProgressSteps(false)` form,
  which reports `Using running devcontainer`, validates its profile, then runs
  `refreshContainerGhAuth`.
- No running container uses `ghAuthProgressSteps(true)`, then follows the
  current lifecycle preparation and `startDevcontainer` flow before the same
  refresh call.

This keeps a failed Docker lookup on the fallback path, where the existing
runtime preflight supplies the normal diagnostic and no state is written before
that preflight succeeds.

Remove the command from the command union, parser, usage text, command
descriptions, and GitHub-auth feature documentation. Remove its dedicated
runtime/metadata rules and tests, and update help-layout assertions affected by
the shorter command list.

## Progress and errors

For a running compatible container, interactive output must display `Using
running devcontainer`; it must not display `Starting devcontainer`. Refresh
failures preserve the current progress failure reporting.

A running container with a missing or different profile is treated as a
profile mismatch. A nonexistent or stopped container uses startup fallback.

## Tests

Add focused command-dispatch tests that prove:

- a running matching-profile container does not call lifecycle preparation or
  `startDevcontainer`, and does call GitHub auth refresh;
- a running mismatched-profile container fails before refresh or startup;
- no running container performs lifecycle preparation, startup, then refresh;
- the normal and explicit agent-profile values are both passed to profile
  validation and refresh;
- `refresh-gh-token-running` is rejected as an unknown command;
- usage and feature documentation list only `refresh-gh-token` and accurately
  describe its reuse-then-start behavior.

Retain existing auth-refresh tests that cover host-token transfer and Git
credential configuration.
