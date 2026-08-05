# SSH Install Result UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw SSH/app installer prose with a width-aware structured result experience shared by `boxdown ssh install` and the SSH/app phase of `boxdown setup`.

**Architecture:** State-owning installers return typed facts without owning terminal presentation. A focused execution coordinator applies the SSH dependency rules and accumulates partial results, while a focused renderer turns the report into interactive, verbose, or plain output. `main.ts` selects targets, drives existing progress, writes one final report, and derives the exit code.

**Tech Stack:** TypeScript ESM, Node.js 24 built-ins, existing Boxdown ANSI/progress helpers, `node:test`, `assert`, pnpm, ESLint.

## Global Constraints

- Keep the CLI dependency-light; add no runtime dependency.
- Do not launch ChatGPT, Claude, or Cursor.
- Do not attempt an SSH connection.
- Do not add JSON output.
- Keep `ssh uninstall`, `status`, and unrelated commands outside this refactor.
- Keep default success output action-first: show no configuration paths,
  standalone URIs, ownership state, backup paths, or routine connection-test
  disclaimer.
- Preserve complete copyable commands in the default handoff and complete paths
  and URIs in `--verbose` output.
- Keep the interactive final outcome and handoff inside the active command rail,
  before its closing `└`.
- Preserve target selection order and existing user-owned configuration behavior.
- Core SSH failure skips every app target; one app failure does not block later apps.
- Warnings exit `0`; any requested write failure exits `1`.
- Use one output stream for each managed report.
- Render the primary action heading in bold and copyable commands in the CLI accent color.
- Preserve unrelated worktree changes and untracked files.

---

## File Structure

- Create `src/ssh-install-result.ts`: install-result types, outcome derivation, action-first width-aware formatting, conditional ANSI styling, and single-stream writing.
- Create `src/ssh-install.ts`: dependency-aware execution of the SSH alias and selected app targets, progress transitions, failure capture, skip capture, and selection notices.
- Create `__tests__/ssh-install-result.test.ts`: focused unit tests for rendering and execution behavior.
- Modify `src/progress.ts`: append durable result lines after a completed
  checklist without closing or repainting the active interactive rail.
- Modify `src/ssh-config.ts`: return facts about the installed or already-current alias, then remove transitional printing after both callers use the renderer.
- Modify `src/ssh-install-targets.ts`: return a common app result for ChatGPT, Claude, and Cursor; convert the Cursor prerequisite probe into warning data; leave uninstall presentation unchanged.
- Modify `src/main.ts`: add standalone install progress, invoke the coordinator, render one report, share the result with setup, document `--verbose`, and derive exit codes.
- Modify `__tests__/app.test.ts`: update CLI and setup integration assertions to the new stable semantics.
- Modify `README.md`, `docs/features/setup.md`, `docs/features/ssh-config-and-proxy.md`, `docs/testing.md`, and `docs/development.md`: document the final result states and manual handoff.
- Create `.changeset/clear-ssh-results.md`: record the published CLI UX change.

---

### Task 1: Structured result model and renderer

**Files:**

- Create: `src/ssh-install-result.ts`
- Create: `__tests__/ssh-install-result.test.ts`
- Modify: `src/cli-style.ts`
- Modify: `src/progress.ts`

**Interfaces:**

- Consumes: existing `color` and `promptRail` styling primitives from
  `src/cli-style.ts`.
- Produces: `ProgressReporter.appendResult(lines, options)`,
  `InstallDisposition`, `InstallDetail`, `InstallAction`, `InstallWarning`,
  `SshAliasInstallResult`, `AppInstallResult`,
  `RemoteAccessInstallFailure`, `RemoteAccessInstallSkipped`,
  `RemoteAccessInstallNotice`, `RemoteAccessInstallReport`,
  `remoteAccessExitCode(report)`,
  `formatRemoteAccessInstallReport(report, options)`,
  `writeRemoteAccessInstallReport(report, options)`, and
  `formatRemoteAccessCancellation(label, options)`.

- [ ] **Step 1: Write failing renderer tests**

Create `__tests__/ssh-install-result.test.ts` with fixtures that exercise the public contract:

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createProgress } from '../src/progress.ts'

import {
  formatRemoteAccessCancellation,
  formatRemoteAccessInstallReport,
  remoteAccessExitCode,
  writeRemoteAccessInstallReport,
  type RemoteAccessInstallReport
} from '../src/ssh-install-result.ts'

function successfulCursorReport (): RemoteAccessInstallReport {
  return {
    ssh: {
      kind: 'ssh',
      disposition: 'installed',
      summary: 'SSH alias configured',
      alias: 'demo-devcontainer',
      configPath: '/Users/demo/.ssh/config',
      identityPath: '/Users/demo/.local/share/boxdown/id_ed25519',
      validationCommand: "ssh demo-devcontainer 'whoami && pwd'",
      details: [
        { label: 'SSH alias', value: 'demo-devcontainer' },
        { label: 'SSH config', value: '/Users/demo/.ssh/config' },
        { label: 'Identity file', value: '/Users/demo/.local/share/boxdown/id_ed25519' }
      ]
    },
    apps: [{
      kind: 'app',
      target: 'cursor',
      appLabel: 'Cursor',
      disposition: 'installed',
      summary: 'Cursor configured',
      warnings: [],
      action: {
        label: 'Open this project in Cursor:',
        command: "cursor --folder-uri 'vscode-remote://ssh-remote+demo-devcontainer/workspaces/demo'",
        displayLines: [
          'cursor --folder-uri \\',
          "  'vscode-remote://ssh-remote+demo-devcontainer/workspaces/demo'"
        ]
      },
      details: [
        { label: 'Cursor settings', value: '/Users/demo/Library/Application Support/Cursor/User/settings.json' },
        { label: 'Cursor remote folder URI', value: 'vscode-remote://ssh-remote+demo-devcontainer/workspaces/demo' }
      ]
    }],
    failures: [],
    skipped: [],
    notices: []
  }
}

