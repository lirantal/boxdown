# Narrow-Terminal Setup Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Boxdown's styled interactive setup flow as explicit, rail-aware physical lines that remain readable in narrow terminals.

**Architecture:** Add a pure terminal-layout module for ANSI-safe width measurement, width fallback, word wrapping, hard token wrapping, and style-preserving segmented wrapping. Consume it from shared CLI styling, raw prompts, interactive progress, and the existing SSH result renderer; every dynamic renderer records the physical line count it actually emits.

**Tech Stack:** TypeScript, Node.js test runner, `tsx`, existing ANSI style primitives, ESLint, `tsc`, `tsdown`.

## Global Constraints

- Styled interactive setup output is in scope; numeric line-mode prompts, verbose output, detailed output, JSON output, non-interactive output, result summaries, prompt values, and input handling remain unchanged.
- Missing, non-integral, and non-positive terminal widths fall back to exactly 80 columns.
- ANSI control sequences do not count toward visible width.
- Long unbroken values are hard-wrapped without dropping text; available content width is clamped to at least one visible character.
- Existing focus, selection, colour, cancellation, raw-mode cleanup, progress state, and output-routing behavior must remain intact.
- Do not add a terminal-layout dependency.

---

## File Structure

- Create `src/terminal-layout.ts`: pure terminal width, measurement, plain wrapping, and style-preserving segmented wrapping.
- Create `__tests__/terminal-layout.test.ts`: focused unit coverage for the layout contract and edge cases.
- Modify `src/cli-style.ts`: shared width-aware prompt title/detail formatting.
- Modify `src/interactive-prompts.ts`: raw prompt choices, titles, skip labels, and redraw rows.
- Modify `src/progress.ts`: interactive progress wrapping and physical-row redraw tracking.
- Modify `src/ssh-install-result.ts`: consume shared measurement/plain wrapping without changing report output.
- Modify `__tests__/app.test.ts`: interaction-level prompt and progress regressions.
- Modify `__tests__/ssh-install-result.test.ts`: prove the shared helper refactor preserves narrow report behavior.
- Create `.changeset/narrow-terminal-layout.md`: document the patch-level user-visible fix.

### Task 1: Add pure terminal layout primitives

**Files:**
- Create: `src/terminal-layout.ts`
- Create: `__tests__/terminal-layout.test.ts`

**Interfaces:**
- Consumes: plain strings, optional terminal column counts, and `StyledTextSegment<T>` values.
- Produces: `visibleLength(value: string): number`, `terminalColumns(columns?: number): number`, `wrapText(value: string, firstWidth: number, continuationWidth?: number): string[]`, `wrapTextSegments<T>(segments: readonly StyledTextSegment<T>[], firstWidth: number, continuationWidth?: number): StyledTextSegment<T>[][]`, and `wrapWithPrefixes(value: string, firstPrefix: string, continuationPrefix: string, columns: number): string[]`.

- [ ] **Step 1: Write failing layout unit tests**

Create `__tests__/terminal-layout.test.ts` with direct assertions for ANSI width,
the 80-column fallback, word wrapping, hard wrapping, prefix-aware widths, and
style preservation:

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  terminalColumns,
  visibleLength,
  wrapText,
  wrapTextSegments,
  wrapWithPrefixes
} from '../src/terminal-layout.ts'

