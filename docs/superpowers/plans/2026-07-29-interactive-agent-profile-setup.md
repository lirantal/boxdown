# Interactive Agent Profile Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a conditional single-choice agent-profile prompt to interactive `boxdown setup` after at least one Codex or Claude app target is resolved.

**Architecture:** Add a generic `promptSelect<T>` primitive beside Boxdown's existing prompt primitives, then isolate setup-specific eligibility and fallback rules in `src/setup-agent-profile.ts`. `src/main.ts` will call that resolver after target resolution and before metadata writes, while all existing profile persistence, generated-config, status, and lifecycle code remains unchanged.

**Tech Stack:** TypeScript ESM, Node.js 24 streams and test runner, pnpm 11, ESLint, Markdownlint, Changesets.

## Global Constraints

- The public profile values remain exactly `none`, `auth`, and `full`.
- Resolution precedence remains explicit `--agent-profile`, then workspace metadata, then `auth`.
- The profile prompt appears only in `boxdown setup`, only after one or more final app targets exist, only without an explicit profile, and only interactively.
- Explicit `--target codex` or `--target claude` still qualifies for an interactive profile prompt.
- No selected app targets retain recorded metadata, or `auth` when no profile is recorded, without prompting.
- Non-interactive setup never renders or reads the profile prompt.
- The current resolved profile, including recorded `none` or `full`, is the prompt default.
- Cancelling either setup prompt occurs before metadata, generated config, container, SSH alias, or app-integration mutations.
- App targets and agent profiles remain separate: `none` with a selected app target is valid.
- Profiles remain container-wide and are not filtered by selected app targets.
- `boxdown ssh install` and every non-setup command retain their current behavior.
- Do not add a global preference, environment override, project setting, metadata version, or public `interactive` selection source.
- Do not change profile contents, staging, copy isolation, status semantics, or recreation behavior.
- New code follows the repository's no-semicolon StandardJS style and introduces no runtime dependency.

---

### Task 1: Generic Single-choice Prompt

**Files:**

- Modify: `src/interactive-prompts.ts:10-685`
- Test: `__tests__/app.test.ts:9-35`
- Test: `__tests__/app.test.ts:1028-1370`

**Interfaces:**

- Consumes: existing `PromptInput`, `PromptOutput`, `canPromptInteractively`, terminal rendering helpers, and `askLine`.
- Produces:

```ts
export interface SelectPromptChoice<T extends string> {
  value: T
  label: string
  description: string
}

export type SelectPromptResult<T extends string> =
  | { status: 'selected', value: T }
  | { status: 'cancelled' }
  | { status: 'non-interactive' }

export interface SelectPromptOptions<T extends string> {
  title: string
  choices: readonly SelectPromptChoice<T>[]
  defaultValue: T
  summaryLabel?: string
  input?: PromptInput
  output?: PromptOutput
  env?: NodeJS.ProcessEnv
}

export async function promptSelect<T extends string>(
  options: SelectPromptOptions<T>
): Promise<SelectPromptResult<T>>
```

- Invariant: `defaultValue` must match one choice. For an invalid `other`
  value, throw `Select prompt default is not one of its choices: other` before
  reading input or rendering.

- [ ] **Step 1: Import `promptSelect` in the prompt test module**

Change the existing import from `src/interactive-prompts.ts` to include
`promptSelect`:

```ts
import {
  promptConfirm,
  promptMultiSelect,
  promptSelect,
  promptText,
  type PromptInput,
  type PromptOutput
} from '../src/interactive-prompts.ts'
```

- [ ] **Step 2: Write failing raw-mode selector tests**

Add a nested `describe('single-choice prompt', ...)` under the existing
interactive prompt tests. Use this stable fixture:

```ts
const profilePromptChoices = [
  { value: 'none', label: 'No agent profile', description: 'Copy no host user-scoped agent data.' },
  { value: 'auth', label: 'Authentication and ~/.agents', description: 'Copy agent authentication and ~/.agents; Boxdown default.' },
  { value: 'full', label: 'Full agent profiles', description: 'Copy complete Codex, Claude, and ~/.agents profiles; may include sensitive data.' }
] as const
```

Cover default selection, movement, wrapping, and all raw cancellation keys:

