# Live full agent profile design

## Summary

Change the `full` agent profile from an isolated recursive copy of agent homes
to a live, read-write bind mount of the host profile. Keep `none` and `auth`
unchanged.

## Problem

The current `full` profile stages and recursively copies all of `~/.agents`,
the Codex home, the Claude home, and the Claude config file. Agent homes are
live runtime state, not just configuration: they can contain sessions,
worktrees, caches, logs, generated files, and plugin artifacts. Copying a
large, changing tree is slow and can fail while an agent updates it. The
resulting container cannot be created.

## Decisions

- `full` means a live, read-write view of the selected host profile.
- `none` remains an empty host-profile tier.
- `auth` retains its existing staged, container-local copy behavior.
- The direct mount is intentional: changes an agent makes in a `full`
  container immediately affect the host profile.
- Existing custom mounts continue to own any canonical destination they
  overlap. Boxdown must not add a competing mount.

## Mount behavior

For `full`, Boxdown mounts every available source directly at its canonical
container destination, without `readonly`:

| Host source | Container destination |
| --- | --- |
| `~/.agents` | `/home/node/.agents` |
| `$CODEX_HOME`, or `~/.codex` | `/home/node/.codex` |
| `$CLAUDE_CONFIG_DIR`, or `~/.claude` | `/home/node/.claude` |
| Claude config file | `/home/node/.claude.json` |

No `full` source is mounted below `/opt/boxdown/agent-profile-source`.
If a source is absent, no mount is created; this keeps the existing
best-effort source-availability behavior. If a user mount owns a canonical
destination, Boxdown skips its corresponding mount and reports that destination
as custom-managed.

`auth` continues to use its read-only staging mounts and the existing bootstrap
copy into container-local homes. `none` mounts no host profile data.

## Container lifecycle and migration

The profile bootstrap no longer copies any source for `full`. It only writes a
live-profile marker, `full:live`, after the lifecycle hook starts successfully.

The host-side container inspection treats `full:live` as the active `full`
profile. The legacy `full` marker is not equivalent: a pre-change container
contains an isolated copy and therefore requires
`boxdown start --recreate --agent-profile full`. This is necessary because
mount configuration is fixed when the container is created.

`auth` and `none` retain their current markers and lifecycle behavior.

## User-facing behavior

Update the setup prompt, CLI help, README, feature documentation, and status
output to state that `full` is a live read-write host mount. Documentation must
make the consequence clear: profile changes, agent logins, plugin changes,
history, caches, and other agent writes made inside the container persist on
the host immediately.

Status should identify the `full` access mode as a live host mount, alongside
the existing per-source availability and custom-destination information.

## Testing

Add or update tests to prove that:

1. `full` creates direct canonical mounts with no `readonly` flag and no
   profile staging targets.
2. `auth` still uses read-only staging mounts and copies its profile data.
3. The `full` bootstrap leaves canonical home contents untouched and writes
   `full:live`.
4. User-provided canonical mounts still suppress Boxdown's corresponding
   `full` mount.
5. A legacy `full` marker requires recreation; `full:live` is accepted as the
   active full profile.
6. Status, interactive setup text, command help, and documentation describe
   the live, read-write behavior accurately.

## Non-goals

- Do not introduce a new `live` CLI profile value.
- Do not change `auth` or `none` semantics.
- Do not build a copy-on-write overlay or synchronize profile changes.
- Do not migrate existing containers in place.
