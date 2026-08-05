# SSH Install Result UX Design

## Summary

Boxdown will replace the unstructured output from `boxdown ssh install` with a
clear configuration flow, an explicit final outcome, app-specific next actions,
and compact technical details. The same structured install results will feed the
existing `boxdown setup` progress experience so ChatGPT, Claude, Cursor, and
future integrations follow one presentation contract.

The redesign is intentionally limited to SSH and app installation outcomes. It
does not introduce a universal CLI event framework or redesign unrelated
commands.

## Problem

The interactive target selector already uses Boxdown's styled prompt language,
but the command then falls back to installer-owned prose. A Cursor install can
produce a dense sequence of labels, paths, URIs, commands, and advice without a
clear hierarchy or final status.

This creates four user-facing problems:

- the styled interaction abruptly becomes a block of plain text;
- important outcomes and next actions have no visual priority;
- long `Label: value` lines wrap like prose in terminals narrower than 80
  columns; and
- users cannot quickly distinguish success, warnings, and failure.

The implementation reflects this fragmentation. `installSshConfig` and each
app target print their own output directly. Cursor also needs `quiet`,
`writeEssential`, and `warn` hooks to keep essential handoff text visible while
setup progress is active. These presentation concerns prevent the integrations
from sharing a stable experience.

## Goals

- Make the final state of `boxdown ssh install` obvious at a glance.
- Continue the visual language used by Boxdown's interactive prompts and
  progress checklists.
- Work cleanly in terminals narrower than 80 columns.
- Give every app integration one consistent, app-specific next-action pattern.
- Distinguish completed configuration, completed configuration with warnings,
  and incomplete configuration.
- State honestly that a successful install configures access but does not test
  the SSH connection.
- Preserve full, copyable paths and commands without turning the default output
  into a diagnostic dump.
- Let `setup` and `ssh install` consume the same structured app results.
- Keep installers focused on state changes instead of terminal presentation.
- Preserve idempotence and user-owned configuration behavior.

## Non-goals

- Automatically test the installed SSH connection.
- Automatically launch ChatGPT, Claude, or Cursor.
- Add JSON output to `ssh install` or `setup`.
- Redesign `ssh uninstall`, `status`, or unrelated commands.
- Roll back successful independent writes after a later target fails.
- Replace Boxdown's existing progress system.
- Build a general-purpose event framework for every command.

## Chosen Approach

SSH and app installers will return structured results. A command-level
orchestrator will combine those results, and a shared renderer will own the
terminal presentation.

This approach is preferred over styling the current print statements because
it prevents app integrations from drifting apart. It is preferred over a
universal event framework because it solves the current problem with a small,
focused abstraction.

## User Experience

### Successful Cursor installation

The default interactive result will use the following hierarchy:

```text
◆  Configure remote access
│  ✔ SSH alias configured
│  ✔ Cursor configured
└

✔ Configuration complete
  SSH connection not tested.

Next step

  Open this project in Cursor:

    cursor --folder-uri \
      'vscode-remote://ssh-remote+.../workspaces/...'

Details

  SSH alias
    snyk-vulnbench-website-devcontainer

  SSH config
    /Users/lirantal/.ssh/config

  Cursor settings
    /Users/lirantal/Library/Application Support/Cursor/User/settings.json
```

The output deliberately separates progress, outcome, action, and details. Long
values start on their own lines so a terminal soft-wrap cannot make them look
like a continuation of explanatory prose.

### Completed with warnings

A configuration warning does not become a false failure:

```text
◆  Configure remote access
│  ✔ SSH alias configured
│  ✔ Cursor configured
│  ! Cursor Remote SSH extension could not be verified
└

! Configuration complete with warnings
  SSH connection not tested.

Next steps

  1. Install or verify Cursor Remote SSH:

       cursor --install-extension anysphere.remote-ssh

  2. Open this project in Cursor:

       cursor --folder-uri \
         'vscode-remote://ssh-remote+.../workspaces/...'
```

Opening the selected app is normally its primary action. When a warning
identifies a prerequisite that is likely to prevent that action from working,
the concrete remediation appears immediately before the app action.

### Partial failure

If the SSH alias succeeds but Cursor configuration fails, the output preserves
that distinction:

```text
◆  Configure remote access
│  ✔ SSH alias configured
│  ✖ Cursor configuration failed
└

✖ Configuration incomplete
  SSH access is configured, but Cursor was not.

Problem

  Cursor uses a different SSH config:
    /path/to/cursor/config

  Boxdown updated:
    /Users/lirantal/.ssh/config

Next step

  Update Cursor's remote.SSH.configFile, then rerun:

    boxdown ssh install --target cursor
```

The renderer must not claim that the complete request succeeded when only part
of it did.

## Presentation Rules

- Green `✔` means a requested configuration step succeeded.
- Yellow `!` means configuration succeeded but needs attention.
- Red `✖` means a requested operation failed.
- Color reinforces the icon and outcome text but never carries meaning alone.
- The final outcome is visually separate from progress and details.
- Long paths, URIs, and commands begin on dedicated indented lines.
- Prose wraps with a stable hanging indent at the available terminal width.
- Commands use platform-appropriate continuation syntax when the generated
  command is split across display lines.
- Values remain complete and copyable; default output does not truncate them.
- Tables are not used because they degrade in narrow terminals.
- Recovery advice appears only when it is relevant.
- Multiple app actions appear as numbered next steps in target selection order.
- ANSI escape sequences do not count toward visible width.
- `NO_COLOR` and non-TTY output disable ANSI styling.
- Very narrow terminals degrade to a simple vertical layout.

## Consistent App Actions

Every app result exposes one primary action appropriate to that app. Consistent
behavior means a shared structure, not identical instructions:

- ChatGPT: restart ChatGPT, then open the configured remote project.
- Claude: restart Claude, then open the configured SSH remote.
- Cursor: run the generated remote-folder command.

If several apps are selected, their actions remain in selection order. A
failed app does not emit its normal action. A successful app can still emit its
action when another independent app fails. Each app's prerequisite remediation,
when present, stays immediately before that app's primary action without
reordering the app groups.

## Structured Result Model

The exact TypeScript names may be refined during planning, but the model needs
the following concepts.

### SSH result

An SSH install result contains:

- disposition: installed or already current;
- alias;
- SSH config path;
- identity path;
- validation command; and
- default and verbose detail entries.

The validation command is retained for diagnostics, but the default result
states `SSH connection not tested` instead of presenting validation as the
primary action.

### App result

An app install result contains:

- stable target identifier;
- user-facing app label;
- disposition: installed, already current, or compatible user-owned state
  preserved;
- warnings with optional remediation;
- one primary next action;
- default and verbose detail entries; and
- any platform-specific command label or display form.

Compatible preserved state is a success. For example, a user-owned Cursor
Linux mapping that already has the required value should render as already
compatible rather than as a warning.

### Command summary

The orchestrator combines the SSH result, target results, failures, skipped
steps, and warnings into one command summary. It preserves execution and target
selection order. The renderer derives the final outcome from this summary
rather than from ad hoc text supplied by an installer.

## Component Responsibilities

### SSH configuration

The SSH configuration component validates and modifies the managed SSH alias,
then returns an SSH install result. It no longer prints install messages,
paths, or validation instructions directly during the structured install flow.

### App targets

Each target modifies only its own integration and returns an app install
result. Target code owns app-specific facts and actions, but it does not own
colors, headings, indentation, wrapping, or stream selection.

Cursor's prerequisite check becomes structured warning data. The current
`quiet`, `writeEssential`, and `warn` presentation workarounds are removed from
the install path once both callers consume structured results.

### Command orchestration

The command orchestrator:

1. resolves selected targets before mutation;
2. installs the core SSH alias;
3. records its result or failure;
4. installs requested app targets in selection order;
5. records each result, warning, or failure;
6. continues after an independent app failure;
7. derives the overall exit status; and
8. renders one coherent final report.

### Progress and result rendering

The existing progress reporter continues to show transient work. A focused
install-result renderer shows durable outcomes and handoff instructions.

`boxdown ssh install` uses the full structured flow. `boxdown setup` keeps its
existing lifecycle checklist but passes the same returned app results to the
shared final renderer. This avoids duplicate Cursor handoff lines and ensures
that warnings and actions match between both commands. The renderer accepts a
command-specific outcome label: standalone install says `Configuration
complete`, while setup says `Setup complete`. Warning and incomplete variants
follow the same wording pattern.

The renderer writes a complete managed report to one output stream so warnings
or failures cannot appear out of order with successful steps. It does not also
print the same warning or error separately to another stream. Errors that occur
before a structured report can be constructed continue to use the CLI's normal
error path.