```ts
test('selects the current single-choice default with Enter', async () => {
  const { input, output, outputText } = fakePromptStreams()
  const resultPromise = promptSelect({
    title: 'How much host agent data should Boxdown copy into the container?',
    choices: profilePromptChoices,
    defaultValue: 'auth',
    summaryLabel: 'Agent profile',
    input,
    output,
    env: { CI: 'false' }
  })

  input.write('\r')

  assert.deepStrictEqual(await resultPromise, { status: 'selected', value: 'auth' })
  assert.match(outputText(), /Agent profile: Authentication and ~\/\.agents/)
})

test('moves and wraps a raw single-choice prompt', async () => {
  for (const entry of [
    { keys: '\u001B[B\r', expected: 'full' },
    { keys: 'j\r', expected: 'full' },
    { keys: '\u001B[A\r', expected: 'none' },
    { keys: 'k\r', expected: 'none' },
    { keys: '\u001B[B\u001B[B\r', expected: 'none' }
  ] as const) {
    const { input, output } = fakePromptStreams()
    const resultPromise = promptSelect({
      title: 'Agent profile?',
      choices: profilePromptChoices,
      defaultValue: 'auth',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write(entry.keys)
    assert.deepStrictEqual(await resultPromise, {
      status: 'selected',
      value: entry.expected
    })
  }
})

test('cancels a raw single-choice prompt and restores terminal state', async () => {
  for (const key of ['\u001B', '\u0003', '\u0004']) {
    const rawModes: boolean[] = []
    const { input, output, outputText } = fakePromptStreams()
    input.setRawMode = (mode) => {
      rawModes.push(mode)
    }
    const resultPromise = promptSelect({
      title: 'Agent profile?',
      choices: profilePromptChoices,
      defaultValue: 'auth',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write(key)
    assert.deepStrictEqual(await resultPromise, { status: 'cancelled' })
    assert.deepStrictEqual(rawModes, [true, false])
    assert.match(outputText(), /\u001B\[\?25l/)
    assert.match(outputText(), /\u001B\[\?25h/)
  }
})

test('restores terminal state before raw-mode failure falls back to line mode', async () => {
  const { input, output, outputText } = fakePromptStreams()
  input.setRawMode = (mode) => {
    if (mode) throw new Error('raw mode unavailable')
  }
  const resultPromise = promptSelect({
    title: 'Agent profile?',
    choices: profilePromptChoices,
    defaultValue: 'auth',
    input,
    output,
    env: { CI: 'false' }
  })

  await waitForPromptOutput(outputText, /1\) No agent profile/)
  input.write('\n')

  assert.deepStrictEqual(await resultPromise, { status: 'selected', value: 'auth' })
  assert.match(outputText(), /\u001B\[\?25l/)
  assert.match(outputText(), /\u001B\[\?25h/)
})
```

- [ ] **Step 3: Write failing line-mode, validation, and non-interactive tests**

```ts
test('selects by number, value, and blank default in line mode', async () => {
  for (const entry of [
    { answer: '3\n', expected: 'full' },
    { answer: 'none\n', expected: 'none' },
    { answer: '\n', expected: 'auth' }
  ] as const) {
    const { input, output } = fakePromptStreams({ rawMode: false })
    const resultPromise = promptSelect({
      title: 'Agent profile?',
      choices: profilePromptChoices,
      defaultValue: 'auth',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write(entry.answer)
    assert.deepStrictEqual(await resultPromise, {
      status: 'selected',
      value: entry.expected
    })
  }
})

test('retries invalid line input and cancels on EOF', async () => {
  const retry = fakePromptStreams({ rawMode: false })
  const retryPromise = promptSelect({
    title: 'Agent profile?',
    choices: profilePromptChoices,
    defaultValue: 'auth',
    input: retry.input,
    output: retry.output,
    env: { CI: 'false' }
  })
  retry.input.write('other\nfull\n')
  assert.deepStrictEqual(await retryPromise, { status: 'selected', value: 'full' })
  assert.match(retry.outputText(), /Unknown selection: other/)

  const eof = fakePromptStreams({ rawMode: false })
  const eofPromise = promptSelect({
    title: 'Agent profile?',
    choices: profilePromptChoices,
    defaultValue: 'auth',
    input: eof.input,
    output: eof.output,
    env: { CI: 'false' }
  })
  eof.input.end()
  assert.deepStrictEqual(await eofPromise, { status: 'cancelled' })
})

test('is silent when single-choice prompting is unavailable', async () => {
  const input = new PassThrough() as PassThrough & PromptInput
  const output = new PassThrough() as PassThrough & PromptOutput
  const outputChunks: Buffer[] = []
  input.isTTY = false
  output.isTTY = false
  output.on('data', (chunk: Buffer) => outputChunks.push(chunk))

  assert.deepStrictEqual(await promptSelect({
    title: 'Agent profile?',
    choices: profilePromptChoices,
    defaultValue: 'auth',
    input,
    output,
    env: { CI: 'false' }
  }), { status: 'non-interactive' })
  assert.strictEqual(Buffer.concat(outputChunks).toString('utf8'), '')
})

test('rejects a default that is not a choice', async () => {
  await assert.rejects(promptSelect({
    title: 'Agent profile?',
    choices: profilePromptChoices,
    defaultValue: 'other',
    env: { CI: '1' }
  }), /Select prompt default is not one of its choices: other/)
})
```

