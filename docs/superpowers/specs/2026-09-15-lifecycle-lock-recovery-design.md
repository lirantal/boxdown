# Lifecycle Lock Recovery Design

## Problem

Boxdown serializes devcontainer startup per workspace with a filesystem lock. If
the owning process is interrupted while a Docker lookup is blocked, its
`finally` cleanup cannot run and the lock remains on disk. A later invocation
waits silently for up to five minutes, but it does not check whether the owner
PID is dead until the lock is ten minutes old. This makes a recoverable orphaned
lock appear as a startup hang.

The observed failure was caused by a `boxdown ssh-proxy` process that acquired
the workspace lock and then blocked in the filtered `docker ps` lookup used by
`findWorkspaceContainer`. The process exited before releasing its lock. Later
`boxdown start` and `boxdown ssh-proxy` processes passed runtime readiness and
then waited behind that dead owner.

## Goals

- Reclaim a lifecycle lock as soon as its recorded owner PID is confirmed dead.
- Preserve serialization while the recorded owner PID is alive.
- Make lock contention visible in Boxdown's progress output.
- Prevent the workspace-container Docker lookup from blocking forever.
- Add regression coverage for orphan recovery, live-owner waiting, notification,
  and Docker lookup timeout behavior.

## Non-goals

- Removing lifecycle serialization.
- Reworking Cursor integration locking, which is a separate lock and workflow.
- Adding deadlines to long-running lifecycle operations such as
  `devcontainer up`, image builds, container stops, or container removal.
- Automatically deleting malformed lock state without reporting it.

## Considered Approaches

### 1. Reduce the stale-lock age

Lowering the ten-minute threshold would shorten the hang, but a dead owner
would still block all callers for an arbitrary period. It also leaves the
five-minute acquisition timeout and stale threshold coupled in a fragile way.

### 2. Reclaim any lock older than a threshold

Age-only recovery could delete a valid lock while a slow image build or
devcontainer hook is still running. That would defeat serialization and permit
concurrent lifecycle mutations.

### 3. Reclaim confirmed-dead owners immediately and bound the lookup

This is the selected approach. PID liveness distinguishes an orphan from a
valid long-running owner. Reclamation atomically renames the lock to a
generation-specific, non-empty tombstone. The retained tombstone prevents a
late reclaimer for that owner generation from moving or deleting a replacement
lock. A timeout on the filtered `docker ps` lookup prevents the specific
external command that caused the incident from holding the lock indefinitely.

## Design

### Lock acquisition and recovery

When acquisition observes an existing, well-formed lock, it checks the recorded
PID immediately. If the PID is not alive, it re-reads and compares the complete
owner record, atomically renames that exact lock to a path derived from the full
owner record, verifies the moved owner, and retries acquisition. The non-empty
renamed directory is retained as a generation tombstone: simultaneous or late
reclaimers use the same destination and therefore cannot rename a newer lock
over it. Tombstones are removed with the workspace's data during purge. Lock
age is not part of dead-owner recovery.

If the PID is alive or liveness cannot be determined, Boxdown retains the lock
and waits up to the existing five-minute acquisition timeout. A live owner is
never reclaimed based only on age because legitimate devcontainer startup can
take longer than ten minutes. The obsolete stale-lock option and constant are
removed to avoid implying an age-based recovery policy.

### Contention visibility

`WorkspaceLifecycleLockOptions` gains an optional `onWait` callback. Acquisition
calls it once after it first observes a lock that it cannot reclaim. It is not
called repeatedly during the 50 ms polling loop.

`startDevcontainer` supplies a callback that reports
`Waiting for another Boxdown operation` through the existing progress reporter.
Non-interactive and verbose modes use the reporter's established formatting;
callers without progress remain quiet.

### Docker lookup deadline

The filtered `docker ps -a` call in `findWorkspaceContainer` receives a
30-second timeout through `runBuffered`. If Docker does not answer, the existing
inspection failure path is used, and the command log contains the timeout
diagnostic. The lifecycle lock is then released normally by `finally`.

The timeout is deliberately limited to this fast metadata lookup. Long-running
container creation and mutation commands keep their current behavior.

## Error Handling

- A dead owner is recovered transparently.
- A failed or unverifiable atomic reclaim fails closed rather than deleting a
  possibly replaced lock.
- An alive or indeterminate owner eventually produces the existing lifecycle
  lock timeout error.
- A missing owner file retains the current bounded wait, allowing an acquiring
  process to finish the atomic directory-plus-owner-file sequence.
- A malformed owner file continues to fail explicitly.
- A timed-out Docker lookup fails as `Could not inspect devcontainer for ...`;
  detailed timeout evidence remains in the per-workspace command log.

## Testing

- Create a young lock owned by a dead PID and assert immediate recovery without
  sleeping, plus retention of its generation tombstone.
- Simulate two reclaimers for one dead generation and assert the late reclaimer
  cannot move the replacement lock.
- Create a lock owned by a live PID and assert the contender waits, emits one
  notification, and enters only after release.
- Assert the notification is wired from `startDevcontainer` to progress output.
- Assert `findWorkspaceContainer` passes a 30-second timeout to its Docker
  command and rejects a timed-out result.
- Run focused tests, the full test suite, lint, and build.
