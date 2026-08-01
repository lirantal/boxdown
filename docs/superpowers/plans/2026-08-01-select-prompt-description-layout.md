# Select Prompt Description Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render long interactive single-choice prompt descriptions below their option with stable indentation when the terminal is narrow.

**Architecture:** Keep `promptSelect`'s public API, input handling, final summary, and line-mode fallback unchanged. Add width-aware raw-render helpers in `src/interactive-prompts.ts`; they retain the inline option row when it fits and otherwise emit a separate, dimmed description line whose wrapped continuations share its indentation.

**Tech Stack:** TypeScript, Node.js test runner, `tsx`, existing ANSI style primitives.

## Global Constraints

- Apply the layout to raw interactive `promptSelect` choices only; numeric line-mode fallback remains unchanged.
- Do not count ANSI control sequences when measuring visible terminal width.
- Preserve existing focus markers, label emphasis, dim description styling, keyboard controls, cancellation, redraw cleanup, and summary output.
- Use an 80-column fallback only when `output.columns` is absent or invalid, matching existing terminal-width behavior.

---

## File Structure

- `src/interactive-prompts.ts` owns raw single-choice prompt row rendering and terminal redraw accounting.
- `__tests__/app.test.ts` owns interaction-level assertions for the shared prompt primitives.

### Task 1: Add width-aware raw select option rendering

**Files:**
- Modify: `src/interactive-prompts.ts:101-153,382-449`
- Test: `__tests__/app.test.ts:1045-1250`

**Interfaces:**
- Consumes: `SelectPromptChoice<T>`, `PromptOutput`, `terminalColumns(output)`, `visibleLength(value)`, and existing ANSI style helpers.
- Produces: `formatSelectChoiceLines(choice, isFocused, output): string[]`, used by `promptRawSelect` to produce every option row.

- [ ] **Step 1: Add failing rendering tests for wide and narrow terminals**

Add the following tests inside `describe('single-choice prompt')`, using raw-mode
`fakePromptStreams`, a single choice, and Enter to finish each prompt:

```ts
test('keeps a raw single-choice description inline when it fits', async () => {
  const { input, output, outputText } = fakePromptStreams({ columns: 120 })
  const resultPromise = promptSelect({
    title: 'Agent profile?',
    choices: [{ value: 'auth', label: 'Authentication and ~/.agents', description: 'Copy agent authentication and ~/.agents; Boxdown default.' }],
    defaultValue: 'auth',
    input,
    output,
    env: { CI: 'false' }
  })

  assert.match(outputText(), /Authentication and ~\/\.agents.* - Copy agent authentication and ~\/\.agents; Boxdown default\./)
  input.write('\r')
  assert.deepStrictEqual(await resultPromise, { status: 'selected', value: 'auth' })
})

test('indents wrapped raw single-choice descriptions below their option', async () => {
  const { input, output, outputText } = fakePromptStreams({ columns: 36 })
  const resultPromise = promptSelect({
    title: 'Agent profile?',
    choices: [{ value: 'full', label: 'Full agent profiles', description: 'Copy complete Codex, Claude, and ~/.agents profiles; may include sensitive data.' }],
    defaultValue: 'full',
    input,
    output,
    env: { CI: 'false' }
  })

  const rendered = outputText().replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
  assert.match(rendered, /■ Full agent profiles\n│ {4}Copy complete Codex, Claude,/)
  assert.match(rendered, /\n│ {4}and ~\/\.agents profiles; may\n│ {4}include sensitive data\./)
  assert.doesNotMatch(rendered, /\nCopy complete|\nand ~\/\.agents|\ninclude sensitive/)
  input.write('\r')
  assert.deepStrictEqual(await resultPromise, { status: 'selected', value: 'full' })
})
```

- [ ] **Step 2: Run the focused tests and verify they fail for the new layout**

Run:

```bash
node --import tsx --test __tests__/app.test.ts --test-name-pattern='keeps a raw single-choice description inline|indents wrapped raw single-choice descriptions'
```

Expected: the wide test passes with the existing renderer; the narrow-layout
test fails because its description is emitted inline and terminal wrapping
returns to column zero.

- [ ] **Step 3: Implement pure width-aware select rendering helpers**

Near `formatChoiceLine`, add a dedicated formatter for raw single-choice
options. Build the styled option prefix with the existing `promptRail`,
`selectedMark`/`emptyMark`, and `formatPromptLabel` helpers. If the visible
length of `prefix + dim(' - description')` is at most `terminalColumns(output)`,
return that single line unchanged.

Otherwise return the option prefix followed by description lines that:

1. Begin with `promptRail()` and four plain spaces, aligning below the label.
2. Are wrapped by words to `terminalColumns(output) - visibleLength(indent)`.
3. Use `color(line, 'dim')` for every description line.
4. Preserve an overlong unbroken word as one line rather than dropping text.

Use the helper in `promptRawSelect` by replacing its direct
`options.choices.map(...)` with `flatMap(...)`. Do not change `formatChoiceLine`,
`promptRawMultiSelect`, `promptLineSelect`, or `promptLineMultiSelect`.

```ts
function wrapPromptDescription(description: string, maxWidth: number): string[] {
  const words = description === '' ? [''] : description.trim().split(/\s+/u)
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`
    if (line !== '' && visibleLength(next) > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }

  lines.push(line)
  return lines
}

function formatSelectChoiceLines<T extends string>(
  choice: SelectPromptChoice<T>,
  isFocused: boolean,
  output: PromptOutput
): string[] {
  const mark = isFocused ? selectedMark() : emptyMark(false)
  const prefix = `${promptRail()}  ${mark} ${formatPromptLabel(choice.label, isFocused)}`
  const inline = `${prefix}${color(` - ${choice.description}`, 'dim')}`
  if (visibleLength(inline) <= terminalColumns(output)) return [inline]

  const indent = `${promptRail()}    `
  const width = terminalColumns(output) - visibleLength(indent)
  return [
    prefix,
    ...wrapPromptDescription(choice.description, width).map(
      (line) => `${indent}${color(line, 'dim')}`
    )
  ]
}
```

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
node --import tsx --test __tests__/app.test.ts --test-name-pattern='keeps a raw single-choice description inline|indents wrapped raw single-choice descriptions'
```

Expected: PASS; the wide option retains ` - description` inline, and every
narrow description continuation begins with the prompt rail plus four spaces.

- [ ] **Step 5: Run prompt interaction regression tests**

Run:

```bash
node --import tsx --test __tests__/app.test.ts --test-name-pattern='single-choice prompt|redraws raw-mode long choices'
```

Expected: PASS; existing keyboard navigation, cancellation, line-mode fallback,
and redraw-row accounting continue to work.

- [ ] **Step 6: Lint and commit the implementation**

Run:

```bash
pnpm exec eslint src/interactive-prompts.ts __tests__/app.test.ts
git add src/interactive-prompts.ts __tests__/app.test.ts
git commit -m "fix: wrap single-choice prompt descriptions"
```

Expected: ESLint exits 0 and the commit includes only the renderer and its
tests.

## Final Verification

- [ ] Run `pnpm test`.
- [ ] Run `pnpm run lint`.
- [ ] Confirm `git status --short` is empty.