describe('terminal layout', () => {
  test('measures visible ANSI text and resolves terminal columns', () => {
    assert.strictEqual(visibleLength('\u001B[32mgreen\u001B[0m'), 5)
    assert.strictEqual(terminalColumns(42), 42)
    for (const value of [undefined, 0, -1, 3.5, Number.NaN]) {
      assert.strictEqual(terminalColumns(value), 80)
    }
  })

  test('wraps words and hard-wraps an overlong token without losing text', () => {
    assert.deepStrictEqual(wrapText('alpha beta gamma', 10), ['alpha beta', 'gamma'])
    const path = '/Users/demo/projects/a-very-long-workspace-name'
    const lines = wrapText(path, 12)
    assert.ok(lines.every((line) => visibleLength(line) <= 12))
    assert.strictEqual(lines.join(''), path)
    assert.deepStrictEqual(wrapText('abcd', 0), ['a', 'b', 'c', 'd'])
  })

  test('accounts for different first and continuation prefixes', () => {
    assert.deepStrictEqual(
      wrapWithPrefixes('alpha beta gamma delta', '◆  ', '│  ', 12),
      ['◆  alpha', '│  beta', '│  gamma', '│  delta']
    )
  })

  test('preserves styles across word and hard-wrap boundaries', () => {
    const lines = wrapTextSegments([
      { text: '(running)', style: 'green' },
      { text: ' /tmp/a-very-long-workspace', style: 'dim' }
    ], 12)
    assert.strictEqual(lines.flat().map((segment) => segment.text).join('').replaceAll(' ', ''), '(running)/tmp/a-very-long-workspace')
    assert.ok(lines.flat().some((segment) => segment.style === 'green'))
    assert.ok(lines.flat().some((segment) => segment.style === 'dim'))
    assert.ok(lines.every((line) => line.reduce((length, segment) => length + segment.text.length, 0) <= 12))
  })
})
```

- [ ] **Step 2: Run the unit test and verify RED**

Run:

```bash
node --import tsx --test __tests__/terminal-layout.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/terminal-layout.ts`.

- [ ] **Step 3: Implement the layout module**

Create `src/terminal-layout.ts`. Normalize whitespace to one visible space,
trim boundary whitespace, split at the last space that fits, hard-split at the
clamped width when no space fits, and coalesce adjacent output characters with
the same style:

```ts
const ansiPattern = /\u001B\[[0-?]*[ -/]*[@-~]/gu
const DEFAULT_TERMINAL_COLUMNS = 80

export interface StyledTextSegment<T> {
  text: string
  style: T
}

interface StyledCharacter<T> {
  text: string
  style: T
}

export function visibleLength (value: string): number {
  return Array.from(value.replace(ansiPattern, '')).length
}

export function terminalColumns (columns?: number): number {
  return Number.isInteger(columns) && columns !== undefined && columns > 0
    ? columns
    : DEFAULT_TERMINAL_COLUMNS
}

function normalizedCharacters<T> (segments: readonly StyledTextSegment<T>[]): StyledCharacter<T>[] {
  const characters: StyledCharacter<T>[] = []
  let whitespace = true
  for (const segment of segments) {
    for (const character of Array.from(segment.text)) {
      if (/\s/u.test(character)) {
        if (!whitespace) characters.push({ text: ' ', style: segment.style })
        whitespace = true
      } else {
        characters.push({ text: character, style: segment.style })
        whitespace = false
      }
    }
  }
  if (characters.at(-1)?.text === ' ') characters.pop()
  return characters
}

function coalesce<T> (characters: readonly StyledCharacter<T>[]): StyledTextSegment<T>[] {
  const segments: StyledTextSegment<T>[] = []
  for (const character of characters) {
    const previous = segments.at(-1)
    if (previous !== undefined && Object.is(previous.style, character.style)) {
      previous.text += character.text
    } else {
      segments.push({ ...character })
    }
  }
  return segments
}

export function wrapTextSegments<T> (
  segments: readonly StyledTextSegment<T>[],
  firstWidth: number,
  continuationWidth: number = firstWidth
): StyledTextSegment<T>[][] {
  let remaining = normalizedCharacters(segments)
  const lines: StyledTextSegment<T>[][] = []
  let width = Math.max(1, firstWidth)
  while (remaining.length > 0) {
    if (remaining.length <= width) {
      lines.push(coalesce(remaining))
      break
    }
    const candidate = remaining.slice(0, width + 1)
    const lastSpace = candidate.map((entry) => entry.text).lastIndexOf(' ')
    const splitAt = lastSpace > 0 && lastSpace <= width ? lastSpace : width
    lines.push(coalesce(remaining.slice(0, splitAt)))
    remaining = remaining.slice(splitAt)
    while (remaining[0]?.text === ' ') remaining.shift()
    width = Math.max(1, continuationWidth)
  }
  return lines
}

export function wrapText (value: string, firstWidth: number, continuationWidth: number = firstWidth): string[] {
  return wrapTextSegments([{ text: value, style: undefined }], firstWidth, continuationWidth)
    .map((line) => line.map((segment) => segment.text).join(''))
}

export function wrapWithPrefixes (
  value: string,
  firstPrefix: string,
  continuationPrefix: string,
  columns: number
): string[] {
  const lines = wrapText(
    value,
    Math.max(1, columns - visibleLength(firstPrefix)),
    Math.max(1, columns - visibleLength(continuationPrefix))
  )
  return lines.map((line, index) => `${index === 0 ? firstPrefix : continuationPrefix}${line}`)
}
```

- [ ] **Step 4: Run layout tests and lint**

Run:

```bash
node --import tsx --test __tests__/terminal-layout.test.ts
pnpm exec eslint src/terminal-layout.ts __tests__/terminal-layout.test.ts
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the pure layout unit**

```bash
git add src/terminal-layout.ts __tests__/terminal-layout.test.ts
git commit -m "feat: add terminal layout primitives"
```

### Task 2: Make raw prompts explicitly width-aware

**Files:**
- Modify: `src/cli-style.ts`
- Modify: `src/interactive-prompts.ts`
- Test: `__tests__/app.test.ts`

**Interfaces:**
- Consumes: Task 1's `terminalColumns`, `visibleLength`, `wrapTextSegments`, and `wrapWithPrefixes`.
- Produces: `formatPromptTitleLines(title: string, columns: number, enabled?: boolean): string[]`, `formatPromptDetailLines(detail: string, columns: number, enabled?: boolean): string[]`, and internal raw-prompt choice/skip formatters that return `string[]` physical lines.

- [ ] **Step 1: Add failing narrow raw-prompt tests**

Extend `__tests__/app.test.ts` beside the existing raw prompt tests. Strip ANSI
and carriage returns, then assert the exact hierarchy and width:

```ts
test('wraps narrow multi-select titles, descriptions, and skip labels under the prompt rail', async () => {
  const { input, output, outputText } = fakePromptStreams({ columns: 32 })
  const resultPromise = promptMultiSelect({
    title: 'Add this project to an AI coding app? (Select any)',
    choices: [{
      value: 'codex',
      label: 'ChatGPT app',
      description: 'Connect ChatGPT to this project.'
    }],
    skipLabel: 'Not now — Finish setup without adding the project to an app.',
    input,
    output,
    env: { CI: 'false' }
  })

  const rendered = outputText().replace(/\u001B\[[0-?]*[ -/]*[@-~]|\r/gu, '')
  assert.match(rendered, /◆  Add this project to an AI\n│  coding app\? \(Select any\)/)
  assert.match(rendered, /□ ChatGPT app\n│ {4}Connect ChatGPT to this\n│ {4}project\./)
  assert.match(rendered, /■ Not now — Finish setup\n│ {4}without adding the project/)
  for (const line of rendered.split('\n').filter(Boolean)) assert.ok(line.length <= 32, line)

  input.write('\r')
  assert.deepStrictEqual(await resultPromise, { status: 'skipped', values: [] })
})

test('hard-wraps a focused coloured multi-select path without losing its styles', async () => {
  const { input, output, outputText } = fakePromptStreams({ columns: 24 })
  const path = '/tmp/a-very-long-workspace-path'
  const resultPromise = promptMultiSelect({
    title: 'Purge workspaces?',
    choices: [{
      value: 'running',
      label: 'demo',
      description: `(running) ${path}`,
      focusedDescription: [
        { text: '(running)', color: 'green' },
        { text: ` ${path}`, color: 'dim' }
      ]
    }],
    skipLabel: 'Cancel',
    initialValues: ['running'],
    input,
    output,
    env: { CI: 'false' }
  })
  assert.match(outputText(), /\u001B\[32m\(running\)\u001B\[0m/)
  const rendered = outputText().replace(/\u001B\[[0-?]*[ -/]*[@-~]|\r|\n|│|\s/gu, '')
  assert.ok(rendered.includes(`◆Purgeworkspaces?■demo(running)${path}□Cancel└`))
  input.write('\r')
  assert.deepStrictEqual(await resultPromise, { status: 'selected', values: ['running'] })
})
```

Also strengthen the existing `redraws raw-mode long choices over wrapped
terminal rows` test to require the same physical row count on both redraws and
add a narrow single-select `NO_COLOR` assertion.

- [ ] **Step 2: Run the prompt tests and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern='wraps narrow multi-select|hard-wraps a focused|redraws raw-mode long choices|NO_COLOR' __tests__/app.test.ts
```

Expected: the new hierarchy and maximum-width assertions fail because raw
multi-select rows and titles are still handed to the terminal as long logical
lines.

- [ ] **Step 3: Add shared prompt title/detail line formatters**

In `src/cli-style.ts`, import `wrapWithPrefixes` and add:

```ts
export function formatPromptTitleLines (title: string, columns: number, enabled = true): string[] {
  const firstPrefix = `${maybeColor('◆', 'cyan', enabled)}  `
  const continuationPrefix = `${promptRail(enabled)}  `
  return wrapWithPrefixes(title, firstPrefix, continuationPrefix, columns)
    .map((line) => {
      const prefix = line.startsWith(firstPrefix) ? firstPrefix : continuationPrefix
      return `${prefix}${maybeColor(line.slice(prefix.length), 'bold', enabled)}`
    })
}

export function formatPromptDetailLines (detail: string, columns: number, enabled = true): string[] {
  const prefix = `${promptRail(enabled)}  `
  return wrapWithPrefixes(detail, prefix, prefix, columns)
    .map((line) => `${prefix}${maybeColor(line.slice(prefix.length), 'dim', enabled)}`)
}
```

Preserve `formatPromptTitle` and `formatPromptDetailLine` as their existing
single-line public APIs for log-oriented callers and compatibility tests.

- [ ] **Step 4: Replace raw prompt logical rows with physical-line formatters**

In `src/interactive-prompts.ts`:

1. Remove the local ANSI pattern, `visibleLength`, `terminalColumns`, and
   `wrapPromptDescription`; import the Task 1 functions instead.
2. Thread `colorEnabled` through raw single-select resolution so `NO_COLOR`
   affects single- and multi-select prompts consistently.
3. Replace `formatChoiceLine`, `formatSelectChoiceLines`, and `formatSkipLine`
   with physical-line helpers. Build label lines with the first prefix
   `${promptRail}  ${mark} ` and continuation prefix `${promptRail}    `.
4. Keep the complete compact row only when its visible length is no greater
   than the resolved columns. Otherwise render label lines followed by wrapped
   description segments under `${promptRail}    `.
5. For focused descriptions, call `wrapTextSegments` with
   `focusedDescription`; for other descriptions, use one dim segment. Render
   each returned segment with `maybeColor(segment.text, segment.style,
   colorEnabled)`.
6. Use `formatPromptTitleLines` and `flatMap` in both raw prompt `lines()`
   functions. Keep `renderPromptLines` as the sole redraw counter.

The formatter skeleton is:

```ts
function formatMultiSelectChoiceLines<T extends string> (
  choice: MultiSelectChoice<T>,
  isFocused: boolean,
  isSelected: boolean,
  output: PromptOutput,
  colorEnabled: boolean
): string[] {
  const columns = terminalColumns(output.columns)
  const mark = isSelected ? selectedMark(colorEnabled) : emptyMark(isFocused, colorEnabled)
  const firstPrefix = `${promptRail(colorEnabled)}  ${mark} `
  const continuationPrefix = `${promptRail(colorEnabled)}    `
  const description = isFocused && choice.focusedDescription !== undefined
    ? choice.focusedDescription
    : [{ text: choice.description, color: 'dim' as const }]
  // Return the compact styled row when it fits. Otherwise wrap the label and
  // description separately using wrapWithPrefixes/wrapTextSegments.
}
```

- [ ] **Step 5: Run prompt tests and interaction regressions**

Run:

```bash
node --import tsx --test --test-name-pattern='single-choice prompt|interactive install target prompt|setup toolchain selection' __tests__/app.test.ts
pnpm exec eslint src/cli-style.ts src/interactive-prompts.ts __tests__/app.test.ts
```

Expected: all selected tests and ESLint pass. Confirm that the narrow rendered
lines are at most the configured width and raw selections still resolve to the
same values.

- [ ] **Step 6: Commit width-aware prompts**

```bash
git add src/cli-style.ts src/interactive-prompts.ts __tests__/app.test.ts
git commit -m "fix: wrap interactive prompts in narrow terminals"
```

### Task 3: Wrap interactive progress and track physical redraw rows

**Files:**
- Modify: `src/progress.ts`
- Test: `__tests__/app.test.ts`

**Interfaces:**
- Consumes: Task 1 layout functions and Task 2's `formatPromptTitleLines`/`formatPromptDetailLines`.
- Produces: `ProgressReporterOptions.columns?: number`; internal `#formatStepLines(step): string[]`; wrapped interactive item/detail/status/warn/spinner/checklist rendering whose counters store physical rows.

- [ ] **Step 1: Add failing progress layout tests**

Add focused tests beside `formats styled progress sections`:

```ts
test('wraps interactive progress details and hard-wraps workspace paths under the rail', () => {
  const lines: string[] = []
  const progress = createProgress({
    mode: 'interactive',
    columns: 24,
    color: false,
    write: (_target, message) => lines.push(message)
  })
  const path = '/Users/demo/projects/a-very-long-workspace'
  progress.section('Boxdown setup with a long title')
  progress.detail(`Workspace: ${path}`)
  progress.item('Writing generated devcontainer configuration')
  progress.end()

  assert.ok(lines.every((line) => line.length <= 24, line))
  assert.ok(lines.filter((line) => line.startsWith('│  ')).length > 3)
  assert.strictEqual(lines.join('').replace(/[◆│└\s]/gu, '').includes(path), true)
})

test('redraws wrapped checklist steps using their physical row count', () => {
  const raw: string[] = []
  const progress = createProgress({
    mode: 'interactive',
    columns: 24,
    isTTY: true,
    color: false,
    spinnerIntervalMs: 60_000,
    writeRaw: (_target, message) => raw.push(message)
  })
  progress.setSteps([
    { id: 'one', label: 'Writing generated devcontainer configuration' },
    { id: 'two', label: 'Configuring SSH alias' }
  ])
  progress.startStep('one')
  const cursorUps = raw.join('').match(/\u001B\[(\d+)A/gu) ?? []
  assert.ok(cursorUps.some((entry) => Number(entry.match(/\d+/u)?.[0]) > 2))
  progress.completeStep('one')
  progress.end()
})

test('clears and redraws every row of a wrapped spinner', () => {
  const raw: string[] = []
  const progress = createProgress({
    mode: 'interactive', columns: 20, isTTY: true, color: false,
    spinnerFrames: ['x'], spinnerIntervalMs: 60_000,
    writeRaw: (_target, message) => raw.push(message)
  })
  progress.startSpinner('Starting a deliberately long operation')
  progress.tickSpinner()
  progress.stopSpinner()
  assert.ok(raw.join('').includes('\u001B[1A'))
})
```

- [ ] **Step 2: Run progress tests and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern='wraps interactive progress|redraws wrapped checklist|wrapped spinner' __tests__/app.test.ts
```

Expected: the maximum-width, physical checklist count, and multi-line spinner
assertions fail because progress currently emits one logical line per item.

- [ ] **Step 3: Add progress width resolution and static wrapping**

In `src/progress.ts`:

- add `columns?: number` to `ProgressReporterOptions`;
- resolve `#columns` from `options.columns`, otherwise the selected process
  stream's `columns`, through `terminalColumns`;
- add `#writeLines(lines)` and `#writeInteractiveLines(lines)` helpers;
- use `formatPromptTitleLines` for interactive sections;
- use `formatPromptDetailLines` for interactive details;
- wrap item, status, warning, and non-TTY spinner messages using
  `wrapWithPrefixes`, applying their current colour per physical content line;
- do not change detailed, verbose, none, or `appendResult` contracts.

`#writeInteractiveLines` must move above an active checklist once, emit every
physical line, reset `#renderedStepLineCount`, and then call
`#renderChecklist()`.

- [ ] **Step 4: Make checklist and spinner redraws physical-line aware**

Change checklist rendering to:

```ts
const lines = this.#steps.flatMap((step) => this.#formatStepLines(step))
```

and retain `this.#renderedStepLineCount = lines.length` after emitting them.
`#formatStepLines` uses the current state mark on its first line and a rail plus
four spaces on continuations.

Add `renderedRows: number` to `ActiveSpinner`. Render all but the final spinner
line with a newline and leave the cursor on the final line. Before each redraw
or clear, erase the final row, then move up and erase each preceding row. Set
`renderedRows` to the newly formatted line count after every render.

- [ ] **Step 5: Run progress tests and regression groups**

Run:

```bash
node --import tsx --test --test-name-pattern='progress|setup preflight|setup reports|remote access' __tests__/app.test.ts
pnpm exec eslint src/progress.ts __tests__/app.test.ts
```

Expected: all matching tests and ESLint pass. Update existing exact arrays only
where an interactive message now intentionally occupies multiple physical
lines; detailed/verbose arrays must remain byte-for-byte unchanged.

- [ ] **Step 6: Commit responsive progress**

```bash
git add src/progress.ts __tests__/app.test.ts
git commit -m "fix: wrap interactive progress in narrow terminals"
```

### Task 4: Share layout behavior with SSH results and document the fix

**Files:**
- Modify: `src/ssh-install-result.ts`
- Test: `__tests__/ssh-install-result.test.ts`
- Create: `.changeset/narrow-terminal-layout.md`

**Interfaces:**
- Consumes: Task 1's `visibleLength` and `wrapWithPrefixes`.
- Produces: unchanged `formatRemoteAccessInstallReport`, `writeRemoteAccessInstallReport`, and `ProgressReporter.appendResult` behavior.

- [ ] **Step 1: Strengthen the narrow report regression test**

In the existing 32-column interactive report test, assert every non-empty
plain line fits the configured width and long notice text is retained:

```ts
const plain = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
for (const line of plain.trimEnd().split('\n')) assert.ok(line.length <= 32, line)
assert.match(plain.replace(/\s/gu, ''), /Nooptionalappintegrationswereselected/)
```

- [ ] **Step 2: Run the report regression before refactoring**

Run:

```bash
node --import tsx --test --test-name-pattern='wraps.*32|optional app integrations' __tests__/ssh-install-result.test.ts
```

Expected: PASS, establishing behavior-preserving refactor coverage.

- [ ] **Step 3: Replace duplicated layout helpers**

Import `visibleLength` and `wrapWithPrefixes` from `terminal-layout.ts`; remove
the local implementations from `ssh-install-result.ts`. Keep
`indentedProse`, `actionLines`, `detailLines`, and `statusLines` as semantic
report helpers that delegate to the shared primitive.

- [ ] **Step 4: Add the patch changeset**

Create `.changeset/narrow-terminal-layout.md`:

```md
---
"boxdown": patch
---

Keep interactive setup prompts and progress output readable in narrow terminals.
```

- [ ] **Step 5: Run report tests and lint**

Run:

```bash
node --import tsx --test __tests__/ssh-install-result.test.ts
pnpm exec eslint src/ssh-install-result.ts __tests__/ssh-install-result.test.ts
```

Expected: both commands exit 0 and report snapshots/strings remain unchanged.

- [ ] **Step 6: Commit the shared renderer and release note**

```bash
git add src/ssh-install-result.ts __tests__/ssh-install-result.test.ts .changeset/narrow-terminal-layout.md
git commit -m "refactor: share terminal wrapping behavior"
```

### Task 5: Verify the complete UX sweep

**Files:**
- Verify all files changed in Tasks 1-4.

**Interfaces:**
- Consumes: the completed responsive prompt, progress, and report renderers.
- Produces: fresh verification evidence and a final scope review.

- [ ] **Step 1: Run the complete automated suite**

```bash
pnpm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run lint and build**

```bash
pnpm run lint
pnpm run build
```

Expected: both commands exit 0 with no errors.

- [ ] **Step 3: Run whitespace and scope checks**

```bash
git diff --check HEAD~4..HEAD
git status --short
git diff --stat HEAD~4..HEAD
```

Expected: no whitespace errors; status lists only pre-existing unrelated
untracked paths, if any; the implementation diff is limited to the files named
in this plan.

- [ ] **Step 4: Review the original screenshot requirements**

Confirm from focused test output that:

- workspace-toolchain descriptions never resume at column zero;
- app-target descriptions and the long "Not now" label retain the prompt rail;
- workspace paths and ownership details hard-wrap beneath their progress rail;
- all raw-prompt and progress redraw counters use physical rows; and
- wide terminals retain compact option rows.