describe('remote access install result rendering', () => {
  test('renders an action-first success without routine technical details', () => {
    const output = formatRemoteAccessInstallReport(successfulCursorReport(), {
      outcomeLabel: 'Configuration',
      interactive: false,
      columns: 60,
      verbose: false,
      color: false
    })

    assert.match(output, /SSH alias configured/)
    assert.match(output, /Cursor configured/)
    assert.match(output, /Configuration complete/)
    assert.match(output, /Next step/)
    assert.match(output, /Open this project in Cursor:/)
    assert.match(output, /cursor --folder-uri/)
    assert.doesNotMatch(output, /SSH connection not tested/)
    assert.doesNotMatch(output, /SSH config/)
    assert.doesNotMatch(output, /Cursor settings/)
    assert.doesNotMatch(output, /Cursor remote folder URI/)
    assert.doesNotMatch(output, /Identity file/)
  })

  test('renders warning remediation before the app action and keeps exit zero', () => {
    const report = successfulCursorReport()
    report.apps[0]?.warnings.push({
      message: 'Cursor Remote SSH extension is not installed',
      remediation: {
        label: 'Install Cursor Remote SSH:',
        command: 'cursor --install-extension anysphere.remote-ssh'
      }
    })
    const output = formatRemoteAccessInstallReport(report, {
      outcomeLabel: 'Configuration',
      interactive: false,
      columns: 80,
      verbose: false,
      color: false
    })

    assert.match(output, /Configuration complete with warnings/)
    assert.ok(output.indexOf('cursor --install-extension') < output.indexOf('cursor --folder-uri'))
    assert.strictEqual(remoteAccessExitCode(report), 0)
  })

  test('renders failures, skips failed app actions, and returns exit one', () => {
    const report = successfulCursorReport()
    report.apps = []
    report.failures.push({
      scope: 'app',
      target: 'cursor',
      label: 'Cursor',
      message: 'Cursor uses a different SSH config',
      recovery: {
        label: 'Update Cursor configuration, then rerun:',
        command: 'boxdown ssh install --target cursor'
      }
    })
    const output = formatRemoteAccessInstallReport(report, {
      outcomeLabel: 'Configuration',
      interactive: false,
      columns: 50,
      verbose: false,
      color: false
    })

    assert.match(output, /Configuration incomplete/)
    assert.match(output, /Cursor configuration failed/)
    assert.match(output, /Cursor uses a different SSH config/)
    assert.match(output, /boxdown ssh install --target cursor/)
    assert.doesNotMatch(output, /cursor --folder-uri/)
    assert.strictEqual(remoteAccessExitCode(report), 1)
  })

  test('shows technical details only when verbose is requested', () => {
    const normal = formatRemoteAccessInstallReport(successfulCursorReport(), {
      outcomeLabel: 'Configuration', interactive: false, columns: 80, verbose: false, color: false
    })
    const verbose = formatRemoteAccessInstallReport(successfulCursorReport(), {
      outcomeLabel: 'Configuration', interactive: false, columns: 80, verbose: true, color: false
    })

    assert.doesNotMatch(normal, /Identity file/)
    assert.doesNotMatch(normal, /SSH config/)
    assert.doesNotMatch(normal, /Cursor settings/)
    assert.match(verbose, /SSH config/)
    assert.match(verbose, /Identity file/)
    assert.match(verbose, /Cursor settings/)
    assert.match(verbose, /Cursor remote folder URI/)
  })

  test('wraps prose but never truncates a dedicated long value', () => {
    const report = successfulCursorReport()
    report.notices.push({
      message: 'No optional app integrations were selected in this non-interactive shell.'
    })
    const output = formatRemoteAccessInstallReport(report, {
      outcomeLabel: 'Configuration', interactive: false, columns: 32, verbose: false, color: false
    })

    assert.match(output, /No optional app integrations\n\s+were selected in this/)
    assert.match(output, /cursor --folder-uri \\/)
    assert.match(output, /vscode-remote:\/\/ssh-remote\+demo-devcontainer\/workspaces\/demo/)
    assert.doesNotMatch(output, /Cursor settings/)
  })

  test('appends the outcome and handoff inside the active progress rail', () => {
    const lines: string[] = []
    const progress = createProgress({
      mode: 'interactive',
      isTTY: false,
      color: false,
      write: (_target, message) => lines.push(message)
    })

    progress.section('Boxdown setup')
    progress.setSteps([{ id: 'cursor', label: 'Configuring Cursor' }])
    progress.startStep('cursor')
    progress.completeStep('cursor')
    writeRemoteAccessInstallReport(successfulCursorReport(), {
      outcomeLabel: 'Setup',
      verbose: false,
      progress,
      env: { NO_COLOR: '1' }
    })
    progress.end()

    const plain = lines.join('\n').replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    assert.match(plain, /│  □ Configuring Cursor[\s\S]*│  ✔ Setup complete/)
    assert.match(plain, /│  Next step[\s\S]*│  Open this project in Cursor:/)
    assert.match(plain, /│    cursor --folder-uri/)
    assert.ok(plain.trimEnd().endsWith('└'))
    assert.doesNotMatch(lines.join('\n'), /\u001B\[/)
  })

  test('uses color only for interactive output when color is enabled', () => {
    const colored = formatRemoteAccessInstallReport(successfulCursorReport(), {
      outcomeLabel: 'Configuration', interactive: true, columns: 80, verbose: false, color: true
    })
    const plain = formatRemoteAccessInstallReport(successfulCursorReport(), {
      outcomeLabel: 'Configuration', interactive: true, columns: 80, verbose: false, color: false
    })

    assert.match(colored, /\u001B\[/)
    assert.match(colored, /\u001B\[1mNext step\u001B\[0m/)
    assert.match(colored, /\u001B\[36mcursor --folder-uri/)
    assert.doesNotMatch(plain, /\u001B\[/)
  })

  test('NO_COLOR disables ANSI on an interactive output stream', () => {
    const chunks: string[] = []
    const output = {
      isTTY: true,
      columns: 80,
      write: (chunk: string) => {
        chunks.push(chunk)
        return true
      }
    } as NodeJS.WritableStream & { isTTY: boolean, columns: number }

    writeRemoteAccessInstallReport(successfulCursorReport(), {
      outcomeLabel: 'Configuration',
      verbose: false,
      output,
      env: { NO_COLOR: '1' }
    })

    assert.doesNotMatch(chunks.join(''), /\u001B\[/)
  })

  test('preserves a PowerShell command without POSIX continuation syntax', () => {
    const report = successfulCursorReport()
    const app = report.apps[0]
    assert.notStrictEqual(app, undefined)
    if (app === undefined) return
    app.action = {
      label: 'Open this project in Cursor:',
      commandLabel: 'PowerShell',
      command: 'cursor --folder-uri "vscode-remote://ssh-remote+demo-devcontainer/workspaces/demo"',
      displayLines: ['cursor --folder-uri "vscode-remote://ssh-remote+demo-devcontainer/workspaces/demo"']
    }
    const output = formatRemoteAccessInstallReport(report, {
      outcomeLabel: 'Configuration', interactive: false, columns: 40, verbose: false, color: false
    })

    assert.match(output, /PowerShell/)
    assert.match(output, /cursor --folder-uri "vscode-remote:/)
    assert.doesNotMatch(output, /folder-uri \\/)
  })

  test('formats cancellation without implying mutation', () => {
    assert.strictEqual(formatRemoteAccessCancellation('SSH install', { color: false }), 'SSH install canceled. No changes made.\n')
  })
})
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
node --import tsx --test __tests__/ssh-install-result.test.ts
```

Expected: FAIL because `src/ssh-install-result.ts` does not exist.

- [ ] **Step 3: Add conditional style and rail-safe result output**

Extend `src/cli-style.ts` without changing existing call sites:

```ts
export function maybeColor (value: string, colorName: CliColor, enabled: boolean): string {
  return enabled ? color(value, colorName) : value
}
```

Add an optional `enabled = true` argument to `selectedMark`, `promptRail`,
`formatPromptTitle`, and `formatPromptEnd`; implement those functions with
`maybeColor`. Existing callers retain their current behavior.

Add `color?: boolean` to `ProgressReporterOptions`, store it in a private
`#color` field defaulting to `true`, and pass it to every style helper used by
`ProgressReporter`. Replace direct `color(...)` calls in checklist marks,
spinners, warnings, details, and skipped labels with `maybeColor(...,
this.#color)`. This ensures that the title, checklist, appended result, and
closing rail all honor the same color decision instead of disabling ANSI only
for the final body.

Add a focused `ProgressReporter.appendResult` method in `src/progress.ts`. It
must be called only after the checklist has reached terminal states. It leaves
the rendered checklist on screen, prevents another repaint, writes each result
line underneath it, and leaves `end()` responsible for the closing `└`:

```ts
appendResult (lines: readonly string[], options: { color: boolean }): void {
  if (this.mode === 'none') return

  this.stopSpinner()
  this.#stopStepTimer()
  this.#renderedStepLineCount = 0

  for (const line of lines) {
    if (this.mode === 'interactive') {
      const rail = promptRail(options.color && this.#color)
      this.#write(this.target, line.length === 0 ? rail : `${rail}  ${line}`)
    } else {
      this.#write(this.target, line)
    }
  }
}
```

Import `maybeColor` in `src/progress.ts`. Before writing, throw an internal
error if any configured step remains `pending` or `running`; a result appended
before work reaches a terminal state would create a misleading report.

- [ ] **Step 4: Implement the result types and formatter**

Create `src/ssh-install-result.ts` with the exact exported shapes used by the tests:

```ts
import { maybeColor, type CliColor } from './cli-style.ts'
import type { ProgressReporter } from './progress.ts'
import type { SshConfigInstallTarget } from './ssh-install-targets.ts'

export type InstallDisposition = 'installed' | 'already-current' | 'already-compatible'

export interface InstallDetail {
  label: string
  value: string
}

export interface InstallAction {
  label: string
  command?: string
  displayLines?: readonly string[]
  commandLabel?: string
}

export interface InstallWarning {
  message: string
  remediation?: InstallAction
}

export interface SshAliasInstallResult {
  kind: 'ssh'
  disposition: Extract<InstallDisposition, 'installed' | 'already-current'>
  summary: string
  alias: string
  configPath: string
  identityPath: string
  validationCommand: string
  details: InstallDetail[]
}

export interface AppInstallResult {
  kind: 'app'
  target: SshConfigInstallTarget
  appLabel: string
  disposition: InstallDisposition
  summary: string
  warnings: InstallWarning[]
  action: InstallAction
  details: InstallDetail[]
}

export interface RemoteAccessInstallFailure {
  scope: 'ssh' | 'app'
  target?: SshConfigInstallTarget
  label: string
  message: string
  recovery?: InstallAction
}

export interface RemoteAccessInstallSkipped {
  target: SshConfigInstallTarget
  label: string
  reason: string
}

export interface RemoteAccessInstallNotice {
  message: string
}

export interface RemoteAccessInstallReport {
  ssh?: SshAliasInstallResult
  apps: AppInstallResult[]
  failures: RemoteAccessInstallFailure[]
  skipped: RemoteAccessInstallSkipped[]
  notices: RemoteAccessInstallNotice[]
}

export interface FormatRemoteAccessInstallReportOptions {
  outcomeLabel: 'Configuration' | 'Setup'
  interactive: boolean
  columns: number
  verbose: boolean
  color: boolean
}

export interface WriteRemoteAccessInstallReportOptions extends Omit<FormatRemoteAccessInstallReportOptions, 'columns' | 'interactive' | 'color'> {
  output?: NodeJS.WritableStream & { isTTY?: boolean, columns?: number }
  progress?: ProgressReporter
  env?: NodeJS.ProcessEnv
}
```

Implement private helpers with these rules:

```ts
function visibleLength (value: string): number
function wrapWords (value: string, width: number): string[]
function indentedProse (value: string, indent: string, columns: number): string[]
function actionLines (action: InstallAction, indent: string): string[]
function detailLines (details: readonly InstallDetail[], verbose: boolean): string[]
function statusMark (status: 'success' | 'warning' | 'failure' | 'skipped', enabled: boolean): string
function styled (value: string, style: CliColor, enabled: boolean): string
```

`wrapWords` must wrap only prose. `actionLines` must put commands on dedicated
lines and preserve every character. `detailLines` must return no lines unless
`verbose` is true, then render every supplied detail on a dedicated line.
`formatRemoteAccessInstallReport` must emit sections in this order: plain-mode
step summary, final outcome, notices, problems, next steps, verbose details. It
must never emit a routine connection-test disclaimer. Group each warning
remediation immediately before its app action; preserve app array order. Use
`Next step` for one action and `Next steps` with numbering for more than one.
Render failure recovery actions before surviving successful-app actions, while
preserving execution order within each group. Never emit the normal action for
a failed app. When the combined action list is empty, omit the `Next step`
heading entirely.

When `interactive` is true, omit the step summary because the progress
checklist already owns it. Start the formatted body with a blank line followed
by the final outcome so `ProgressReporter.appendResult` keeps outcome and
handoff inside the active rail. Style the success/warning/failure icon and
outcome, make `Next step` bold, and apply the cyan accent to command lines. Do
not color explanatory prose.

Implement exit and writing behavior exactly:

```ts
export function remoteAccessExitCode (report: RemoteAccessInstallReport): 0 | 1 {
  return report.failures.length === 0 ? 0 : 1
}

export function formatRemoteAccessCancellation (
  label: string,
  options: { color: boolean }
): string {
  return `${maybeColor(`${label} canceled.`, 'yellow', options.color)} No changes made.\n`
}

export function writeRemoteAccessInstallReport (
  report: RemoteAccessInstallReport,
  options: WriteRemoteAccessInstallReportOptions
): void {
  const output = options.output ?? process.stdout
  const interactive = options.progress === undefined
    ? output.isTTY === true
    : options.progress.mode === 'interactive'
  const env = options.env ?? process.env
  const color = interactive && env.NO_COLOR === undefined
  const formatted = formatRemoteAccessInstallReport(report, {
    outcomeLabel: options.outcomeLabel,
    interactive,
    columns: output.columns ?? 80,
    verbose: options.verbose,
    color
  })

  if (options.progress !== undefined) {
    options.progress.appendResult(formatted.trimEnd().split('\n'), { color })
    return
  }

  output.write(formatted)
}
```

- [ ] **Step 5: Run focused tests and fix only renderer defects**

Run:

```bash
node --import tsx --test __tests__/ssh-install-result.test.ts
pnpm exec eslint src/cli-style.ts src/progress.ts src/ssh-install-result.ts __tests__/ssh-install-result.test.ts
```

Expected: all renderer tests PASS and ESLint exits `0`.

- [ ] **Step 6: Commit the renderer**

```bash
git add src/cli-style.ts src/progress.ts src/ssh-install-result.ts __tests__/ssh-install-result.test.ts
git commit -m "feat: add SSH install result renderer"
```

---

### Task 2: Return structured facts from SSH and app installers

**Files:**

- Modify: `src/ssh-config.ts:187-222`
- Modify: `src/ssh-install-targets.ts:9-223`
- Modify: `__tests__/ssh-install-result.test.ts`

**Interfaces:**

- Consumes: Task 1's `SshAliasInstallResult`, `AppInstallResult`, and `InstallWarning`.
- Produces: `installSshConfig(context, alias, options): Promise<SshAliasInstallResult>` and `installSshInstallTarget(context, alias, target, options): Promise<AppInstallResult>` while preserving existing quiet compatibility until Task 6.

- [ ] **Step 1: Add failing result-mapping tests**

Append tests that call the real installers with temporary config paths and assert stable facts rather than captured prose:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkspaceContext } from '../src/paths.ts'
import { installSshConfig } from '../src/ssh-config.ts'
import { installSshInstallTarget } from '../src/ssh-install-targets.ts'

function tempInstallDir (name: string): string {
  return mkdtempSync(join(tmpdir(), `boxdown-result-${name}-`))
}

async function withInstallEnvironment<T> (
  overrides: Record<string, string>,
  run: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('maps SSH install and idempotent reinstall to structured results', async () => {
  const workspace = tempInstallDir('ssh-workspace')
  const sshConfigPath = join(tempInstallDir('ssh-config'), 'config')
  const context = createWorkspaceContext({
    workspace,
    env: {
      HOME: tempInstallDir('ssh-home'),
      BOXDOWN_DATA_HOME: tempInstallDir('ssh-data')
    }
  })
  const alias = `${context.workspaceBasename}-devcontainer`
  const first = await installSshConfig(context, alias, { quiet: true, configPath: sshConfigPath })
  const second = await installSshConfig(context, alias, { quiet: true, configPath: sshConfigPath })

  assert.strictEqual(first.disposition, 'installed')
  assert.strictEqual(first.summary, 'SSH alias configured')
  assert.strictEqual(first.configPath, sshConfigPath)
  assert.strictEqual(first.identityPath, context.sshKeyPath)
  assert.strictEqual(first.validationCommand, `ssh ${alias} 'whoami && pwd'`)
  assert.strictEqual(second.disposition, 'already-current')
  assert.strictEqual(second.summary, 'SSH alias already configured')
})

test('maps ChatGPT and Claude installs to the common app contract', async () => {
  const workspace = tempInstallDir('apps-workspace')
  const context = createWorkspaceContext({
    workspace,
    env: {
      HOME: tempInstallDir('apps-home'),
      BOXDOWN_DATA_HOME: tempInstallDir('apps-data')
    }
  })
  const alias = `${context.workspaceBasename}-devcontainer`
  const chatgptConfigPath = join(tempInstallDir('chatgpt-config'), 'config.json')
  const chatgptStatePath = join(tempInstallDir('chatgpt-state'), 'state.json')
  const claudeConfigPath = join(tempInstallDir('claude-config'), 'ssh_configs.json')
  const appsHome = tempInstallDir('apps-process-home')

  const { chatgpt, claude } = await withInstallEnvironment({
    HOME: appsHome,
    BOXDOWN_CODEX_APP_CONFIG: chatgptConfigPath,
    BOXDOWN_CODEX_GLOBAL_STATE: chatgptStatePath,
    BOXDOWN_CLAUDE_SSH_CONFIGS: claudeConfigPath
  }, async () => ({
    chatgpt: await installSshInstallTarget(context, alias, 'codex', { quiet: true }),
    claude: await installSshInstallTarget(context, alias, 'claude', { quiet: true })
  }))

  assert.deepStrictEqual({ target: chatgpt.target, label: chatgpt.appLabel, disposition: chatgpt.disposition }, {
    target: 'codex', label: 'ChatGPT', disposition: 'installed'
  })
  assert.match(chatgpt.action.label, /Restart ChatGPT/)
  assert.deepStrictEqual({ target: claude.target, label: claude.appLabel, disposition: claude.disposition }, {
    target: 'claude', label: 'Claude', disposition: 'installed'
  })
  assert.match(claude.action.label, /Restart Claude/)
})
```

Keep these tests serial within the file because they temporarily override process environment values. The `finally` block must restore both previously defined and previously absent values.

- [ ] **Step 2: Run the focused tests and verify type or assertion failures**

Run:

```bash
node --import tsx --test __tests__/ssh-install-result.test.ts
```

Expected: FAIL because both install functions currently resolve to `void`.

- [ ] **Step 3: Return the SSH alias result**

Change `installSshConfig` to `Promise<SshAliasInstallResult>`. Preserve its current mutation and transitional `quiet` printing behavior, construct, and return:

```ts
const changed = nextConfig !== existingConfig
const result: SshAliasInstallResult = {
  kind: 'ssh',
  disposition: changed ? 'installed' : 'already-current',
  summary: changed ? 'SSH alias configured' : 'SSH alias already configured',
  alias,
  configPath: sshConfigPath,
  identityPath: context.sshKeyPath,
  validationCommand: `ssh ${alias} 'whoami && pwd'`,
  details: [
    { label: 'SSH alias', value: alias },
    { label: 'SSH config', value: sshConfigPath },
    { label: 'Identity file', value: context.sshKeyPath },
    { label: 'SSH validation command', value: `ssh ${alias} 'whoami && pwd'` }
  ]
}
```

Use `changed` for the existing write and compatibility-print branches, then return `result` after permissions are finalized. Task 6 removes printing and the `quiet` option after every production caller is migrated.

- [ ] **Step 4: Return ChatGPT and Claude app results**

Change install target signatures to `Promise<AppInstallResult> | AppInstallResult`. Build the return value before the current compatibility-print branch so `quiet: true` returns structured data rather than `void`. Map their lower-level results exactly:

```ts
return {
  kind: 'app',
  target: 'codex',
  appLabel: 'ChatGPT',
  disposition: result.changed || stateResult.changed ? 'installed' : 'already-current',
  summary: result.changed || stateResult.changed ? 'ChatGPT configured' : 'ChatGPT already configured',
  warnings: [],
  action: { label: `Restart ChatGPT, then open the remote project ${entry.label}.` },
  details: [
    { label: 'ChatGPT config', value: result.configPath },
    { label: 'ChatGPT remote project', value: `${entry.label} (${entry.remotePath})` },
    { label: 'ChatGPT state', value: stateResult.statePath },
    ...(result.backupPath === undefined ? [] : [{ label: 'ChatGPT config backup', value: result.backupPath }]),
    ...(stateResult.backupPath === undefined ? [] : [{ label: 'ChatGPT state backup', value: stateResult.backupPath }])
  ]
}
```

Claude returns the same shape with `target: 'claude'`, `appLabel: 'Claude'`,
summary `Claude configured` or `Claude already configured`, verbose details for
the Claude SSH config and `${entry.name} (${entry.sshHost})`, and action
`Restart Claude, then open the configured SSH remote ${entry.name}.`.

- [ ] **Step 5: Convert the Cursor prerequisite probe into data**

Replace the writer-based prerequisite function with:

```ts
async function cursorRemoteSshPrerequisiteWarnings (): Promise<InstallWarning[]> {
  const result = await runBuffered('cursor', ['--list-extensions'], {
    timeoutMs: 5_000,
    mirrorStdout: false,
    mirrorStderr: false,
    logOutput: false
  })
  const installed = result.code === 0 && result.stdout
    .split(/\r?\n/u)
    .some((extension) => extension.trim().toLowerCase() === 'anysphere.remote-ssh')

  if (installed) return []

  const remediation = {
    label: 'Install Cursor Remote SSH:',
    command: 'cursor --install-extension anysphere.remote-ssh'
  }

  if (result.code === 127) {
    return [{
      message: 'Cursor CLI was not found; install Cursor before opening the remote workspace.',
      remediation: {
        label: 'Install Cursor and its Remote SSH extension before opening this project.'
      }
    }]
  }

  const reason = result.timedOut === true
    ? 'the extension query timed out after 5 seconds'
    : result.code === 0
      ? 'the extension is not listed'
      : `the extension query exited with code ${result.code}`
  return [{
    message: `Could not verify Cursor Remote SSH: ${reason}.`,
    remediation
  }]
}
```

Return the Cursor app result with `installed`, `already-current`, or `already-compatible` based on the existing disposition. Preserve `result.command` as the copyable command and use platform-aware display lines:

```ts
const displayLines = result.commandLabel === 'PowerShell'
  ? [result.command]
  : [
      'cursor --folder-uri \\',
      `  '${result.folderUri}'`
    ]
```

Verbose details are `Cursor settings`, `Cursor remote folder URI`, and any
ownership state needed to explain a preserved mapping. None render in default
success output. The action label is `Open this project in Cursor:`.

Build the `AppInstallResult` first. When `quiet` is false, preserve the current transitional Cursor disposition/details and emit each returned warning through `options.warn` or the existing stderr fallback. When `quiet` is true, return the identical result without writing. This keeps the branch green until both command callers migrate.

- [ ] **Step 6: Return results through the transitional install contract**

Change `SshInstallTargetDefinition.install` and `installSshInstallTarget` to return `AppInstallResult`. Retain `SshInstallTargetOptions` during migration so current callers and tests still receive their existing output. A quiet install must return the same result without printing. Do not change uninstall return values or messages. Task 6 removes the install-only `writeEssential` and `warn` hooks after setup is migrated.

- [ ] **Step 7: Run focused and affected legacy tests**

Run:

```bash
node --import tsx --test __tests__/ssh-install-result.test.ts
node --import tsx --test --test-name-pattern "installs explicit|Cursor extension probe|setup keeps" __tests__/app.test.ts
pnpm exec eslint src/ssh-config.ts src/ssh-install-targets.ts __tests__/ssh-install-result.test.ts
```

Expected: result-mapping and affected legacy tests PASS. Compatibility output remains active for callers that have not yet migrated.

- [ ] **Step 8: Commit structured installer results**

```bash
git add src/ssh-config.ts src/ssh-install-targets.ts __tests__/ssh-install-result.test.ts
git commit -m "refactor: return SSH integration results"
```

---

### Task 3: Dependency-aware remote-access execution

**Files:**

- Create: `src/ssh-install.ts`
- Modify: `__tests__/ssh-install-result.test.ts`

**Interfaces:**

- Consumes: `installSshConfig`, `installSshInstallTarget`, `SSH_INSTALL_TARGETS`, `ProgressReporter`, and Task 1 result types.
- Produces: `installRemoteAccess(context, alias, targets, options): Promise<RemoteAccessInstallReport>` and `remoteAccessProgressSteps(targets): ProgressStepDefinition[]`.

- [ ] **Step 1: Add failing coordinator tests with injected installers**

Append these cases using typed fakes:

```ts
test('skips every app when SSH installation fails', async () => {
  const targetCalls: string[] = []
  const report = await installRemoteAccess(context, alias, ['codex', 'cursor'], {
    installSsh: async () => { throw new Error('SSH config is not writable') },
    installTarget: async (_context, _alias, target) => {
      targetCalls.push(target)
      throw new Error('must not run')
    }
  })

  assert.deepStrictEqual(targetCalls, [])
  assert.deepStrictEqual(report.failures.map((failure) => failure.scope), ['ssh'])
  assert.deepStrictEqual(report.skipped.map((skipped) => skipped.target), ['codex', 'cursor'])
  assert.strictEqual(remoteAccessExitCode(report), 1)
})

test('continues after one app fails and preserves target order', async () => {
  const targetCalls: string[] = []
  const report = await installRemoteAccess(context, alias, ['codex', 'claude', 'cursor'], {
    installSsh: async () => sshResult,
    installTarget: async (_context, _alias, target) => {
      targetCalls.push(target)
      if (target === 'codex') throw new Error('invalid ChatGPT config')
      return appResultFor(target)
    }
  })

  assert.deepStrictEqual(targetCalls, ['codex', 'claude', 'cursor'])
  assert.deepStrictEqual(report.failures.map((failure) => failure.target), ['codex'])
  assert.deepStrictEqual(report.apps.map((app) => app.target), ['claude', 'cursor'])
  assert.strictEqual(remoteAccessExitCode(report), 1)
})
```

Define the coordinator fixtures explicitly:

```ts
import type { WorkspaceContext } from '../src/paths.ts'
import type { AppInstallResult, SshAliasInstallResult } from '../src/ssh-install-result.ts'
import type { SshConfigInstallTarget } from '../src/ssh-install-targets.ts'

const context = {} as WorkspaceContext
const alias = 'demo-devcontainer'
const sshResult: SshAliasInstallResult = successfulCursorReport().ssh as SshAliasInstallResult

function appResultFor (target: SshConfigInstallTarget): AppInstallResult {
  const appLabel = target === 'codex' ? 'ChatGPT' : target === 'claude' ? 'Claude' : 'Cursor'
  return {
    kind: 'app',
    target,
    appLabel,
    disposition: 'installed',
    summary: `${appLabel} configured`,
    warnings: [],
    action: { label: `Open ${appLabel}.` },
    details: []
  }
}
```

Add a progress-event test that records `startStep`, `completeStep`, `failStep`, and `skipStep` calls for `ssh-alias`, `ssh-target:codex`, `ssh-target:claude`, and `ssh-target:cursor`.

- [ ] **Step 2: Run the focused tests and verify the missing-module failure**

```bash
node --import tsx --test __tests__/ssh-install-result.test.ts
```

Expected: FAIL because `src/ssh-install.ts` does not exist.

- [ ] **Step 3: Implement progress-step definitions**

Create `src/ssh-install.ts` and export:

```ts
export function remoteAccessProgressSteps (
  targets: readonly SshConfigInstallTarget[]
): ProgressStepDefinition[] {
  return [
    { id: 'ssh-alias', label: 'Configuring SSH alias' },
    ...targets.map((target) => ({
      id: `ssh-target:${target}`,
      label: `Configuring ${SSH_INSTALL_TARGETS.find((candidate) => candidate.value === target)?.label ?? target}`
    }))
  ]
}
```

- [ ] **Step 4: Implement dependency-aware execution**

Use explicit injectable function types:

```ts
export interface InstallRemoteAccessOptions {
  progress?: ProgressReporter
  installSsh?: typeof installSshConfig
  installTarget?: typeof installSshInstallTarget
  notices?: RemoteAccessInstallNotice[]
  retryCommand?: string
}
```

Initialize the report as:

```ts
const report: RemoteAccessInstallReport = {
  apps: [],
  failures: [],
  skipped: [],
  notices: [...(options.notices ?? [])]
}
```

Start `ssh-alias`, call the SSH installer with `{ quiet: true }`, and complete or
fail the step. On core failure, add:

```ts
{
  scope: 'ssh',
  label: 'SSH alias',
  message: errorMessage(error),
  recovery: {
    label: 'Fix the SSH configuration problem, then rerun:',
    command: options.retryCommand ?? 'boxdown ssh install'
  }
}
```

Skip every target in order with reason `SSH alias configuration failed`, call
`progress.skipStep` for each target, and return.

For each target, start its step, await the injected target installer with
`{ quiet: true }`, append success and complete the step. On error, append:

```ts
{
  scope: 'app',
  target,
  label,
  message: errorMessage(error),
  recovery: {
    label: `Fix ${label} configuration, then rerun:`,
    command: `boxdown ssh install --target ${target}`
  }
}
```

Fail the step and continue. Use a private `errorMessage(error: unknown):
string` that returns `error.message` for `Error` and `String(error)` otherwise.

- [ ] **Step 5: Run coordinator tests and lint**

```bash
node --import tsx --test __tests__/ssh-install-result.test.ts
pnpm exec eslint src/ssh-install.ts __tests__/ssh-install-result.test.ts
```

Expected: all result and coordinator tests PASS; ESLint exits `0`.

- [ ] **Step 6: Commit dependency-aware execution**

```bash
git add src/ssh-install.ts __tests__/ssh-install-result.test.ts
git commit -m "feat: coordinate SSH integration installs"
```

---

### Task 4: Wire the standalone `ssh install` experience

**Files:**

- Modify: `src/main.ts:82-161, 1049-1055, 1140-1200, 1420-1440`
- Modify: `__tests__/app.test.ts:3822-3975, 4529-4610`

**Interfaces:**

- Consumes: `installRemoteAccess`, `remoteAccessProgressSteps`, `writeRemoteAccessInstallReport`, `formatRemoteAccessCancellation`, and `remoteAccessExitCode`.
- Produces: the complete default, warning, failure, verbose, cancellation, and non-TTY UX for `boxdown ssh install`.

- [ ] **Step 1: Replace prose-based CLI assertions with outcome assertions**

Update the explicit ChatGPT, Claude, and Cursor process tests to assert:

```ts
assert.strictEqual(result.code, 0)
assert.match(result.stdout, /SSH alias configured/)
assert.match(result.stdout, /Configuration complete/)
assert.match(result.stdout, /Next step/)
assert.match(result.stdout, /Restart ChatGPT/)
assert.doesNotMatch(result.stdout, /SSH connection not tested/)
assert.doesNotMatch(result.stdout, /ChatGPT config/)
assert.doesNotMatch(result.stdout, /Identity file/)
```

Use `Restart Claude` for Claude and `Open this project in Cursor`, the complete folder URI, and the complete `cursor --folder-uri` command for Cursor. Preserve every existing filesystem/state assertion and the assertion that Cursor was not launched.

Because `runCliProcess` captures non-TTY output, also assert `assert.doesNotMatch(result.stdout, /\u001B\[/)` in each explicit target case.

Change the Cursor warning test to require one coherent stdout report and no duplicate stderr warning:

```ts
assert.strictEqual(result.code, 0, entry.name)
assert.match(result.stdout, /Configuration complete with warnings/, entry.name)
assert.match(result.stdout, /Could not verify Cursor Remote SSH/, entry.name)
assert.match(result.stdout, /cursor --install-extension anysphere\.remote-ssh/u, entry.name)
assert.strictEqual(result.stderr, '', entry.name)
```

- [ ] **Step 2: Add failing CLI tests for idempotence, verbose details, and cancellation**

Add process-level assertions:

```ts
test('ssh install reports already configured state on rerun', () => {
  const first = runCliProcess(args, env)
  const second = runCliProcess(args, env)

  assert.strictEqual(first.code, 0)
  assert.strictEqual(second.code, 0)
  assert.match(second.stdout, /SSH alias already configured/)
  assert.match(second.stdout, /Cursor already configured|Cursor already compatible/)
  assert.match(second.stdout, /Configuration complete/)
})

test('ssh install verbose output includes diagnostic details', () => {
  const result = runCliProcess([...args, '--verbose'], env)

  assert.strictEqual(result.code, 0)
  assert.match(result.stdout, /SSH config/)
  assert.match(result.stdout, /Identity file/)
  assert.match(result.stdout, /Cursor settings/)
  assert.match(result.stdout, /Cursor remote folder URI/)
})
```

Update cancellation to assert `SSH install canceled. No changes made.` while retaining the no-file/no-metadata assertions.

Add a Cursor compatibility case that pre-populates `remote.SSH.remotePlatform[alias] = "linux"` without Boxdown ownership, runs `ssh install --target cursor`, and asserts exit `0`, `Cursor already compatible`, and `Configuration complete`. Preserve the existing setting byte-for-byte except for unrelated Boxdown ownership metadata outside Cursor's settings file.

- [ ] **Step 3: Run the standalone CLI tests and verify failures**

```bash
node --import tsx --test --test-name-pattern "ssh install|explicit Codex|explicit Claude|explicit Cursor|Cursor extension probe" __tests__/app.test.ts
```

Expected: FAIL because `main.ts` still invokes installers that no longer print their results.

- [ ] **Step 4: Add standalone progress and selection notices**

Import the Task 1 and Task 3 APIs. Replace `printSkippedSshInstallTargets` with a pure notice factory:

```ts
function skippedSshInstallTargetNotice (
  command: 'setup' | 'ssh install'
): RemoteAccessInstallNotice {
  return {
    message: `No optional app integrations were selected. Run boxdown ${command} with --target codex, --target claude, or --target cursor to add one later.`
  }
}
```

Update USAGE so the `ssh install` synopsis includes `[--verbose]`.

Update `createCliProgress` so the entire managed section, not just the result
body, honors `NO_COLOR`:

```ts
return createProgress({
  mode: resolveProgressMode({
    verbose: parsed.verbose,
    json: parsed.json,
    target,
    env: options.env
  }),
  target,
  color: (options.env ?? process.env).NO_COLOR === undefined
})
```

- [ ] **Step 5: Replace the standalone install branch**

Use a structured progress section and write the report inside `runLoggedLifecycle` so the same stream is logged:

```ts
if (parsed.command === 'ssh-install') {
  const resolvedTargets = await resolveSshInstallTargets(parsed, options)

  if (resolvedTargets.cancelled) {
    process.stderr.write(formatRemoteAccessCancellation('SSH install', {
      color: process.stderr.isTTY === true && (options.env ?? process.env).NO_COLOR === undefined
    }))
    return 1
  }

  writeWorkspaceMetadata(context, alias, undefined, parsed.agentProfile)
  const progress = createCliProgress(parsed, 'stdout', { env: options.env })

  return runLoggedLifecycle(context, 'ssh install', argv, async () => {
    let exitCode: 0 | 1 = 0

    await withProgressSection(progress, 'Configure remote access', [
      `Workspace: ${context.workspaceFolder}`,
      `SSH alias: ${alias}`
    ], async () => {
      progress.setSteps(remoteAccessProgressSteps(resolvedTargets.targets))
      const report = await installRemoteAccess(context, alias, resolvedTargets.targets, {
        progress,
        retryCommand: 'boxdown ssh install',
        notices: resolvedTargets.skippedNonInteractive
          ? [skippedSshInstallTargetNotice('ssh install')]
          : []
      })

      writeRemoteAccessInstallReport(report, {
        outcomeLabel: 'Configuration',
        verbose: parsed.verbose,
        progress,
        env: options.env ?? process.env
      })
      exitCode = remoteAccessExitCode(report)
    })

    return exitCode
  })
}
```

Writing inside the callback is mandatory: `withProgressSection` closes the rail
in `finally`, so rendering afterward would recreate the original visual defect.
Do not call the old skipped-target printer or any installer a second time.

- [ ] **Step 6: Add partial-failure process coverage**

Create invalid ChatGPT config JSON, select ChatGPT followed by Claude, and assert:

```ts
assert.strictEqual(result.code, 1)
assert.match(result.stdout, /SSH alias configured/)
assert.match(result.stdout, /ChatGPT configuration failed/)
assert.match(result.stdout, /Claude configured/)
assert.match(result.stdout, /Configuration incomplete/)
assert.doesNotMatch(result.stdout, /Restart ChatGPT/)
assert.match(result.stdout, /boxdown ssh install --target codex/)
assert.match(result.stdout, /Restart Claude/)
assert.strictEqual(existsSync(claudeConfigPath), true)
```

Add a core-failure case by using a directory as `BOXDOWN_SSH_CONFIG`; assert every selected app is rendered as skipped and no app config file is created.

- [ ] **Step 7: Run standalone CLI tests and lint**

```bash
node --import tsx --test __tests__/ssh-install-result.test.ts
node --import tsx --test --test-name-pattern "ssh install|explicit Codex|explicit Claude|explicit Cursor|Cursor extension probe" __tests__/app.test.ts
pnpm exec eslint src/main.ts __tests__/app.test.ts
```

Expected: all selected tests PASS and ESLint exits `0`.

- [ ] **Step 8: Commit standalone CLI wiring**

```bash
git add src/main.ts __tests__/app.test.ts
git commit -m "feat: improve SSH install result UX"
```

---

### Task 5: Share results with `boxdown setup`

**Files:**

- Modify: `src/main.ts:60-70, 1060-1138, 1181-1190, 1493-1555`
- Modify: `__tests__/app.test.ts:2270-2855, 3238-3535`

**Interfaces:**

- Consumes: Task 3's coordinator and Task 1's renderer.
- Produces: `setupWorkspace(context, alias, options): Promise<RemoteAccessInstallReport>` in production, with `RunCliOptions.setupWorkspace` allowing `Promise<RemoteAccessInstallReport | void>` for focused lifecycle test doubles.

- [ ] **Step 1: Add failing setup result-sharing tests**

Extend the existing setup progress tests so a real Cursor setup asserts each handoff fact exactly once:

```ts
const report = await setupWorkspace(context, alias, {
  progress,
  targets: ['cursor'],
  start: async () => 'setup-container',
  installSsh: async () => sshResult,
  installTarget: async () => cursorResult
})

assert.deepStrictEqual(report.apps.map((app) => app.target), ['cursor'])
assert.deepStrictEqual(report.failures, [])
```

Add a `runCli(['setup', ...])` test whose injected `setupWorkspace` completes
the steps it owns before returning a report with a Cursor warning:

```ts
setupWorkspace: async (_context, _alias, setupOptions) => {
  for (const stepId of [
    'ssh-identity',
    'devcontainer-config',
    'devcontainer-start',
    'ssh-alias',
    'ssh-target:cursor'
  ]) {
    setupOptions.progress?.startStep(stepId)
    setupOptions.progress?.completeStep(stepId)
  }
  return cursorWarningReport
}
```

Assert `Setup complete with warnings`, the remediation, and the Cursor action
appear once and in that order. Also assert that the normal result contains no
`Cursor settings:`, `Cursor remote folder URI:`, or routine connection-test
line. The fake must complete every configured step because
`ProgressReporter.appendResult` intentionally rejects a handoff while work is
still pending.

- [ ] **Step 2: Run setup-focused tests and verify failures**

```bash
node --import tsx --test --test-name-pattern "setup.*Cursor|Cursor.*setup|preserve Cursor handoff|setup result" __tests__/app.test.ts
```

Expected: FAIL because `setupWorkspace` currently returns `void` and directly routes Cursor handoff text through progress.

- [ ] **Step 3: Delegate the SSH/app phase to the coordinator**

Keep container start unchanged. Replace the SSH and target loops in `setupWorkspace` with:

```ts
return installRemoteAccess(context, alias, options.targets ?? [], {
  progress: options.progress,
  installSsh: options.installSsh,
  installTarget: options.installTarget,
  retryCommand: 'boxdown setup'
})
```

Change the production return type to `Promise<RemoteAccessInstallReport>`. Remove target-specific `quiet`, `writeEssential`, and `warn` routing from `setupWorkspace`; the coordinator owns the transitional quiet call until Task 6 removes those hooks.

- [ ] **Step 4: Render the setup report before the lifecycle rail closes**

Change `RunCliOptions.setupWorkspace` to an explicit function type returning
`Promise<RemoteAccessInstallReport | void>` so existing preflight/profile test
doubles may remain presentation-free. In the setup branch, append the
non-interactive target notice and render the report inside the
`withProgressSection` callback, after all steps finish and before its `finally`
closes the rail:

```ts
let setupExitCode: 0 | 1 = 0
await withProgressSection(progress, 'Boxdown setup', [
  `Workspace: ${context.workspaceFolder}`,
  `SSH alias: ${alias}`,
  ...(progress.mode === 'none' ? [] : SETUP_OWNERSHIP_DETAILS)
], async () => {
  progress.setSteps(setupProgressSteps(resolvedTargets.targets))
  const report = await (options.setupWorkspace ?? setupWorkspace)(context, alias, {
    agentProfile: setupAgentProfile.profile,
    recreate: parsed.recreate,
    targets: resolvedTargets.targets,
    progress,
    logger
  })
  showDetailedCommandLogPath(progress, context)

  if (report === undefined) return

  const finalReport: RemoteAccessInstallReport = {
    ...report,
    notices: [
      ...report.notices,
      ...(resolvedTargets.skippedNonInteractive
        ? [skippedSshInstallTargetNotice('setup')]
        : [])
    ]
  }
  writeRemoteAccessInstallReport(finalReport, {
    outcomeLabel: 'Setup',
    verbose: parsed.verbose,
    progress,
    env: options.env ?? process.env
  })
  setupExitCode = remoteAccessExitCode(finalReport)
})

return setupExitCode
```

Keep this block inside `runLoggedLifecycle` so it is logged once. Remove the old
post-lifecycle skipped-target print. Earlier container/preflight failures must
continue throwing through the existing lifecycle error path.

- [ ] **Step 5: Update setup progress labels and assertions**

Replace local `setupProgressSteps` SSH/app entries with `remoteAccessProgressSteps(targets)` after the existing devcontainer steps:

```ts
return [
  ...devcontainerStartProgressSteps(),
  ...remoteAccessProgressSteps(targets)
]
```

Update expected labels from `Installing` to `Configuring`. Keep every existing progress-state and no-launch assertion.

- [ ] **Step 6: Add setup partial-failure continuation coverage**

Inject an app installer that fails ChatGPT and succeeds Cursor. Assert the setup
checklist marks ChatGPT failed and Cursor complete, the final report says
`Setup incomplete`, `boxdown ssh install --target codex` appears as recovery,
Cursor's action remains present, ChatGPT's normal action is absent, and the
command returns `1`.

- [ ] **Step 7: Run setup, renderer, and lint checks**

```bash
node --import tsx --test __tests__/ssh-install-result.test.ts
node --import tsx --test --test-name-pattern "setup|preserve Cursor handoff|Cursor.*progress" __tests__/app.test.ts
pnpm exec eslint src/main.ts __tests__/app.test.ts
```

Expected: all selected tests PASS; app handoff lines appear once; ESLint exits `0`.

- [ ] **Step 8: Commit shared setup results**

```bash
git add src/main.ts __tests__/app.test.ts
git commit -m "feat: share SSH integration results with setup"
```

---

### Task 6: Remove transitional installer presentation

**Files:**

- Modify: `src/ssh-config.ts:187-222`
- Modify: `src/ssh-install-targets.ts:9-223`
- Modify: `src/ssh-install.ts`
- Modify: `src/main.ts:1060-1138, 1560-1630`
- Modify: `__tests__/ssh-install-result.test.ts`
- Modify: `__tests__/app.test.ts:4818-4820, 11597-12508`

**Interfaces:**

- Consumes: the fully migrated callers from Tasks 4 and 5.
- Produces: presentation-free install functions with `installSshConfig(context, alias, { configPath? })` and `installSshInstallTarget(context, alias, target)`; uninstall retains its existing quiet options and prose.

- [ ] **Step 1: Add failing silence tests**

Patch `process.stdout.write` and `process.stderr.write` around direct SSH, ChatGPT, Claude, and Cursor install calls, collect chunks, and assert both arrays remain empty while returned results remain populated:

```ts
const stdout: string[] = []
const stderr: string[] = []
const originalStdoutWrite = process.stdout.write
const originalStderrWrite = process.stderr.write
process.stdout.write = ((chunk: string | Uint8Array) => {
  stdout.push(String(chunk))
  return true
}) as typeof process.stdout.write
process.stderr.write = ((chunk: string | Uint8Array) => {
  stderr.push(String(chunk))
  return true
}) as typeof process.stderr.write

try {
  const ssh = await installSshConfig(context, alias, { configPath: sshConfigPath })
  const chatgpt = await installSshInstallTarget(context, alias, 'codex')
  assert.strictEqual(ssh.kind, 'ssh')
  assert.strictEqual(chatgpt.kind, 'app')
} finally {
  process.stdout.write = originalStdoutWrite
  process.stderr.write = originalStderrWrite
}

assert.deepStrictEqual(stdout, [])
assert.deepStrictEqual(stderr, [])
```

Run the Cursor silence assertion with a fake installed `anysphere.remote-ssh` extension so the prerequisite check itself produces no warning.

- [ ] **Step 2: Run the silence tests and verify they fail**

```bash
node --import tsx --test --test-name-pattern "presentation-free|silent" __tests__/ssh-install-result.test.ts
```

Expected: FAIL because compatibility printing and install options still exist.

- [ ] **Step 3: Remove SSH install printing**

Change `installSshConfig` options to `{ configPath?: string }`, remove all install-path `process.stdout.write` calls, and always return the existing structured result. Remove `quiet: true` from `installSshConfig` calls in `src/main.ts`, `src/ssh-install.ts`, and direct tests.

- [ ] **Step 4: Split app install and uninstall options**

Replace the shared options contract with:

```ts
export interface SshUninstallTargetOptions {
  quiet?: boolean
}

export interface SshInstallTargetDefinition {
  value: SshConfigInstallTarget
  label: string
  description: string
  flag: string
  usesContainerAgentProfile: boolean
  install: (context: WorkspaceContext, alias: string) => Promise<AppInstallResult> | AppInstallResult
  uninstall: (context: WorkspaceContext, alias: string, options?: SshUninstallTargetOptions) => Promise<void> | void
  uninstallWorkspace: (context: WorkspaceContext, aliases: readonly string[], options?: SshUninstallTargetOptions) => Promise<void> | void
}
```

Remove ChatGPT, Claude, and Cursor install printing and remove `writeEssential`/install warning writers. Return Cursor prerequisite warnings only through `AppInstallResult.warnings`. Update `installSshInstallTarget` and `src/ssh-install.ts` to call the target without options. Do not alter uninstall writers or cleanup warnings.
Do not carry `Refresh Cursor Remote Explorer or restart Cursor if the SSH alias
is not visible` into the normal success result; it is troubleshooting advice,
not the primary next action. Keep it in documentation or emit it only as part
of a future warning tied to an observed problem.

- [ ] **Step 5: Run focused tests and type checking**

```bash
node --import tsx --test __tests__/ssh-install-result.test.ts
node --import tsx --test --test-name-pattern "ssh install|setup|Cursor" __tests__/app.test.ts
pnpm run build
pnpm exec eslint src/ssh-config.ts src/ssh-install-targets.ts src/ssh-install.ts src/main.ts __tests__/ssh-install-result.test.ts __tests__/app.test.ts
```

Expected: all selected tests PASS, the build and ESLint exit `0`, and no production install caller passes presentation options.

- [ ] **Step 6: Commit presentation-free installers**

```bash
git add src/ssh-config.ts src/ssh-install-targets.ts src/ssh-install.ts src/main.ts __tests__/ssh-install-result.test.ts __tests__/app.test.ts
git commit -m "refactor: separate SSH install facts from output"
```

---

### Task 7: Documentation and release note

**Files:**

- Modify: `README.md:245-285, 338-405`
- Modify: `docs/features/setup.md:85-120`
- Modify: `docs/features/ssh-config-and-proxy.md:1-105`
- Modify: `docs/testing.md:70-95`
- Modify: `docs/development.md:20-70`
- Create: `.changeset/clear-ssh-results.md`

**Interfaces:**

- Consumes: the final CLI wording and behavior from Tasks 4-6.
- Produces: user-facing documentation and a patch release entry for `boxdown`.

- [ ] **Step 1: Update user documentation**

Document these exact behavioral guarantees in the SSH feature guide and summarize them in README/setup docs:

```markdown
`boxdown ssh install` ends with one of three results:

- **Configuration complete** — every requested configuration write succeeded.
- **Configuration complete with warnings** — configuration succeeded, but an
  optional prerequisite or follow-up condition needs attention.
- **Configuration incomplete** — one or more requested writes failed.

A successful result means Boxdown wrote or verified the requested
configuration. It does not mean Boxdown tested the SSH connection. Boxdown does
not launch the selected app; follow the app-specific command or restart action
under **Next step**.
```

Document that `--verbose` adds identity, backup, ownership, URI, and diagnostic details. Update testing instructions to cover a terminal narrower than 80 columns, warning output, idempotent rerun, and multi-target partial failure.
Document that normal successful output contains only the outcome and app-specific
next actions; configuration paths remain available through `--verbose` and
`boxdown status`. Show the interactive outcome and handoff inside the same
Boxdown rail as the completed checklist.

- [ ] **Step 2: Add the changeset**

Create `.changeset/clear-ssh-results.md`:

```markdown
---
"boxdown": patch
---

Make SSH and app installation results easier to scan with explicit outcomes,
ordered next steps, narrow-terminal formatting, and consistent ChatGPT,
Claude, and Cursor handoff instructions.
```

- [ ] **Step 3: Run documentation checks**

```bash
pnpm run lint:markdown
git diff --check
```

Expected: both commands exit `0`.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/features/setup.md docs/features/ssh-config-and-proxy.md docs/testing.md docs/development.md .changeset/clear-ssh-results.md
git commit -m "docs: explain SSH install outcomes"
```

---

### Task 8: Full regression verification

**Files:**

- Verify: all files changed by Tasks 1-7

**Interfaces:**

- Consumes: the complete implementation.
- Produces: evidence that the UX change is ready for review without regressions.

- [ ] **Step 1: Run focused result and CLI suites**

```bash
node --import tsx --test __tests__/ssh-install-result.test.ts
node --import tsx --test --test-name-pattern "ssh install|setup|Cursor" __tests__/app.test.ts
```

Expected: all selected tests PASS with zero failures.

- [ ] **Step 2: Run the complete automated suite**

```bash
pnpm test
pnpm run lint
pnpm run build
```

Expected: tests, lint, type checking, and bundling all exit `0`.

- [ ] **Step 3: Run package verification**

```bash
npm pack --dry-run --json
git diff --check
git status --short
```

Expected: package inspection succeeds, no whitespace errors are reported, and status contains only the intended branch changes plus any unrelated pre-existing user files.

- [ ] **Step 4: Perform manual terminal acceptance checks**

In terminal widths of 60 and 100 columns, run:

```bash
mkdir -p /private/tmp/boxdown-ssh-result-ux/project
HOME=/private/tmp/boxdown-ssh-result-ux/home BOXDOWN_CACHE_HOME=/private/tmp/boxdown-ssh-result-ux/cache BOXDOWN_DATA_HOME=/private/tmp/boxdown-ssh-result-ux/data BOXDOWN_RUNTIME_HOME=/private/tmp/boxdown-ssh-result-ux/runtime BOXDOWN_CURSOR_SETTINGS=/private/tmp/boxdown-ssh-result-ux/cursor/settings.json pnpm run start -- ssh install --workspace /private/tmp/boxdown-ssh-result-ux/project --target cursor
HOME=/private/tmp/boxdown-ssh-result-ux/home BOXDOWN_CACHE_HOME=/private/tmp/boxdown-ssh-result-ux/cache BOXDOWN_DATA_HOME=/private/tmp/boxdown-ssh-result-ux/data BOXDOWN_RUNTIME_HOME=/private/tmp/boxdown-ssh-result-ux/runtime BOXDOWN_CURSOR_SETTINGS=/private/tmp/boxdown-ssh-result-ux/cursor/settings.json pnpm run start -- ssh install --workspace /private/tmp/boxdown-ssh-result-ux/project --target cursor --verbose
NO_COLOR=1 HOME=/private/tmp/boxdown-ssh-result-ux/home BOXDOWN_CACHE_HOME=/private/tmp/boxdown-ssh-result-ux/cache BOXDOWN_DATA_HOME=/private/tmp/boxdown-ssh-result-ux/data BOXDOWN_RUNTIME_HOME=/private/tmp/boxdown-ssh-result-ux/runtime BOXDOWN_CURSOR_SETTINGS=/private/tmp/boxdown-ssh-result-ux/cursor/settings.json pnpm run start -- ssh install --workspace /private/tmp/boxdown-ssh-result-ux/project --target cursor
CI=1 HOME=/private/tmp/boxdown-ssh-result-ux/home BOXDOWN_CACHE_HOME=/private/tmp/boxdown-ssh-result-ux/cache BOXDOWN_DATA_HOME=/private/tmp/boxdown-ssh-result-ux/data BOXDOWN_RUNTIME_HOME=/private/tmp/boxdown-ssh-result-ux/runtime BOXDOWN_CURSOR_SETTINGS=/private/tmp/boxdown-ssh-result-ux/cursor/settings.json pnpm run start -- ssh install --workspace /private/tmp/boxdown-ssh-result-ux/project --target cursor
HOME=/private/tmp/boxdown-ssh-result-ux/home BOXDOWN_CACHE_HOME=/private/tmp/boxdown-ssh-result-ux/cache BOXDOWN_DATA_HOME=/private/tmp/boxdown-ssh-result-ux/data BOXDOWN_RUNTIME_HOME=/private/tmp/boxdown-ssh-result-ux/runtime BOXDOWN_CURSOR_SETTINGS=/private/tmp/boxdown-ssh-result-ux/cursor/settings.json pnpm run start -- setup --workspace /private/tmp/boxdown-ssh-result-ux/project --toolchain none --target cursor
```

Expected: the interactive result keeps `Setup complete`/`Configuration
complete`, `Next step`, and the command inside the active rail; the default
result contains no settings/config path labels, standalone URI label, ownership
state, backup path, or routine connection-test disclaimer; commands are colored
and complete; the 60-column output remains vertically scannable; verbose adds
diagnostic details; `NO_COLOR=1` and CI output contain no ANSI/control
sequences; the SSH connection is not attempted; and Cursor is not launched.
Use a disposable test project and test-specific Boxdown path overrides so no
production app configuration is modified.

- [ ] **Step 5: Review the final diff against the spec**

Confirm every requirement in `docs/superpowers/specs/2026-08-05-ssh-install-result-ux-design.md` maps to code or tests. Confirm `ssh uninstall`, `status`, and app cleanup behavior have no unrelated changes.

- [ ] **Step 6: Commit any verification-only corrections**

If verification required corrections, stage only those files and commit them with a message describing the corrected behavior. If no correction was needed, leave the existing task commits unchanged.
