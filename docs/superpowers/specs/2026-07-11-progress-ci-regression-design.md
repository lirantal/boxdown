# Progress CI Regression Design

## Goal

Restore the test suite by fixing progress checklist cleanup in every output mode
and updating stale spinner-label assertions without changing user-facing output.

## Root Cause

`ProgressReporter.end()` stops timers before checking the output mode, but it
clears checklist state only after the interactive-only rendering guards. In
`none` and `verbose` modes, `isChecklistActive()` therefore remains true after
the reporter ends.

The SSH spinner labels remain present and are used when no checklist is active.
Their source expressions became conditional when checklist-owned output was
introduced, so the source-text test's direct-property regular expressions no
longer match them.

## Design

Move internal checklist cleanup ahead of the output-mode and section-rendering
guards in `ProgressReporter.end()`. Ending a reporter will always clear its
steps and rendered-line count, while only interactive reporters with an open
section will write the visual terminator.

Keep the existing source-presence test because it guards friendly spinner copy,
but make the two SSH assertions check for the label text rather than requiring
a particular property-expression shape. Existing runtime tests continue to
verify that checklist mode suppresses the standalone spinners.

## Scope

- Modify `src/progress.ts` only to make state cleanup mode-independent.
- Modify the two SSH label assertions in `__tests__/app.test.ts`.
- Do not change progress APIs, spinner copy, output formatting, or command flow.

## Verification

Use the two CI failures as the red phase, then run the targeted progress tests,
the full test suite, lint, and build. Verification must use a supported Node 24
runtime because the current host Node 26 runtime is incompatible with one of
the installed CommonJS test dependencies.