## Outcome and Exit Semantics

The command has three final outcomes:

| Outcome | Meaning | Exit code |
| --- | --- | --- |
| Configuration complete | Every requested write succeeded | `0` |
| Configuration complete with warnings | Writes succeeded; optional prerequisites or follow-up conditions need attention | `0` |
| Configuration incomplete | One or more requested writes failed | `1` |

Warnings include cases such as an unavailable Cursor CLI or an unverified
Remote SSH extension. Failures include invalid target configuration,
conflicting required values, or an unwritable managed file.

Idempotent states are successful. User-facing step labels distinguish
`configured`, `already configured`, and `already compatible` without changing
the overall success semantics.

Cancellation at the target selector happens before mutation and produces a
concise canceled result. This design does not otherwise change cancellation
exit semantics.

## Failure and Dependency Rules

- A core SSH failure skips every app target because the integrations depend on
  the managed alias.
- One app failure does not prevent later independent app targets from running.
- Any requested app failure makes the final exit code `1`.
- Successful earlier writes are not rolled back. Rollback could remove valid
  pre-existing or user-owned configuration, and each operation is designed to
  be safely rerunnable.
- The final summary names successful, failed, and skipped work explicitly.
- Failed apps do not emit their normal next action.
- Warnings include concrete remediation only when one is known.
- Default failures show a concise cause and safe next step.
- Lower-level diagnostics remain available through verbose output and the
  workspace command log.

These dependency rules apply to the SSH/app installation phase of both
`ssh install` and `setup`. They do not change how setup handles an earlier
container lifecycle failure.

## Output Modes

### Default interactive

Shows styled progress, the final outcome, ordered next actions, and compact
details. Compact details include the SSH alias, SSH config path, and selected
app configuration paths.

### Verbose

Adds identity paths, backup paths, ownership decisions, generated URIs, and
lower-level diagnostics. The `ssh install` usage text will explicitly document
`--verbose` as supported.

### Non-TTY and CI

Uses stable line-oriented output without ANSI color, cursor movement, or
decorative rails. It preserves the same semantic order: steps, outcome,
warnings or problems, next actions, then details.

JSON output is outside this design.

## Backward Compatibility

The command continues to install the same SSH and app state, use the same
target names, preserve the same user-owned configuration, and avoid launching
apps or testing connections. The intentional user-visible changes are output
format, warning placement, app-failure continuation, and clearer final status.

Exact prose should not be treated as a stable machine interface. Non-TTY output
remains deterministic enough for human-readable logs. Existing tests that
assert installer-owned sentences will be updated to assert structured outcomes
and stable facts instead.

## Verification Strategy

### Result mapping tests

- SSH installed and already-current dispositions.
- ChatGPT, Claude, and Cursor installed and idempotent dispositions.
- Compatible user-owned Cursor state remains successful.
- Cursor prerequisite failures map to warnings with remediation.
- Each target returns the correct primary action and detail visibility.

### Renderer tests

- Normal and narrow terminal widths.
- ANSI-aware visible-width calculation and hanging indentation.
- Dedicated-line rendering for paths, URIs, and commands.
- Platform-correct POSIX and PowerShell command display.
- Color, `NO_COLOR`, non-TTY, and verbose variants.
- Complete, complete-with-warnings, and incomplete summaries.
- Multiple actions remain in target selection order.

### Command-flow tests

- Core SSH failure skips all targets and exits `1`.
- One app failure does not block later independent targets.
- Any app failure produces an incomplete result and exit `1`.
- Warnings preserve exit `0`.
- Failed apps omit their normal action.
- Successful apps retain their action during partial failure.
- Cancellation occurs before mutation.
- No flow launches an app or attempts an SSH connection.

### Integration regressions

- `setup` and `ssh install` render identical app warnings and next actions.
- Interactive progress does not duplicate or erase final handoff details.
- Non-TTY output contains no ANSI or terminal-control sequences.
- Existing Cursor ownership, config-path validation, and cleanup behavior remain
  unchanged.

## Documentation

Update the SSH integration and setup feature documentation with the new result
semantics, the meaning of warnings, the fact that connections are not tested,
and the availability of `--verbose` details. Examples should show the shared
next-action pattern without promising an automatic app launch.
