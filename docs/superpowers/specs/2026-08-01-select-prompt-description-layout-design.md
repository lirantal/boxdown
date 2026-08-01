# Select Prompt Description Layout Design

## Goal

Make long single-choice prompt descriptions readable in narrow terminals without
changing selection behavior, colour treatment, or non-interactive output.

## Scope

The shared `promptSelect` renderer in `src/interactive-prompts.ts` will choose
between two layouts for interactive choices:

- When the complete option row fits within the available terminal width, retain
  the existing compact inline description.
- When it does not fit, place the dimmed description on the next line. Wrap
  any continuation lines to the available width and indent them beneath the
  description rather than returning them to the left edge of the terminal.

This behavior applies to every interactive single-choice prompt, including the
setup agent-profile selector. Numeric fallback rendering and prompt results are
unchanged.

## Layout Details

The option marker and label retain their existing focused/unfocused styling.
For a wrapped description, the first description line begins below the option
label and every continuation line begins at the same column. The renderer
accounts for prompt rail characters and ANSI styling when deciding whether the
compact row fits, but emitted ANSI sequences do not count toward visible width.

## Error Handling and Compatibility

If terminal width is unavailable or invalid, the renderer uses the existing
inline row. No input handling, cancellation behavior, selected-summary output,
or non-interactive fallback changes.

## Testing

Focused renderer tests will assert that a sufficiently wide terminal keeps an
option description inline, while a narrow terminal moves it below the option
and preserves indentation across wrapped continuation lines. Existing prompt
interaction tests continue to verify selection, focus, cancellation, and
fallback behavior.