- [ ] **Step 4: Run the focused tests and confirm RED**

Run:

```sh
node --import tsx --test \
  --test-name-pattern='single-choice prompt|single-choice prompting|default that is not a choice' \
  __tests__/app.test.ts
```

Expected: TypeScript/module loading fails because `promptSelect` is not
exported.

- [ ] **Step 5: Add selector types and formatting helpers**

In `src/interactive-prompts.ts`, add the interfaces from the task's
**Interfaces** block after `MultiSelectPromptOptions`. Add:

```ts
function formatSelectFinalLine<T extends string>(
  result: SelectPromptResult<T>,
  choices: readonly SelectPromptChoice<T>[],
  summaryLabel: string
): string {
  if (result.status === 'cancelled') return `${summaryLabel}: canceled`
  if (result.status === 'non-interactive') return `${summaryLabel}: skipped`

  const label = choices.find((choice) => choice.value === result.value)?.label
  return `${summaryLabel}: ${label ?? result.value}`
}

function parseLineSelect<T extends string>(
  answer: string,
  choices: readonly SelectPromptChoice<T>[],
  defaultValue: T
): { value: T } | { error: string } {
  const trimmed = answer.trim()
  if (trimmed === '') return { value: defaultValue }

  const byNumber = /^[0-9]+$/u.test(trimmed) ? Number(trimmed) : undefined
  const choice = byNumber === undefined
    ? choices.find((candidate) => candidate.value === trimmed)
    : choices[byNumber - 1]

  return choice === undefined
    ? { error: `Unknown selection: ${trimmed}` }
    : { value: choice.value }
}
```

- [ ] **Step 6: Implement line-mode selection**

Add before `promptLineMultiSelect`:

```ts
async function promptLineSelect<T extends string>(
  options: Required<Pick<SelectPromptOptions<T>,
  'title' | 'choices' | 'defaultValue' | 'summaryLabel' | 'input' | 'output'>>
): Promise<SelectPromptResult<T>> {
  options.output.write(`${formatPromptTitle(options.title)}\n`)
  options.choices.forEach((choice, index) => {
    const current = choice.value === options.defaultValue ? ' (current)' : ''
    options.output.write(
      `${promptRail()}  ${index + 1}) ${choice.label}${current} - ${choice.description}\n`
    )
  })

  while (true) {
    const answer = await askLine(options.input, options.output, `${promptRail()}  `)
    if (answer === undefined) return { status: 'cancelled' }

    const parsed = parseLineSelect(answer, options.choices, options.defaultValue)
    if ('value' in parsed) {
      const result = { status: 'selected', value: parsed.value } as const
      options.output.write(
        `${formatPromptEnd()}\n${formatSelectFinalLine(result, options.choices, options.summaryLabel)}\n`
      )
      return result
    }

    options.output.write(`${promptRail()}  ${parsed.error}\n`)
  }
}
```

- [ ] **Step 7: Implement raw-mode selection**

Add before `promptRawMultiSelect`:

```ts
function promptRawSelect<T extends string>(
  options: Required<Pick<SelectPromptOptions<T>,
  'title' | 'choices' | 'defaultValue' | 'summaryLabel' | 'input' | 'output'>>
): Promise<SelectPromptResult<T>> {
  return new Promise((resolve) => {
    let focusedIndex = options.choices.findIndex(
      (choice) => choice.value === options.defaultValue
    )
    let settled = false
    let renderedRows = 0

    function lines(): string[] {
      return [
        formatPromptTitle(options.title),
        promptRail(),
        ...options.choices.map((choice, index) => formatChoiceLine(
          choice,
          focusedIndex === index,
          focusedIndex === index
        )),
        formatPromptEnd()
      ]
    }

    function render(): void {
      renderedRows = renderPromptLines(options.output, lines(), renderedRows)
    }

    function cleanup(): void {
      options.input.removeListener('data', onData)
      try {
        options.input.setRawMode?.(false)
      } catch {
        // Continue restoring the remaining terminal state.
      }
      options.input.pause()
      options.output.write('\u001B[?25h')
    }

    function finish(result: SelectPromptResult<T>): void {
      if (settled) return
      settled = true
      cleanup()
      options.output.write(
        `${formatSelectFinalLine(result, options.choices, options.summaryLabel)}\n`
      )
      resolve(result)
    }

    function moveFocus(direction: 1 | -1): void {
      focusedIndex = (
        focusedIndex + direction + options.choices.length
      ) % options.choices.length
      render()
    }

    function handleKey(key: string): void {
      if (key === '\u0003' || key === '\u0004' || key === '\u001B') {
        finish({ status: 'cancelled' })
      } else if (key === '\r' || key === '\n') {
        const choice = options.choices[focusedIndex]
        if (choice !== undefined) {
          finish({ status: 'selected', value: choice.value })
        }
      } else if (key === 'k') {
        moveFocus(-1)
      } else if (key === 'j') {
        moveFocus(1)
      }
    }

    function handleText(text: string): void {
      for (let index = 0; index < text.length;) {
        if (text.startsWith('\u001B[A', index)) {
          moveFocus(-1)
          index += 3
        } else if (text.startsWith('\u001B[B', index)) {
          moveFocus(1)
          index += 3
        } else {
          handleKey(text[index] ?? '')
          index += 1
        }
      }
    }

    function onData(chunk: string | Buffer): void {
      handleText(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    }

    try {
      options.output.write('\u001B[?25l')
      options.input.setRawMode?.(true)
      options.input.resume()
      options.input.on('data', onData)
      render()
    } catch (error) {
      cleanup()
      throw error
    }
  })
}
```

