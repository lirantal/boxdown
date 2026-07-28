# GPG signing diagnostic design

## Goal

Prevent Boxdown from presenting an inherited GPG/OpenPGP commit-signing
configuration as a successful, harmless SSH-signing skip when the default
Boxdown image cannot perform GPG signing.

## Problem

Boxdown snapshots the host Git configuration and copies it into the container's
writable global Git configuration. The existing signing bootstrap deliberately
preserves an explicit non-SSH signing preference. This protects user settings,
but a copied configuration such as `commit.gpgsign=true` with a GPG signing key
leaves Git instructed to sign inside the default image.

The default image intentionally does not install GnuPG, copy `~/.gnupg`, or
forward a GPG agent. Consequently, a commit can fail with a missing `gpg`
program or an inaccessible signing key. Current lifecycle output describes this
condition only as an SSH-signing skip, and `boxdown doctor` reports its
`git-signing-agent` check as `ok`. Neither result makes the likely commit
failure clear.

## Scope

This change adds an accurate warning in both lifecycle output and `boxdown
doctor`. It does not add GPG signing support.

In scope:

- Classify a preserved GPG/OpenPGP signing configuration separately from a
  generic user-controlled signing preference.
- Warn during `boxdown setup` and `boxdown start` before a container is created
  or reused.
- Report the condition as a non-blocking `warn` in `boxdown doctor`.
- Document the limitation of the default Boxdown image and point users to the
  supported SSH-signing path or a custom devcontainer configuration.
- Add focused regression coverage for every supported detection shape and for
  user-facing text.

Out of scope:

- Installing GnuPG, pinentry, or GPG tooling in the default image.
- Mounting `~/.gnupg`, copying secret keys, or forwarding a GPG-agent socket.
- Detecting whether a user-customized image happens to provide a functional GPG
  environment.
- Rewriting, disabling, or otherwise changing the user's Git signing settings.
- Adding a command-line override to choose SSH signing.

## Detection and classification

The effective Git settings remain read from repository-local configuration first
and then global configuration, matching existing signing resolution.

The new `gpg-signing-unavailable` reason applies only when all of the following
are true:

1. Git is configured to sign commits by default using an explicit signing
   configuration.
2. The configuration selects OpenPGP/GPG rather than SSH, either explicitly or
   by Git's default when a signing key and `commit.gpgsign=true` are set.
3. Boxdown would otherwise preserve that preference instead of configuring its
   SSH signing integration.

The classification must cover:

- `gpg.format` set to a non-`ssh` value, including `openpgp`.
- Any non-empty `gpg.program` value.
- No explicit `gpg.format`, plus a non-empty `user.signingkey` and a truthy
  `commit.gpgsign` value (`1`, `true`, `yes`, or `on`).

The existing generic `user-signing-preference` reason remains available for
explicit preferences that do not establish an enabled GPG commit-signing
configuration, including an explicit `commit.gpgsign=false` policy.

## User experience

The lifecycle warning is emitted while Boxdown writes the generated devcontainer
configuration. It is non-blocking and does not change the copied Git settings.
The stable structured workspace-log reason is `gpg-signing-unavailable`.

The human-readable lifecycle warning is:

> boxdown: GPG commit signing is configured, but the default Boxdown image does
> not provide GnuPG or GPG-agent forwarding; commits in this container may fail
> to sign.

`boxdown doctor` emits a `git-signing-agent` check with level `warn` and the
same explanation. A warning never changes the doctor's overall exit status.
The check does not query the SSH agent or GitHub SSH signing-key registration
when the GPG reason applies, because those results cannot fix the effective GPG
configuration.

The warning intentionally names the default image. A user can use a custom
devcontainer configuration that provides a safe GPG integration, though
Boxdown does not validate that integration.

## Architecture

`src/git-signing.ts` owns the canonical classification helper and disabled-plan
reason. Both lifecycle signing-plan resolution and doctor import this helper so
the two command surfaces cannot diverge in how they identify GPG settings.

`reportGitSigningPlan` maps the new reason to the lifecycle warning and
structured log entry. `src/doctor.ts` maps the same classification to its
non-blocking warning before any SSH-specific probes. The Bash signing bootstrap
continues to preserve user configuration and needs no behavioral change; its
existing preservation message remains applicable after the host-side warning.

`docs/features/commit-signing.md` documents the distinction: default Boxdown
supports SSH-agent signing, while a preserved GPG configuration requires a
user-supplied custom devcontainer integration.

## Tests and verification

Focused Node test-runner coverage will prove the prior false-success result for
each GPG detection shape, then assert:

- lifecycle planning returns `gpg-signing-unavailable` without calling
  `ssh-add -L`;
- lifecycle reporting emits the exact non-blocking warning and stable log
  reason;
- doctor emits a `warn` check with the exact explanation and skips SSH/GitHub
  signing checks;
- existing non-GPG signing-preference and SSH-signing paths retain their
  current levels and messages.

Documentation is Markdown-linted. The focused signing and doctor tests, full
test suite, lint, build, and `git diff --check` complete before the change is
considered ready.

## Success criteria

- A user who inherits enabled GPG signing into the default Boxdown image sees
  an explicit warning in both lifecycle output and `boxdown doctor`.
- The warning is non-blocking and does not mutate user Git configuration.
- SSH signing behavior and diagnostics are unchanged for users without the GPG
  configuration.
- The product does not claim that all custom images lack GPG support.
