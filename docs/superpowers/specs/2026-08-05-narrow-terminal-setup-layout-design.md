# Narrow-Terminal Setup Layout Design

## Goal

Keep Boxdown's interactive setup hierarchy readable in narrow terminals. Long
prompt rows, headings, paths, and progress details must wrap onto intentional
physical lines instead of relying on the terminal to continue at column zero.

## Scope

This change covers the styled interactive setup surfaces visible in the
reported narrow-terminal flow:

- raw single-select and multi-select prompt titles;
- raw single-select and multi-select choices, including descriptions;
- multi-select skip choices;
- interactive progress section titles, detail rows, status rows, warnings,
  spinner labels, and checklist labels; and
- the redraw accounting used by raw prompts, spinners, and checklists.

The SSH installation result renderer already wraps to its supplied width. It
will consume the same low-level width and wrapping utilities where that removes
duplicate behavior without changing its output contract.

Numeric line-mode prompts, verbose output, detailed output, JSON output,
non-interactive output, result summaries, prompt values, and input handling are
unchanged. This keeps machine-readable and log-oriented behavior stable while
fixing the interactive terminal experience shown in the report.

## Shared Terminal Layout Primitives

A small CLI layout module will own the behavior currently duplicated by
interactive prompts and the SSH result renderer:

- resolve a valid terminal width, using 80 columns when the reported width is
  missing, non-integral, or non-positive;
- measure visible text without counting ANSI control sequences;
- wrap prose against first-line and continuation prefixes; and
- hard-wrap an individual token when it cannot fit on an otherwise empty line.

Hard-wrapping is required for workspace paths and similar unbroken values. No
input text may be dropped. Width calculations include visible rail, marker, and
indent characters but exclude colour control sequences. At extremely small
positive widths, the available content width is clamped to at least one visible
character so rendering always makes progress.

The shared wrapper returns complete physical lines. Callers remain responsible
for applying semantic colour to labels and descriptions. Focused multi-select
description segments retain their existing per-segment colours after wrapping;
wrapping must not merge, discard, or recolour those segments.

## Prompt Layout

Prompt titles remain on one line when they fit. A long title keeps the cyan
diamond on its first line and uses the cyan prompt rail on each continuation,
with title text aligned after the original marker spacing.

Choice rendering retains the current compact form when the complete option row
fits:

```text
│  ■ Node.js - package.json engines.node >=24.0.0; Boxdown default 24.17.0
```

When it does not fit, the label and description become separate logical rows:

```text
│  ■ Node.js
│    package.json engines.node >=24.0.0;
│    Boxdown default 24.17.0
```

Long labels wrap with a hanging indent aligned beneath the label text. This is
also how a long skip choice such as "Not now — Finish setup without adding the
project to an app." is rendered. Description continuations align beneath the
description's first line and remain dimmed. Existing selected, focused, and
unfocused marker and label styles are preserved.

Both raw prompt types use the same title and choice-layout primitives. The
single-select layout added previously becomes a consumer of the shared
implementation rather than a separate narrow-terminal special case.

## Progress Layout and Redraws

Interactive progress rendering receives the target stream width, either from
the real stdout/stderr stream or an explicitly injected test width. Section
titles, details, items, statuses, warnings, spinner labels, and step labels are
wrapped with rail-aware continuation prefixes.

Every dynamic renderer tracks physical output rows, not logical items:

- raw prompts flatten their wrapped title and choice lines before counting;
- checklists flatten every wrapped step before cursor-up redraws; and
- spinners clear and redraw all rows occupied by a wrapped spinner label.

Static progress lines use the same wrapper but need no redraw state. A status or
warning written above an active checklist restores the full wrapped checklist
and updates its stored physical row count.

## Error Handling and Compatibility

The layout layer is pure and deterministic. Invalid widths use the existing
80-column fallback. Very narrow widths may produce many physical lines, but
never an empty loop or lost content. ANSI-disabled output has the same visible
layout as coloured output.

The change does not alter keyboard controls, default selections, selected
values, cancellation, raw-mode cleanup, final summaries, progress state
transitions, or output routing.

## Testing

Focused tests will first capture the regressions from the screenshot:

- wide multi-select choices remain compact;
- narrow toolchain-like and app-target choices stack and wrap descriptions
  beneath their labels;
- long skip labels use a hanging indent;
- long prompt and progress titles continue beneath their marker or rail;
- long workspace paths are hard-wrapped without returning to column zero;
- focused coloured description segments retain their colours after wrapping;
- raw-prompt, checklist, and spinner redraw row counts include every emitted
  physical line; and
- invalid and extremely narrow widths fall back or clamp safely.

Existing prompt interaction and progress tests will protect input behavior,
selection summaries, colour disabling, progress modes, and lifecycle state.
Final verification will run the focused tests, the complete test suite, lint,
the TypeScript/package build, and whitespace checks.