- [ ] **Step 8: Export the selector entry point**

Add before `promptMultiSelect`:

```ts
export async function promptSelect<T extends string>(
  options: SelectPromptOptions<T>
): Promise<SelectPromptResult<T>> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const env = options.env ?? process.env
  const summaryLabel = options.summaryLabel ?? 'Selection'

  if (!options.choices.some((choice) => choice.value === options.defaultValue)) {
    throw new Error(
      `Select prompt default is not one of its choices: ${options.defaultValue}`
    )
  }

  if (!canPromptInteractively(input, output, env)) {
    return { status: 'non-interactive' }
  }

  const resolved = {
    title: options.title,
    choices: options.choices,
    defaultValue: options.defaultValue,
    summaryLabel,
    input,
    output
  }

  if (typeof input.setRawMode !== 'function') {
    return promptLineSelect(resolved)
  }

  try {
    return await promptRawSelect(resolved)
  } catch {
    return promptLineSelect(resolved)
  }
}
```

- [ ] **Step 9: Run focused and full prompt tests and confirm GREEN**

Run:

```sh
node --import tsx --test \
  --test-name-pattern='interactive install target prompt' \
  __tests__/app.test.ts
```

Expected: every test in the prompt describe block passes with zero failures.

Then run:

```sh
pnpm exec eslint src/interactive-prompts.ts __tests__/app.test.ts
```

Expected: exit code `0`.

- [ ] **Step 10: Commit Task 1**

```sh
git add src/interactive-prompts.ts __tests__/app.test.ts
git commit -m "feat: add interactive single-choice prompt"
```

---

### Task 2: Setup Agent-profile Resolver

**Files:**

- Create: `src/setup-agent-profile.ts`
- Create: `__tests__/setup-agent-profile.test.ts`

**Interfaces:**

- Consumes: `resolveAgentProfile`, `AgentProfile`, `promptSelect`,
  `PromptInput`, `PromptOutput`, and `SshConfigInstallTarget`.
- Produces:

```ts
export type SetupAgentProfileResult =
  | { cancelled: false, profile: AgentProfile }
  | { cancelled: true }

export interface ResolveSetupAgentProfileOptions {
  explicitProfile?: AgentProfile
  recordedProfile?: AgentProfile
  targets: readonly SshConfigInstallTarget[]
  input?: PromptInput
  output?: PromptOutput
  env?: NodeJS.ProcessEnv
}

export async function resolveSetupAgentProfile(
  options: ResolveSetupAgentProfileOptions
): Promise<SetupAgentProfileResult>
```

- [ ] **Step 1: Write failing resolver matrix tests**

Create `__tests__/setup-agent-profile.test.ts` with Node test imports,
`PassThrough`, and a local line-mode prompt-stream helper. Add:

```ts
import assert from 'node:assert'
import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'

import type { PromptInput, PromptOutput } from '../src/interactive-prompts.ts'
import { resolveSetupAgentProfile } from '../src/setup-agent-profile.ts'

function linePromptStreams(): {
  input: PassThrough & PromptInput
  output: PassThrough & PromptOutput
  outputText: () => string
} {
  const input = new PassThrough() as PassThrough & PromptInput
  const output = new PassThrough() as PassThrough & PromptOutput
  const chunks: Buffer[] = []
  input.isTTY = true
  output.isTTY = true
  output.on('data', (chunk: Buffer) => chunks.push(chunk))
  return { input, output, outputText: () => Buffer.concat(chunks).toString('utf8') }
}

describe('setup agent profile resolution', () => {
  test('uses explicit profile without prompting', async () => {
    const streams = linePromptStreams()
    assert.deepStrictEqual(await resolveSetupAgentProfile({
      explicitProfile: 'none',
      recordedProfile: 'full',
      targets: ['codex'],
      input: streams.input,
      output: streams.output,
      env: { CI: 'false' }
    }), { cancelled: false, profile: 'none' })
    assert.strictEqual(streams.outputText(), '')
  })

  test('uses recorded or default profile when no targets are selected', async () => {
    assert.deepStrictEqual(await resolveSetupAgentProfile({
      recordedProfile: 'full',
      targets: [],
      env: { CI: '1' }
    }), { cancelled: false, profile: 'full' })
    assert.deepStrictEqual(await resolveSetupAgentProfile({
      targets: [],
      env: { CI: '1' }
    }), { cancelled: false, profile: 'auth' })
  })

  test('uses recorded or default profile non-interactively with targets', async () => {
    assert.deepStrictEqual(await resolveSetupAgentProfile({
      recordedProfile: 'none',
      targets: ['claude'],
      env: { CI: '1' }
    }), { cancelled: false, profile: 'none' })
    assert.deepStrictEqual(await resolveSetupAgentProfile({
      targets: ['codex'],
      env: { CI: '1' }
    }), { cancelled: false, profile: 'auth' })
  })
})
```

