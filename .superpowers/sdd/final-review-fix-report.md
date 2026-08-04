# Final Whole-Branch Review-Fix Report

## Outcome

Implemented all seven whole-branch Cursor review findings in the assigned
Cursor source and test surfaces.

1. Structured interactive and detailed setup now suppress only routine Cursor
   disposition noise. It always prints the settings path, remote-folder URI,
   shell-safe open command, and refresh/restart handoff, and still never launches
   Cursor.
2. Cursor settings, ownership records, and lock-owner JSON are opened with
   `O_NONBLOCK`, checked through `fstat` on the opened descriptor, and rejected
   unless the opened leaf is a regular file. Ownership records are capped at
   1 MiB and lock-owner JSON at 16 KiB; Cursor settings remain uncapped.
3. Cleanup preserves valid user reconfiguration when
   `remote.SSH.remotePlatform` is absent or no longer an object, classifies the
   mapping as user-modified, and releases Boxdown ownership. Install remains
   strict.
4. Targeted and complete cleanup render one exact disposition per settings
   path for removed, user-owned, shared-owner, user-modified, and uncertain-peer
   results. Quiet cleanup emits only actionable uncertain-peer warnings, with
   the exact peer-record directory.
5. Added a minor `boxdown` changeset for Cursor Remote SSH support.
6. Cursor remote-folder URI components now RFC3986-encode `[!'()*]` in addition
   to the characters already handled by `encodeURIComponent`; command quoting
   remains unchanged.
7. Every persisted Cursor ownership record is forced to mode `0600`, including
   rollback persistence, while existing Cursor settings modes remain preserved.

Two existing purge regressions added on the feature branch were also corrected
to seed an explicit `remote.SSH.configFile` before using a custom
`BOXDOWN_SSH_CONFIG`; this makes the fixtures exercise purge rather than fail
the intended compatibility guard during setup.

## TDD Evidence

Each production change followed a focused RED-to-GREEN cycle:

- RFC3986 URI test: 0/1 passed before the encoding fix, then 1/1 passed.
- Null-parent targeted cleanup: 1 focused failure with the strict parent error;
  targeted and complete cleanup then passed 3/3 focused cases.
- Existing record permissions: 0/1 passed with actual mode `0644`; the focused
  mode and rollback group then passed 3/3.
- FIFO and size-limit group: 0/4 passed before the read fix. All three FIFO
  subprocesses reached their bounded five-second timeout, proving the hang.
  After the fd/fstat change, the group plus symlink preservation passed 7/7;
  FIFO subprocesses completed in about 0.15-0.22 seconds.
- Structured setup handoff: 0/1 passed because quiet mode hid the handoff; the
  interactive/detailed setup case plus standalone install then passed 2/2.
- Multi-path and quiet uncertainty output: 0/2 passed before per-result
  formatting; the covering cleanup group then passed 4/4.
- Actionable uncertainty path: 0/1 passed before the exact peer directory was
  included, then the two cleanup-output cases passed 2/2.

## Verification

Commands used the bundled Node.js 24.14.0 and pnpm 11.9.0 runtimes where shown.

- `node --import tsx --test __tests__/cursor-app-config.test.ts`: 55/55 passed.
- Combined
  `/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --import tsx --test __tests__/cursor-app-config.test.ts __tests__/setup-agent-profile.test.ts __tests__/app.test.ts`:
  the first run passed 424/427. Two failures exposed incomplete purge fixtures
  and were repaired; the remaining failure was the known sandbox-only Unix
  socket `EPERM`. Both repaired purge cases then passed 2/2.
- `PATH="/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" /Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm test`, rerun
  outside the filesystem sandbox so the Unix-socket fixture could bind:
  565/565 passed, 0 failed, 0 skipped.
- `PATH="/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" /Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm run lint`: passed
  ESLint and markdownlint.
- `PATH="/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" /Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm run build`: passed
  TypeScript compilation and both CJS/ESM `tsdown` builds.
- `git diff --check`: passed.
- An independent read-only audit reported no Critical or Important gaps and
  judged the fix set ready.

## Platform Coverage and Concerns

No platform test was skipped on this macOS host. The three `mkfifo` regressions
are explicitly skipped on Windows, where `mkfifo` is unavailable; the
production reader uses Node filesystem flags and fd metadata on every platform.

No unresolved product concern remains. The initial sandboxed combined run's
Unix-socket `EPERM` was environmental and passed in the required unrestricted
full-suite rerun.

## Interactive TTY Follow-up

A final re-review found that Cursor's essential handoff still wrote directly to
stdout while the interactive setup checklist owned the terminal. Completing the
Cursor step then moved upward by the checklist height and overwrote those lines.

The focused RED test uses one terminal-output model for normal and raw progress
writes, enables `isTTY: true`, renders the real five-step setup checklist, and
completes the Cursor step after emitting all four handoff lines. Before the fix,
the remote-folder URI appeared zero times instead of once. The detailed and
non-TTY preservation scenario passed at RED.

Cursor installation now accepts an optional essential-output callback. Setup
routes that callback through `ProgressReporter.output()`, which clears and
restores an active interactive checklist while keeping handoff text plain. A
standalone install retains the direct-stdout fallback. Routine quiet output is
still suppressed, and no Cursor launch was introduced.

Follow-up verification:

- Focused Cursor setup, standalone install, and progress redraw group: 5/5
  passed.
- Full suite outside the filesystem sandbox: 581/581 passed, 0 failed, 0
  skipped.
- TypeScript and CJS/ESM build: passed.
- ESLint initially caught a dynamic test-only `RegExp`; the assertion was made
  literal, then ESLint and markdownlint passed on rerun.