- [ ] **Step 2: Write failing prompt, default, copy, and cancellation tests**

Add within the same describe block:

```ts
test('prompts for a profile when final targets exist', async () => {
  const streams = linePromptStreams()
  const resultPromise = resolveSetupAgentProfile({
    targets: ['codex'],
    input: streams.input,
    output: streams.output,
    env: { CI: 'false' }
  })
  streams.input.write('3\n')

  assert.deepStrictEqual(await resultPromise, { cancelled: false, profile: 'full' })
  assert.match(streams.outputText(), /How much host agent data should Boxdown copy/)
  assert.match(streams.outputText(), /Authentication and ~\/\.agents/)
  assert.match(streams.outputText(), /may include sensitive data/)
})

test('defaults the prompt to the recorded profile', async () => {
  const streams = linePromptStreams()
  const resultPromise = resolveSetupAgentProfile({
    recordedProfile: 'full',
    targets: ['claude'],
    input: streams.input,
    output: streams.output,
    env: { CI: 'false' }
  })
  streams.input.write('\n')

  assert.deepStrictEqual(await resultPromise, { cancelled: false, profile: 'full' })
})

test('treats targets as an eligibility gate, not a copy filter', async () => {
  const streams = linePromptStreams()
  const resultPromise = resolveSetupAgentProfile({
    targets: ['codex'],
    input: streams.input,
    output: streams.output,
    env: { CI: 'false' }
  })
  streams.input.write('full\n')

  assert.deepStrictEqual(await resultPromise, { cancelled: false, profile: 'full' })
})

test('returns cancellation without a profile', async () => {
  const streams = linePromptStreams()
  const resultPromise = resolveSetupAgentProfile({
    targets: ['codex'],
    input: streams.input,
    output: streams.output,
    env: { CI: 'false' }
  })
  streams.input.end()

  assert.deepStrictEqual(await resultPromise, { cancelled: true })
})
```

- [ ] **Step 3: Run the resolver tests and confirm RED**

Run:

```sh
node --import tsx --test __tests__/setup-agent-profile.test.ts
```

Expected: module loading fails because `src/setup-agent-profile.ts` does not
exist.

- [ ] **Step 4: Implement the resolver and fixed prompt copy**

Create `src/setup-agent-profile.ts`:

```ts
import { resolveAgentProfile, type AgentProfile } from './agent-profile.ts'
import {
  promptSelect,
  type PromptInput,
  type PromptOutput,
  type SelectPromptChoice
} from './interactive-prompts.ts'
import type { SshConfigInstallTarget } from './ssh-install-targets.ts'

const setupAgentProfileChoices: readonly SelectPromptChoice<AgentProfile>[] = [
  {
    value: 'none',
    label: 'No agent profile',
    description: 'Copy no host user-scoped agent data.'
  },
  {
    value: 'auth',
    label: 'Authentication and ~/.agents',
    description: 'Copy agent authentication and ~/.agents; Boxdown default.'
  },
  {
    value: 'full',
    label: 'Full agent profiles',
    description: 'Copy complete Codex, Claude, and ~/.agents profiles; may include sensitive data.'
  }
]

export type SetupAgentProfileResult =
  | { cancelled: false, profile: AgentProfile }
  | { cancelled: true }

export interface ResolveSetupAgentProfileOptions {
  explicitProfile?: AgentProfile
  recordedProfile?: AgentProfile
  targets: readonly SshConfigInstallTarget[]
  input?: PromptInput
  output?: PromptOutput
  env?: NodeJS.ProcessEnv
}

export async function resolveSetupAgentProfile(
  options: ResolveSetupAgentProfileOptions
): Promise<SetupAgentProfileResult> {
  const current = resolveAgentProfile(
    options.explicitProfile,
    options.recordedProfile
  ).value

  if (options.explicitProfile !== undefined || options.targets.length === 0) {
    return { cancelled: false, profile: current }
  }

  const result = await promptSelect({
    title: 'How much host agent data should Boxdown copy into the container?',
    choices: setupAgentProfileChoices,
    defaultValue: current,
    summaryLabel: 'Agent profile',
    input: options.input,
    output: options.output,
    env: options.env
  })

  if (result.status === 'cancelled') return { cancelled: true }
  if (result.status === 'non-interactive') {
    return { cancelled: false, profile: current }
  }

  return { cancelled: false, profile: result.value }
}
```

- [ ] **Step 5: Run resolver tests and lint and confirm GREEN**

Run:

```sh
node --import tsx --test __tests__/setup-agent-profile.test.ts
pnpm exec eslint src/setup-agent-profile.ts __tests__/setup-agent-profile.test.ts
```

Expected: all resolver tests pass and ESLint exits `0`.

- [ ] **Step 6: Commit Task 2**

```sh
git add src/setup-agent-profile.ts __tests__/setup-agent-profile.test.ts
git commit -m "feat: resolve interactive setup agent profiles"
```

---

### Task 3: Integrate Profile Selection into Setup

**Files:**

- Modify: `src/main.ts:1-25`
- Modify: `src/main.ts:1436-1463`
- Modify: `__tests__/app.test.ts:15`
- Test: `__tests__/app.test.ts:1370-1730`

**Interfaces:**

- Consumes:

```ts
resolveSetupAgentProfile({
  explicitProfile: parsed.agentProfile,
  recordedProfile: recordedMetadata?.agentProfile,
  targets: resolvedTargets.targets,
  input: options.promptInput,
  output: options.promptOutput,
  env: options.env
})
```

- Produces no new public CLI or metadata interface. The returned `profile` is
  written and forwarded through the existing setup lifecycle.

- [ ] **Step 1: Write a failing explicit-target integration test**

Add `type AgentProfile` to the existing import from `src/agent-profile.ts`:

```ts
import {
  AGENT_PROFILES,
  isAgentProfile,
  resolveAgentProfile,
  type AgentProfile
} from '../src/agent-profile.ts'
```

Within `describe('CLI execution', ...)`, add:

```ts
test('prompts for an agent profile after an explicit setup target', async () => {
  const workspace = tempDir('setup-profile-explicit-target-workspace')
  const env = {
    CI: 'false',
    BOXDOWN_CACHE_HOME: tempDir('setup-profile-explicit-target-cache'),
    BOXDOWN_DATA_HOME: tempDir('setup-profile-explicit-target-data')
  }
  const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
  const { input, output, outputText } = fakePromptStreams()
  let receivedProfile: AgentProfile | undefined

  const runPromise = withProcessEnv(env, async () => runCli([
    'setup', '--workspace', workspace, '--target', 'codex'
  ], {
    env,
    promptInput: input,
    promptOutput: output,
    waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
    runDoctorChecks: async () => [],
    setupWorkspace: async (_context, _alias, setupOptions) => {
      receivedProfile = setupOptions.agentProfile
    }
  }))

  await waitForPromptOutput(
    outputText,
    /How much host agent data should Boxdown copy into the container\?/
  )
  input.write('\u001B[B\r')

  assert.strictEqual(await runPromise, 0)
  assert.strictEqual(receivedProfile, 'full')
  assert.strictEqual(readWorkspaceMetadata(context)?.agentProfile, 'full')
})
```

`auth` is initially focused, so one Down selects `full`.

- [ ] **Step 2: Write failing sequential-prompt and cancellation tests**

```ts
test('prompts for profile after a prompt-selected app target', async () => {
  const workspace = tempDir('setup-profile-sequential-workspace')
  const env = {
    CI: 'false',
    BOXDOWN_CACHE_HOME: tempDir('setup-profile-sequential-cache'),
    BOXDOWN_DATA_HOME: tempDir('setup-profile-sequential-data')
  }
  const { input, output, outputText } = fakePromptStreams()
  let receivedProfile: AgentProfile | undefined

  const runPromise = withProcessEnv(env, async () => runCli([
    'setup', '--workspace', workspace
  ], {
    env,
    promptInput: input,
    promptOutput: output,
    waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
    runDoctorChecks: async () => [],
    setupWorkspace: async (_context, _alias, setupOptions) => {
      receivedProfile = setupOptions.agentProfile
    }
  }))

  await waitForPromptOutput(outputText, /Add this project to an AI coding app/)
  input.write('\u001B[A\u001B[A \r')
  await waitForPromptOutput(outputText, /How much host agent data should Boxdown copy/)
  input.write('\u001B[A\r')

  assert.strictEqual(await runPromise, 0)
  assert.strictEqual(receivedProfile, 'none')
})

test('cancels setup before mutations from the profile prompt', async () => {
  const workspace = tempDir('setup-profile-cancel-workspace')
  const env = {
    CI: 'false',
    BOXDOWN_CACHE_HOME: tempDir('setup-profile-cancel-cache'),
    BOXDOWN_DATA_HOME: tempDir('setup-profile-cancel-data')
  }
  const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
  const { input, output, outputText } = fakePromptStreams()
  let setupCalls = 0

  const runPromise = withProcessEnv(env, async () => runCli([
    'setup', '--workspace', workspace, '--target', 'claude'
  ], {
    env,
    promptInput: input,
    promptOutput: output,
    waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
    runDoctorChecks: async () => [],
    setupWorkspace: async () => {
      setupCalls += 1
    }
  }))

  await waitForPromptOutput(outputText, /How much host agent data should Boxdown copy/)
  input.write('\u0003')

  assert.strictEqual(await runPromise, 1)
  assert.strictEqual(setupCalls, 0)
  assert.strictEqual(existsSync(context.workspaceDataDir), false)
  assert.strictEqual(existsSync(context.generatedConfigPath), false)
})
```

The target raw key sequence is deliberately sent only after the first prompt
appears; the profile key sequence is sent only after the second prompt appears.

- [ ] **Step 3: Write failing suppression and fallback integration tests**

Add a table-driven test covering:

```ts
const cases = [
  {
    name: 'explicit profile suppresses prompt',
    argv: ['--target', 'codex', '--agent-profile', 'none'],
    recorded: 'full',
    expected: 'none'
  },
  {
    name: 'no target retains metadata',
    argv: [],
    recorded: 'full',
    expected: 'full'
  },
  {
    name: 'no target defaults to auth',
    argv: [],
    expected: 'auth'
  },
  {
    name: 'non-interactive target retains metadata',
    argv: ['--target', 'claude'],
    recorded: 'none',
    expected: 'none',
    ci: true
  }
] as const
```

For each case:

- create isolated cache/data/workspace paths;
- write recorded metadata only when supplied;
- use non-interactive fake streams for the non-CI cases so an omitted target
  follows the existing skip path;
- stub readiness, doctor, and `setupWorkspace`;
- assert exit `0`, the forwarded value, persisted metadata, and that prompt
  output does not contain `How much host agent data`.

Also extend the existing preflight-failure test to use interactive fake streams
and assert neither the app-target nor profile title is present.

- [ ] **Step 4: Run the new CLI tests and confirm RED**

Run:

```sh
node --import tsx --test \
  --test-name-pattern='setup.*agent profile|profile.*setup|setup preflight' \
  __tests__/app.test.ts
```

Expected: explicit/prompted setup target tests fail because `runCli` does not
call `resolveSetupAgentProfile`; cancellation and profile forwarding assertions
also fail.

- [ ] **Step 5: Wire the resolver into `src/main.ts`**

Add:

```ts
import { resolveSetupAgentProfile } from './setup-agent-profile.ts'
```

After target cancellation and before `writeWorkspaceMetadata`, add:

```ts
const setupAgentProfile = await resolveSetupAgentProfile({
  explicitProfile: parsed.agentProfile,
  recordedProfile: recordedMetadata?.agentProfile,
  targets: resolvedTargets.targets,
  input: options.promptInput,
  output: options.promptOutput,
  env: options.env
})

if (setupAgentProfile.cancelled) {
  process.stderr.write('Canceled setup.\n')
  return 1
}

writeWorkspaceMetadata(context, alias, undefined, setupAgentProfile.profile)
```

Remove the existing setup-path write using `agentProfile.value`. In the call to
`setupWorkspace`, change:

```ts
agentProfile: setupAgentProfile.profile,
```

Do not modify the earlier `agentProfile` resolution because every other
container-starting command still consumes it.

- [ ] **Step 6: Run focused, resolver, and full app tests and confirm GREEN**

Run:

```sh
node --import tsx --test __tests__/setup-agent-profile.test.ts
node --import tsx --test \
  --test-name-pattern='setup.*agent profile|profile.*setup|setup preflight' \
  __tests__/app.test.ts
node --import tsx --test __tests__/app.test.ts
```

Expected: all commands report zero failed tests.

Then run:

```sh
pnpm exec eslint src/main.ts src/setup-agent-profile.ts \
  __tests__/app.test.ts __tests__/setup-agent-profile.test.ts
```

Expected: exit code `0`.

- [ ] **Step 7: Commit Task 3**

```sh
git add src/main.ts __tests__/app.test.ts
git commit -m "feat: prompt for setup agent profiles"
```

---

### Task 4: User Documentation, Release Note, and Complete Verification

**Files:**

- Modify: `README.md:124-181`
- Modify: `README.md:202-232`
- Modify: `docs/features/setup.md:5-100`
- Modify: `docs/testing.md:15-90`
- Create: `.changeset/bright-agents-choose.md`

**Interfaces:**

- Consumes: the final conditional prompt behavior from Tasks 1-3.
- Produces: user-facing setup guidance and a Changesets minor release entry.

- [ ] **Step 1: Add failing documentation assertions**

In the existing documentation test in `__tests__/app.test.ts`, add exact
behavioral assertions:

```ts
assert.match(
  readme,
  /setup.*app target.*agent profile.*--agent-profile.*suppress/is
)
assert.match(
  setupDocs,
  /at least one.*Codex.*Claude.*--agent-profile.*not supplied/is
)
assert.match(
  setupDocs,
  /boxdown setup --target codex --agent-profile auth/
)
assert.match(
  testingDocs,
  /profile selector.*fully explicit.*non-interactive/is
)
```

Read `docs/testing.md` into `testingDocs` beside the existing README/setup
fixtures rather than adding a separate broad file-scanning test.

- [ ] **Step 2: Run documentation tests and confirm RED**

Run:

```sh
node --import tsx --test \
  --test-name-pattern='documents agent profile|documents setup|documentation' \
  __tests__/app.test.ts
```

Expected: at least one new regex assertion fails because conditional prompting
is not yet documented.

- [ ] **Step 3: Update README setup guidance**

Under `### Agent profiles`, add a paragraph with these facts:

````markdown
During interactive `boxdown setup`, selecting or explicitly supplying at least
one Codex or Claude app target opens a single-choice agent-profile prompt unless
`--agent-profile` was supplied. An explicit `--agent-profile` suppresses this
prompt. Skipping every app target keeps the workspace's recorded profile, or
`auth` for a new workspace, without another prompt. Non-interactive setup never
asks.

Use both flags for a fully explicit setup:

```sh
boxdown setup --target codex --agent-profile auth
```
````

Add one sentence immediately after it:

```markdown
App registration and profile exposure are separate: choosing profile `none`
still allows app registration, and profiles are container-wide rather than
filtered to the selected app.
```

Keep the existing tier table and isolation warnings unchanged.

- [ ] **Step 4: Update setup and testing documentation**

In `docs/features/setup.md`:

- change "`auth` is the default" to state that recorded metadata is retained
  and only an unrecorded workspace defaults to `auth`;
- insert the exact eligibility matrix in prose after the option description;
- document cancellation before state writes;
- add the fully explicit command;
- update the numbered flow so target resolution precedes profile resolution
  and persistence.

In `docs/testing.md`:

- add single-choice raw, line, cancellation, and non-interactive behavior to
  the unit strategy;
- add these manual commands:

```sh
boxdown setup --workspace /path/to/repo --target codex
boxdown setup --workspace /path/to/repo --target codex --agent-profile auth
CI=1 boxdown setup --workspace /path/to/repo --target codex
```

- state that the first command shows the profile selector, the second is fully
  explicit, and the third verifies non-interactive fallback.

- [ ] **Step 5: Add a minor Changesets entry**

Create `.changeset/bright-agents-choose.md`:

```markdown
---
'boxdown': minor
---

feat: prompt for an agent profile during interactive setup after selecting a
Codex or Claude app target
```

- [ ] **Step 6: Run documentation tests and lint and confirm GREEN**

Run:

```sh
node --import tsx --test \
  --test-name-pattern='documents agent profile|documents setup|documentation' \
  __tests__/app.test.ts
pnpm run lint:markdown
```

Expected: documentation tests pass and Markdownlint exits `0`.

- [ ] **Step 7: Run the complete verification suite**

Run each command separately and retain its exit code/output:

```sh
pnpm run test
pnpm run lint
pnpm run build
git diff --check
node dist/bin/cli.cjs --help
npm pack --dry-run --json
```

Expected:

- the full Node suite reports zero failures;
- ESLint and Markdownlint report zero errors;
- TypeScript and `tsdown` build successfully;
- diff check prints nothing;
- built help exits `0` and includes `--agent-profile <tier>`;
- pack dry-run exits `0`, includes `src/setup-agent-profile.ts` and the design
  documentation, and includes no credentials, `.ssh`, generated workspace
  state, or `.superpowers` scratch content.

- [ ] **Step 8: Commit Task 4**

```sh
git add README.md docs/features/setup.md docs/testing.md \
  __tests__/app.test.ts .changeset/bright-agents-choose.md
git commit -m "docs: explain interactive setup profiles"
```

- [ ] **Step 9: Inspect final branch state**

Run:

```sh
git status --short
git log --oneline --decorate -6
git diff "$(git merge-base main HEAD)"..HEAD --stat
```

Expected: the worktree is clean, the four task commits plus the design-spec and
implementation-plan commits are present, and the final diff contains only the
prompt, setup resolver/integration, tests, docs, and Changesets entry described
by this plan.
