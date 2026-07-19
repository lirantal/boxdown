# Container Runtime Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Boxdown command that may create or start a devcontainer one bounded Docker/Buildx readiness gate, while keeping `boxdown start` usable after setup was skipped or failed and preserving actionable post-readiness failures.

**Architecture:** A focused `container-runtime` module owns one-shot probing, bounded polling, and readiness diagnostics. `doctor` consumes the one-shot probe, while CLI lifecycle branches consume the waiter before metadata or generated runtime state; the existing Dev Containers invocation remains single-attempt. The progress and command-failure layers receive only the small additions needed to surface state transitions and point users to the redacted workspace log.

**Tech Stack:** TypeScript, Node.js 24+, `node:test`, Docker CLI, Docker Buildx, `@devcontainers/cli`, pnpm, StandardJS.

## Global Constraints

- Poll Docker daemon and a discoverable Buildx builder once per second for at most 60,000 milliseconds.
- Treat a missing Docker executable as terminal and do not sleep.
- Treat missing Buildx as a non-blocking Dev Containers CLI fallback with one warning.
- Run `docker buildx inspect --bootstrap` only after Docker, the daemon, and `docker buildx version` succeed.
- Do not launch Docker Desktop or create, select, replace, repair, or delete Buildx builders.
- Invoke `devcontainer up` once after readiness; do not retry builds, Features, registries, Dockerfiles, or lifecycle hooks.
- Apply the waiter to `setup`, `start`/`shell`, `ssh-proxy`, `tunnel`, `refresh-gh-token`, and every coding-agent command.
- Do not apply the waiter to `refresh-gh-token-running`, SSH-only commands, `doctor`, `status`, `list`, `stop`, `down`, or `purge`.
- A readiness failure must not create workspace metadata, generated devcontainer configuration, an SSH identity, or a container. A non-setup command may create only its redacted diagnostic log.
- Keep setup readiness ahead of doctor checks, prompts, metadata, and all generated state.
- Keep workspace metadata schema unchanged; do not add setup-completion state or a migration.
- Keep all automated tests independent of a real Docker daemon, registry network access, and wall-clock delays.
- Preserve current secret redaction in managed command logs.

---

## File Structure

- Create `src/container-runtime.ts`: Docker/Buildx command probing, bounded waiting, transition deduplication, and actionable readiness error formatting.
- Create `__tests__/container-runtime.test.ts`: deterministic unit tests using injected command results, clock, and sleep.
- Modify `src/doctor.ts`: replace duplicate Docker checks with the shared one-shot probe and add a Buildx diagnostic.
- Modify `src/main.ts`: classify gated commands, inject the waiter for tests, order readiness before metadata/state, and keep setup's preflight state-free.
- Modify `src/progress.ts`: add a mode-aware status line and improve concise nested Dev Containers failures.
- Modify `src/devcontainer.ts`: attach the managed workspace log path to lifecycle command failures.
- Modify `__tests__/app.test.ts`: cover doctor mapping, lifecycle command scope and ordering, progress output, wrapper diagnostics, and the no-retry boundary.
- Modify `README.md`, `docs/features/setup.md`, `docs/features/start-and-shell.md`, and `docs/features/lifecycle.md`: document standalone recovery, the 60-second gate, Buildx fallback, and diagnostics.

### Task 1: Add the one-shot Docker and Buildx probe

**Files:**

- Create: `src/container-runtime.ts`
- Create: `__tests__/container-runtime.test.ts`

**Interfaces:**

- Consumes: `runBuffered(command: string, args: string[], options): Promise<CommandResult>` from `src/process.ts`.
- Produces: `ContainerRuntimeReason`, `ContainerRuntimeMode`, `ContainerRuntimeFailure`, `ContainerRuntimeProbe`, `ContainerRuntimeCommandRunner`, and `probeContainerRuntime(runCommand?)`.
- Probe command order is exactly `docker --version`, `docker info`, `docker buildx version`, then `docker buildx inspect --bootstrap`, stopping as soon as a result determines readiness.

- [ ] **Step 1: Write probe tests with an ordered fake runner**

Create `__tests__/container-runtime.test.ts` with these imports and helpers:

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  probeContainerRuntime,
  type ContainerRuntimeCommandResult,
  type ContainerRuntimeCommandRunner
} from '../src/container-runtime.ts'

const ok: ContainerRuntimeCommandResult = { code: 0, stdout: '', stderr: '' }

function runnerFrom (
  results: readonly ContainerRuntimeCommandResult[],
  calls: string[][]
): ContainerRuntimeCommandRunner {
  let index = 0
  return async (command, args) => {
    calls.push([command, ...args])
    const result = results[index]
    index += 1
    assert.ok(result !== undefined, `Unexpected command: ${command} ${args.join(' ')}`)
    return result
  }
}
```

Add these five tests:

```ts
describe('container runtime probe', () => {
  test('fails immediately when the Docker CLI is unavailable', async () => {
    const calls: string[][] = []
    const probe = await probeContainerRuntime(runnerFrom([
      { code: 127, stdout: '', stderr: 'spawn docker ENOENT\n' }
    ], calls))

    assert.deepStrictEqual(calls, [['docker', '--version']])
    assert.strictEqual(probe.state, 'failed')
    assert.strictEqual(probe.failure.reason, 'docker-cli-unavailable')
    assert.strictEqual(probe.failure.detail, 'spawn docker ENOENT')
  })

  test('waits for the daemon without probing Buildx', async () => {
    const calls: string[][] = []
    const probe = await probeContainerRuntime(runnerFrom([
      ok,
      { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon\n' }
    ], calls))

    assert.deepStrictEqual(calls, [
      ['docker', '--version'],
      ['docker', 'info']
    ])
    assert.strictEqual(probe.state, 'waiting')
    assert.strictEqual(probe.failure.reason, 'docker-daemon-unavailable')
    assert.deepStrictEqual(probe.failure.command, ['docker', 'info'])
  })

  test('uses the supported fallback when Buildx is unavailable', async () => {
    const calls: string[][] = []
    const probe = await probeContainerRuntime(runnerFrom([
      ok,
      ok,
      { code: 1, stdout: '', stderr: 'docker: unknown command: buildx\n' }
    ], calls))

    assert.deepStrictEqual(calls, [
      ['docker', '--version'],
      ['docker', 'info'],
      ['docker', 'buildx', 'version']
    ])
    assert.deepStrictEqual(probe, {
      state: 'ready',
      mode: 'fallback',
      warnings: ['Docker Buildx is unavailable; the Dev Containers CLI will use its classic-build fallback.']
    })
  })

  test('waits when a discoverable Buildx builder cannot bootstrap', async () => {
    const calls: string[][] = []
    const probe = await probeContainerRuntime(runnerFrom([
      ok,
      ok,
      ok,
      { code: 1, stdout: 'builder output\n', stderr: 'failed to initialize builder\n' }
    ], calls))

    assert.deepStrictEqual(calls.at(-1), ['docker', 'buildx', 'inspect', '--bootstrap'])
    assert.strictEqual(probe.state, 'waiting')
    assert.strictEqual(probe.failure.reason, 'buildx-builder-unavailable')
    assert.strictEqual(probe.failure.detail, 'failed to initialize builder')
  })

  test('reports Buildx readiness and compacts diagnostic output', async () => {
    const ready = await probeContainerRuntime(runnerFrom([ok, ok, ok, ok], []))
    assert.deepStrictEqual(ready, { state: 'ready', mode: 'buildx', warnings: [] })

    const failed = await probeContainerRuntime(runnerFrom([
      ok,
      { code: 1, stdout: '  daemon\n  still starting  ', stderr: '' }
    ], []))
    assert.strictEqual(failed.state, 'waiting')
    assert.strictEqual(failed.failure.detail, 'daemon still starting')
  })
})
```

- [ ] **Step 2: Run the focused test and confirm the module is missing**

Run:

```sh
node --import tsx --test __tests__/container-runtime.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/container-runtime.ts`.

- [ ] **Step 3: Implement the probe and its stable result types**

Create `src/container-runtime.ts` with:

```ts
import { runBuffered, type CommandResult } from './process.ts'

export type ContainerRuntimeReason =
  | 'docker-cli-unavailable'
  | 'docker-daemon-unavailable'
  | 'buildx-builder-unavailable'

export type ContainerRuntimeMode = 'buildx' | 'fallback'
export type ContainerRuntimeCommandResult = CommandResult
export type ContainerRuntimeCommandRunner = (
  command: string,
  args: string[]
) => Promise<ContainerRuntimeCommandResult>

export interface ContainerRuntimeFailure {
  reason: ContainerRuntimeReason
  command: string[]
  detail: string
}

export type ContainerRuntimeProbe =
  | { state: 'ready', mode: ContainerRuntimeMode, warnings: string[] }
  | { state: 'waiting', failure: ContainerRuntimeFailure }
  | { state: 'failed', failure: ContainerRuntimeFailure }

const BUILDX_FALLBACK_WARNING = 'Docker Buildx is unavailable; the Dev Containers CLI will use its classic-build fallback.'

async function runContainerRuntimeCommand (
  command: string,
  args: string[]
): Promise<ContainerRuntimeCommandResult> {
  return runBuffered(command, args, {
    mirrorStdout: false,
    mirrorStderr: false
  })
}

function compactCommandOutput (result: ContainerRuntimeCommandResult): string {
  const output = result.stderr.trim().length > 0 ? result.stderr : result.stdout
  const compact = output.trim().replace(/\s+/gu, ' ').slice(0, 500)
  return compact.length > 0 ? compact : `Command exited with code ${result.code}`
}

function failure (
  reason: ContainerRuntimeReason,
  command: string[],
  result: ContainerRuntimeCommandResult
): ContainerRuntimeFailure {
  return {
    reason,
    command,
    detail: compactCommandOutput(result)
  }
}

export async function probeContainerRuntime (
  runCommand: ContainerRuntimeCommandRunner = runContainerRuntimeCommand
): Promise<ContainerRuntimeProbe> {
  const dockerVersionCommand = ['docker', '--version']
  const dockerVersion = await runCommand(dockerVersionCommand[0] as string, dockerVersionCommand.slice(1))
  if (dockerVersion.code !== 0) {
    return {
      state: 'failed',
      failure: failure('docker-cli-unavailable', dockerVersionCommand, dockerVersion)
    }
  }

  const dockerInfoCommand = ['docker', 'info']
  const dockerInfo = await runCommand(dockerInfoCommand[0] as string, dockerInfoCommand.slice(1))
  if (dockerInfo.code !== 0) {
    return {
      state: 'waiting',
      failure: failure('docker-daemon-unavailable', dockerInfoCommand, dockerInfo)
    }
  }

  const buildxVersionCommand = ['docker', 'buildx', 'version']
  const buildxVersion = await runCommand(buildxVersionCommand[0] as string, buildxVersionCommand.slice(1))
  if (buildxVersion.code !== 0) {
    return {
      state: 'ready',
      mode: 'fallback',
      warnings: [BUILDX_FALLBACK_WARNING]
    }
  }

  const buildxInspectCommand = ['docker', 'buildx', 'inspect', '--bootstrap']
  const buildxInspect = await runCommand(buildxInspectCommand[0] as string, buildxInspectCommand.slice(1))
  if (buildxInspect.code !== 0) {
    return {
      state: 'waiting',
      failure: failure('buildx-builder-unavailable', buildxInspectCommand, buildxInspect)
    }
  }

  return { state: 'ready', mode: 'buildx', warnings: [] }
}
```

- [ ] **Step 4: Run the focused test and confirm all probe cases pass**

Run:

```sh
node --import tsx --test __tests__/container-runtime.test.ts
```

Expected: PASS with 5 tests.

- [ ] **Step 5: Commit the probe**

```sh
git add src/container-runtime.ts __tests__/container-runtime.test.ts
git commit -m "feat: probe container runtime readiness"
```

### Task 2: Add deterministic bounded waiting and readiness diagnostics

**Files:**

- Modify: `src/container-runtime.ts`
- Modify: `__tests__/container-runtime.test.ts`

**Interfaces:**

- Consumes: `probeContainerRuntime(runCommand?)` from Task 1.
- Produces: `ContainerRuntimeWaitResult`, `WaitForContainerRuntimeOptions`, `waitForContainerRuntime(options?)`, and `formatContainerRuntimeFailure(result, options?)`.
- `onTransition` fires for the first non-ready probe and only when `state` or `failure.reason` changes; repeated one-second attempts are silent.

- [ ] **Step 1: Add waiter tests using a fake clock and sleep**

Extend the import in `__tests__/container-runtime.test.ts`:

```ts
import {
  formatContainerRuntimeFailure,
  probeContainerRuntime,
  waitForContainerRuntime,
  type ContainerRuntimeCommandResult,
  type ContainerRuntimeCommandRunner,
  type ContainerRuntimeProbe
} from '../src/container-runtime.ts'
```

Add a helper that creates one complete probe attempt per supplied `docker info` result:

```ts
function daemonSequenceRunner (
  daemonResults: readonly ContainerRuntimeCommandResult[]
): ContainerRuntimeCommandRunner {
  let daemonIndex = 0
  return async (_command, args) => {
    if (args[0] === '--version' || args[0] === 'buildx') return ok
    if (args[0] === 'info') {
      const result = daemonResults[Math.min(daemonIndex, daemonResults.length - 1)]
      daemonIndex += 1
      assert.ok(result !== undefined)
      return result
    }
    assert.fail(`Unexpected args: ${args.join(' ')}`)
  }
}
```

Add these tests:

```ts
describe('container runtime waiter', () => {
  test('probes immediately and sleeps exactly once per transient retry', async () => {
    let now = 0
    const sleeps: number[] = []
    const result = await waitForContainerRuntime({
      runCommand: daemonSequenceRunner([
        { code: 1, stdout: '', stderr: 'starting one' },
        { code: 1, stdout: '', stderr: 'starting two' },
        ok
      ]),
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
      }
    })

    assert.deepStrictEqual(sleeps, [1_000, 1_000])
    assert.strictEqual(result.state, 'ready')
    assert.strictEqual(result.mode, 'buildx')
  })

  test('does not sleep after a terminal failure', async () => {
    const sleeps: number[] = []
    const result = await waitForContainerRuntime({
      runCommand: runnerFrom([{ code: 127, stdout: '', stderr: 'ENOENT' }], []),
      sleep: async (milliseconds) => { sleeps.push(milliseconds) }
    })

    assert.deepStrictEqual(sleeps, [])
    assert.strictEqual(result.state, 'failed')
    assert.strictEqual(result.timedOut, false)
  })

  test('stops at the deadline and retains the final probe', async () => {
    let now = 0
    const result = await waitForContainerRuntime({
      runCommand: daemonSequenceRunner([
        { code: 1, stdout: '', stderr: 'first diagnostic' },
        { code: 1, stdout: '', stderr: 'last diagnostic' }
      ]),
      timeoutMs: 1_000,
      pollIntervalMs: 1_000,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds }
    })

    assert.strictEqual(result.state, 'failed')
    assert.strictEqual(result.timedOut, true)
    assert.strictEqual(result.timeoutMs, 1_000)
    assert.strictEqual(result.failure.detail, 'last diagnostic')
  })

  test('emits only state and reason transitions', async () => {
    let now = 0
    const transitions: ContainerRuntimeProbe[] = []
    const result = await waitForContainerRuntime({
      runCommand: daemonSequenceRunner([
        { code: 1, stdout: '', stderr: 'first' },
        { code: 1, stdout: '', stderr: 'changed output' },
        ok
      ]),
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
      onTransition: (probe) => { transitions.push(probe) }
    })

    assert.strictEqual(result.state, 'ready')
    assert.strictEqual(transitions.length, 1)
    assert.strictEqual(transitions[0]?.state, 'waiting')
  })

  test('formats timeout, manual check, detail, and optional log path', async () => {
    const result = await waitForContainerRuntime({
      runCommand: daemonSequenceRunner([{ code: 1, stdout: '', stderr: 'Cannot connect' }]),
      timeoutMs: 0,
      now: () => 0
    })
    assert.strictEqual(result.state, 'failed')

    const message = formatContainerRuntimeFailure(result, { logPath: '/tmp/boxdown.log' })
    assert.match(message, /Docker daemon did not become ready within 0 seconds\./)
    assert.match(message, /Last check: docker info/)
    assert.match(message, /Detail: Cannot connect/)
    assert.match(message, /Check Docker with: docker info/)
    assert.match(message, /Command log: \/tmp\/boxdown\.log/)
  })
})
```

- [ ] **Step 2: Run the tests and confirm waiter exports are missing**

Run:

```sh
node --import tsx --test __tests__/container-runtime.test.ts
```

Expected: FAIL because `waitForContainerRuntime` and `formatContainerRuntimeFailure` are not exported.

- [ ] **Step 3: Implement bounded waiting and transition deduplication**

Append these types and functions to `src/container-runtime.ts`:

```ts
export type ContainerRuntimeWaitResult =
  | { state: 'ready', mode: ContainerRuntimeMode, warnings: string[] }
  | {
      state: 'failed'
      failure: ContainerRuntimeFailure
      timedOut: boolean
      timeoutMs: number
    }

export interface WaitForContainerRuntimeOptions {
  runCommand?: ContainerRuntimeCommandRunner
  timeoutMs?: number
  pollIntervalMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  onTransition?: (probe: ContainerRuntimeProbe) => void
}

function defaultSleep (milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function transitionKey (probe: ContainerRuntimeProbe): string {
  return probe.state === 'ready' ? 'ready' : `${probe.state}:${probe.failure.reason}`
}

export async function waitForContainerRuntime (
  options: WaitForContainerRuntimeOptions = {}
): Promise<ContainerRuntimeWaitResult> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const deadline = now() + timeoutMs
  let lastTransition: string | undefined

  while (true) {
    const probe = await probeContainerRuntime(options.runCommand)

    if (probe.state === 'ready') return probe

    const currentTransition = transitionKey(probe)
    if (currentTransition !== lastTransition) {
      options.onTransition?.(probe)
      lastTransition = currentTransition
    }

    if (probe.state === 'failed') {
      return { state: 'failed', failure: probe.failure, timedOut: false, timeoutMs }
    }

    const remainingMs = deadline - now()
    if (remainingMs <= 0) {
      return { state: 'failed', failure: probe.failure, timedOut: true, timeoutMs }
    }

    await sleep(Math.min(pollIntervalMs, remainingMs))
  }
}
```

- [ ] **Step 4: Implement readiness failure formatting**

Append this code to `src/container-runtime.ts`:

```ts
function commandText (command: readonly string[]): string {
  return command.join(' ')
}

export function formatContainerRuntimeFailure (
  result: Extract<ContainerRuntimeWaitResult, { state: 'failed' }>,
  options: { logPath?: string } = {}
): string {
  const seconds = result.timeoutMs / 1_000
  const descriptions: Record<ContainerRuntimeReason, string> = {
    'docker-cli-unavailable': 'Docker CLI is required but was not available.',
    'docker-daemon-unavailable': result.timedOut
      ? `Docker daemon did not become ready within ${seconds} seconds.`
      : 'Docker daemon is required but was not reachable.',
    'buildx-builder-unavailable': result.timedOut
      ? `Docker Buildx builder did not become ready within ${seconds} seconds.`
      : 'Docker Buildx builder was not operational.'
  }
  const manualCheck = result.failure.reason === 'buildx-builder-unavailable'
    ? 'docker buildx inspect'
    : result.failure.reason === 'docker-daemon-unavailable'
      ? 'docker info'
      : 'docker --version'
  const lines = [
    descriptions[result.failure.reason],
    `Last check: ${commandText(result.failure.command)}`,
    `Detail: ${result.failure.detail}`,
    `Check ${result.failure.reason === 'buildx-builder-unavailable' ? 'Buildx' : 'Docker'} with: ${manualCheck}`
  ]

  if (options.logPath !== undefined) lines.push(`Command log: ${options.logPath}`)
  return lines.join('\n')
}
```

- [ ] **Step 5: Run focused tests and static checks**

Run:

```sh
node --import tsx --test __tests__/container-runtime.test.ts
pnpm lint
pnpm build
```

Expected: all commands exit 0; the focused file reports 10 passing tests.

- [ ] **Step 6: Commit the waiter**

```sh
git add src/container-runtime.ts __tests__/container-runtime.test.ts
git commit -m "feat: wait for container runtime readiness"
```

### Task 3: Make doctor reuse the one-shot readiness probe

**Files:**

- Modify: `src/doctor.ts:12-32,186-211`
- Modify: `__tests__/app.test.ts:2883-3090`

**Interfaces:**

- Consumes: `probeContainerRuntime(runCommand)` and `ContainerRuntimeCommandRunner` from Task 1.
- Produces: `RunDoctorChecksOptions.containerRuntimeReady?: boolean`; default `false`. Setup sets it only after the shared waiter succeeds, avoiding duplicate Docker/Buildx status commands while retaining the Docker bind-mount probe.
- Doctor remains a snapshot: it calls the probe once and never calls `waitForContainerRuntime`.

- [ ] **Step 1: Add doctor tests for Buildx readiness, fallback, and broken builders**

In the existing `describe('doctor', ...)` block in `__tests__/app.test.ts`, add:

```ts
test('doctor reports Buildx readiness from the shared runtime probe', async () => {
  const context = createWorkspaceContext({
    workspace: tempDir('doctor-buildx-ready-workspace'),
    env: { BOXDOWN_CACHE_HOME: tempDir('doctor-buildx-ready-cache'), BOXDOWN_DATA_HOME: tempDir('doctor-buildx-ready-data') },
    assetsDevcontainerDir
  })
  const calls: string[] = []
  const checks = await runDoctorChecks(context, {
    includeOptional: false,
    includeDockerMountProbe: false,
    runCommand: async (command, args) => {
      calls.push([command, ...args].join(' '))
      return { code: 0, stdout: '', stderr: '' }
    }
  })

  assert.ok(calls.includes('docker buildx inspect --bootstrap'))
  assert.deepStrictEqual(checks.find((check) => check.name === 'docker-buildx'), {
    name: 'docker-buildx',
    level: 'ok',
    message: 'Docker Buildx builder is operational'
  })
})

test('doctor warns when the Dev Containers fallback will be used', async () => {
  const context = createWorkspaceContext({
    workspace: tempDir('doctor-buildx-fallback-workspace'),
    env: { BOXDOWN_CACHE_HOME: tempDir('doctor-buildx-fallback-cache'), BOXDOWN_DATA_HOME: tempDir('doctor-buildx-fallback-data') },
    assetsDevcontainerDir
  })
  const checks = await runDoctorChecks(context, {
    includeOptional: false,
    includeDockerMountProbe: false,
    runCommand: async (command, args) => ({
      code: command === 'docker' && args.join(' ') === 'buildx version' ? 1 : 0,
      stdout: '',
      stderr: command === 'docker' && args.join(' ') === 'buildx version' ? 'unknown command: buildx' : ''
    })
  })

  const buildx = checks.find((check) => check.name === 'docker-buildx')
  assert.strictEqual(buildx?.level, 'warn')
  assert.match(buildx?.message ?? '', /classic-build fallback/)
})

test('doctor fails a discoverable but unusable Buildx builder', async () => {
  const context = createWorkspaceContext({
    workspace: tempDir('doctor-buildx-failed-workspace'),
    env: { BOXDOWN_CACHE_HOME: tempDir('doctor-buildx-failed-cache'), BOXDOWN_DATA_HOME: tempDir('doctor-buildx-failed-data') },
    assetsDevcontainerDir
  })
  const checks = await runDoctorChecks(context, {
    includeOptional: false,
    includeDockerMountProbe: false,
    runCommand: async (command, args) => ({
      code: command === 'docker' && args.join(' ') === 'buildx inspect --bootstrap' ? 1 : 0,
      stdout: '',
      stderr: command === 'docker' && args.join(' ') === 'buildx inspect --bootstrap' ? 'builder is starting' : ''
    })
  })

  assert.deepStrictEqual(checks.find((check) => check.name === 'docker-buildx'), {
    name: 'docker-buildx',
    level: 'fail',
    message: 'Docker Buildx builder was not operational: builder is starting'
  })
})

test('doctor accepts prevalidated runtime status and retains the bind-mount probe', async () => {
  const context = createWorkspaceContext({
    workspace: tempDir('doctor-prevalidated-runtime-workspace'),
    env: { BOXDOWN_CACHE_HOME: tempDir('doctor-prevalidated-runtime-cache'), BOXDOWN_DATA_HOME: tempDir('doctor-prevalidated-runtime-data') },
    assetsDevcontainerDir
  })
  const calls: string[] = []
  let container = 0
  const checks = await runDoctorChecks(context, {
    includeOptional: false,
    containerRuntimeReady: true,
    runCommand: async (command, args) => {
      calls.push([command, ...args].join(' '))
      if (command === 'docker' && args[0] === 'image') return { code: 0, stdout: 'node:24\n', stderr: '' }
      if (command === 'docker' && args[0] === 'create') {
        container += 1
        return { code: 0, stdout: `probe-${container}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
  })

  assert.ok(!calls.includes('docker --version'))
  assert.ok(!calls.includes('docker info'))
  assert.ok(!calls.includes('docker buildx version'))
  assert.ok(calls.includes('docker image ls --format {{.Repository}}:{{.Tag}}'))
  assert.strictEqual(checks.find((check) => check.name === 'docker-bind-mounts')?.level, 'ok')
})
```

- [ ] **Step 2: Run the doctor tests and confirm the Buildx check is absent**

Run:

```sh
node --import tsx --test --test-name-pattern="doctor .*Buildx" __tests__/app.test.ts
```

Expected: FAIL because no `docker-buildx` check exists.

- [ ] **Step 3: Replace the doctor command-result aliases and add the skip option**

At the top of `src/doctor.ts`, add:

```ts
import {
  probeContainerRuntime,
  type ContainerRuntimeCommandResult,
  type ContainerRuntimeCommandRunner
} from './container-runtime.ts'
```

Replace the duplicate doctor command interfaces with aliases and extend the options:

```ts
export type DoctorCommandResult = ContainerRuntimeCommandResult
export type DoctorCommandRunner = ContainerRuntimeCommandRunner

export interface RunDoctorChecksOptions {
  includeOptional?: boolean
  includeDockerMountProbe?: boolean
  containerRuntimeReady?: boolean
  runCommand?: DoctorCommandRunner
}
```

- [ ] **Step 4: Replace the separate Docker checks with probe-to-check mapping**

In `runDoctorChecks`, replace the existing `docker --version` and `docker info` block with:

```ts
  let dockerCliWorks = options.containerRuntimeReady === true
  let dockerDaemonWorks = options.containerRuntimeReady === true

  if (options.containerRuntimeReady !== true) {
    const runtime = await probeContainerRuntime(runCommand)
    dockerCliWorks = runtime.state === 'ready' || runtime.failure.reason !== 'docker-cli-unavailable'
    dockerDaemonWorks = runtime.state === 'ready' ||
      (runtime.state === 'waiting' && runtime.failure.reason === 'buildx-builder-unavailable')

    checks.push(check(
      'docker-cli',
      dockerCliWorks,
      'Docker CLI is available',
      'Docker CLI is required but was not available'
    ))
    checks.push(check(
      'docker-daemon',
      dockerDaemonWorks,
      'Docker daemon is reachable',
      'Docker daemon is required but was not reachable'
    ))

    if (!dockerCliWorks || !dockerDaemonWorks) {
      checks.push({
        name: 'docker-buildx',
        level: 'warn',
        message: 'Docker Buildx was not checked because the Docker runtime is unavailable'
      })
    } else if (runtime.state === 'ready' && runtime.mode === 'fallback') {
      checks.push({ name: 'docker-buildx', level: 'warn', message: runtime.warnings[0] as string })
    } else if (runtime.state === 'waiting') {
      checks.push({
        name: 'docker-buildx',
        level: 'fail',
        message: `Docker Buildx builder was not operational: ${runtime.failure.detail}`
      })
    } else {
      checks.push({ name: 'docker-buildx', level: 'ok', message: 'Docker Buildx builder is operational' })
    }
  }
```

Keep the Docker bind-mount probe independently controlled. Because setup sets `dockerCliWorks` and `dockerDaemonWorks` from its successful waiter, it still exercises the required mount check without repeating Docker/Buildx status commands:

```ts
  if (options.includeDockerMountProbe ?? true) {
    checks.push(await checkDockerBindMounts(context, runCommand, dockerCliWorks && dockerDaemonWorks))
  }
```

- [ ] **Step 5: Run doctor and full unit tests**

Run:

```sh
node --import tsx --test --test-name-pattern="doctor" __tests__/app.test.ts
pnpm test
```

Expected: both commands exit 0. Update only existing assertions that intentionally enumerate doctor command calls or check names; do not weaken level/message assertions.

- [ ] **Step 6: Commit doctor integration**

```sh
git add src/doctor.ts __tests__/app.test.ts
git commit -m "feat: report Buildx readiness in doctor"
```

### Task 4: Gate every container-creating CLI lifecycle before metadata

**Files:**

- Modify: `src/main.ts:1-65,502-526,1060-1125,1218-1515`
- Modify: `src/progress.ts:125-175`
- Modify: `__tests__/app.test.ts:1105-1215` and the command-classification tests near `commandWritesWorkspaceMetadata`

**Interfaces:**

- Consumes: `waitForContainerRuntime(options?)`, `formatContainerRuntimeFailure(result, options?)`, and `WorkspaceCommandLogger`.
- Produces: `commandRequiresContainerRuntime(command: BoxdownCommand): boolean`, `ProgressReporter.status(message: string): void`, `RunCliOptions.waitForContainerRuntime?: typeof waitForContainerRuntime`, `RunCliOptions.writeWorkspaceMetadata?: (context: WorkspaceContext, alias: string) => void`, `runContainerRuntimePreflight(context, progress, options, logger?)`, and `prepareContainerLifecycle(context, alias, progress, options, logger?)`.
- Every gated non-setup branch must execute `prepareContainerLifecycle`, which waits first and writes metadata second, before its first state-generating or container action.

- [ ] **Step 1: Add table-driven command-scope tests**

Import `commandRequiresContainerRuntime` from `src/main.ts` in `__tests__/app.test.ts`, then add beside the metadata classification tests:

```ts
test('container runtime readiness scope is explicit for every command', () => {
  const expected = new Map<BoxdownCommand, boolean>([
    ['help', false],
    ['version', false],
    ['setup', true],
    ['start', true],
    ['list', false],
    ['status', false],
    ['stop', false],
    ['down', false],
    ['purge', false],
    ['doctor', false],
    ['ssh-install', false],
    ['ssh-uninstall', false],
    ['ssh-proxy', true],
    ['tunnel', true],
    ['refresh-gh-token', true],
    ['refresh-gh-token-running', false],
    ['coding-agent', true]
  ])

  for (const [command, waits] of expected) {
    assert.strictEqual(commandRequiresContainerRuntime(command), waits, command)
  }
})
```

- [ ] **Step 2: Add setup ordering tests**

Extend the existing setup-preflight failure test so its injected waiter records `runtime`, returns a terminal failure, and verifies the doctor and setup action were not called:

```ts
const calls: string[] = []
const code = await runCli(['setup', '--workspace', workspace], {
  env: { CI: '1' },
  waitForContainerRuntime: async () => {
    calls.push('runtime')
    return {
      state: 'failed',
      failure: {
        reason: 'docker-daemon-unavailable',
        command: ['docker', 'info'],
        detail: 'Cannot connect'
      },
      timedOut: true,
      timeoutMs: 60_000
    }
  },
  runDoctorChecks: async () => {
    calls.push('doctor')
    return []
  },
  setupWorkspace: async () => { calls.push('setup') }
})

assert.strictEqual(code, 1)
assert.deepStrictEqual(calls, ['runtime'])
assert.strictEqual(existsSync(context.workspaceDataDir), false)
assert.strictEqual(existsSync(context.generatedConfigPath), false)
assert.strictEqual(existsSync(context.sshKeyPath), false)
```

- [ ] **Step 3: Run the new CLI tests and confirm the classification/injection is absent**

Run:

```sh
node --import tsx --test --test-name-pattern="container runtime readiness scope|setup preflight" __tests__/app.test.ts
```

Expected: FAIL because the classifier and waiter injection do not exist.

- [ ] **Step 4: Add the command classifier and waiter injection**

Add imports to `src/main.ts`:

```ts
import {
  formatContainerRuntimeFailure,
  waitForContainerRuntime,
  type ContainerRuntimeProbe
} from './container-runtime.ts'
import { runBuffered } from './process.ts'
```

Extend `RunCliOptions`:

```ts
export interface RunCliOptions {
  promptInput?: PromptInput
  promptOutput?: PromptOutput
  env?: NodeJS.ProcessEnv
  runDoctorChecks?: typeof runDoctorChecks
  setupWorkspace?: typeof setupWorkspace
  waitForContainerRuntime?: typeof waitForContainerRuntime
  writeWorkspaceMetadata?: (context: WorkspaceContext, alias: string) => void
}
```

Add the exhaustive classifier next to `commandWritesWorkspaceMetadata`:

```ts
export function commandRequiresContainerRuntime (command: BoxdownCommand): boolean {
  return command === 'setup' ||
    command === 'start' ||
    command === 'ssh-proxy' ||
    command === 'tunnel' ||
    command === 'refresh-gh-token' ||
    command === 'coding-agent'
}
```

- [ ] **Step 5: Add mode-aware readiness status output**

Add this public method after `detail` in `ProgressReporter` in `src/progress.ts`:

```ts
  status (message: string): void {
    if (this.mode === 'none') return
    if (this.mode === 'verbose') {
      this.#write(this.target, message)
      return
    }
    this.detail(message)
  }
```

Add a progress test in `__tests__/app.test.ts`:

```ts
test('progress status is visible once in interactive and verbose modes', () => {
  const interactiveLines: string[] = []
  const verboseLines: string[] = []
  createProgress({ mode: 'interactive', write: (_target, message) => interactiveLines.push(message) })
    .status('Waiting for Docker daemon')
  createProgress({ mode: 'verbose', write: (_target, message) => verboseLines.push(message) })
    .status('Waiting for Docker daemon')

  assert.strictEqual(interactiveLines.length, 1)
  assert.deepStrictEqual(verboseLines, ['Waiting for Docker daemon'])
})
```

- [ ] **Step 6: Implement the shared CLI preflight adapter**

Add beside `runSetupPreflight` in `src/main.ts`:

```ts
function runtimeTransitionMessage (probe: ContainerRuntimeProbe): string | undefined {
  if (probe.state === 'waiting' && probe.failure.reason === 'docker-daemon-unavailable') {
    return 'Waiting for Docker daemon'
  }
  if (probe.state === 'waiting' && probe.failure.reason === 'buildx-builder-unavailable') {
    return 'Waiting for Docker Buildx builder'
  }
  return undefined
}

export async function runContainerRuntimePreflight (
  context: WorkspaceContext,
  progress: ProgressReporter,
  options: RunCliOptions,
  logger?: WorkspaceCommandLogger
): Promise<void> {
  const wait = options.waitForContainerRuntime ?? waitForContainerRuntime
  progress.startStep('container-runtime')
  const result = await wait({
    runCommand: async (command, args) => runBuffered(command, args, {
      env: options.env,
      logger,
      mirrorStdout: false,
      mirrorStderr: false
    }),
    onTransition: (probe) => {
      const message = runtimeTransitionMessage(probe)
      if (message !== undefined) progress.status(message)
    }
  })

  if (result.state === 'failed') {
    progress.failStep('container-runtime')
    throw new Error(formatContainerRuntimeFailure(result, {
      logPath: logger === undefined ? undefined : context.workspaceLogPath
    }))
  }

  for (const warning of result.warnings) progress.warn(warning)
  progress.completeStep('container-runtime')
}

export async function prepareContainerLifecycle (
  context: WorkspaceContext,
  alias: string,
  progress: ProgressReporter,
  options: RunCliOptions,
  logger?: WorkspaceCommandLogger
): Promise<void> {
  await runContainerRuntimePreflight(context, progress, options, logger)
  const writeMetadata = options.writeWorkspaceMetadata ?? writeWorkspaceMetadata
  writeMetadata(context, alias)
}
```

- [ ] **Step 7: Test readiness/metadata ordering and recovery without Docker**

Import `prepareContainerLifecycle` from `src/main.ts` and `workspaceMetadataPath` from `src/metadata.ts` in `__tests__/app.test.ts`, then add:

```ts
test('container lifecycle writes metadata only after readiness succeeds', async () => {
  const context = createWorkspaceContext({
    workspace: tempDir('container-lifecycle-order-workspace'),
    env: { BOXDOWN_CACHE_HOME: tempDir('container-lifecycle-order-cache'), BOXDOWN_DATA_HOME: tempDir('container-lifecycle-order-data') },
    assetsDevcontainerDir
  })
  const progress = createProgress({ mode: 'none' })
  progress.setSteps([{ id: 'container-runtime', label: 'Checking container runtime' }])
  const calls: string[] = []

  await prepareContainerLifecycle(context, 'boxdown-order', progress, {
    waitForContainerRuntime: async () => {
      calls.push('runtime')
      return { state: 'ready', mode: 'buildx', warnings: [] }
    },
    writeWorkspaceMetadata: () => { calls.push('metadata') }
  })

  assert.deepStrictEqual(calls, ['runtime', 'metadata'])
})

test('a readiness failure leaves no state and a later attempt decides afresh', async () => {
  const context = createWorkspaceContext({
    workspace: tempDir('container-lifecycle-recovery-workspace'),
    env: { BOXDOWN_CACHE_HOME: tempDir('container-lifecycle-recovery-cache'), BOXDOWN_DATA_HOME: tempDir('container-lifecycle-recovery-data') },
    assetsDevcontainerDir
  })
  const progress = createProgress({ mode: 'none' })
  progress.setSteps([{ id: 'container-runtime', label: 'Checking container runtime' }])
  const calls: string[] = []

  await assert.rejects(prepareContainerLifecycle(context, 'boxdown-recovery', progress, {
    waitForContainerRuntime: async () => ({
      state: 'failed',
      failure: { reason: 'docker-daemon-unavailable', command: ['docker', 'info'], detail: 'starting' },
      timedOut: true,
      timeoutMs: 60_000
    }),
    writeWorkspaceMetadata: () => { calls.push('unexpected metadata') }
  }), /Docker daemon did not become ready/)

  assert.deepStrictEqual(calls, [])
  assert.strictEqual(existsSync(workspaceMetadataPath(context)), false)
  assert.strictEqual(existsSync(context.generatedConfigPath), false)
  assert.strictEqual(existsSync(context.sshKeyPath), false)

  progress.setSteps([{ id: 'container-runtime', label: 'Checking container runtime' }])
  await prepareContainerLifecycle(context, 'boxdown-recovery', progress, {
    waitForContainerRuntime: async () => {
      calls.push('fresh runtime')
      return { state: 'ready', mode: 'buildx', warnings: [] }
    },
    writeWorkspaceMetadata: () => { calls.push('metadata') }
  })

  assert.deepStrictEqual(calls, ['fresh runtime', 'metadata'])
})
```

- [ ] **Step 8: Split setup and bring-up progress lists so readiness appears exactly once**

Replace the progress-step helpers in `src/main.ts` with:

```ts
function devcontainerStartProgressSteps (): ProgressStepDefinition[] {
  return [
    { id: 'ssh-identity', label: 'Preparing SSH identity' },
    { id: 'devcontainer-config', label: 'Writing generated devcontainer config' },
    { id: 'devcontainer-start', label: 'Starting devcontainer' }
  ]
}

function startProgressSteps (): ProgressStepDefinition[] {
  return [
    { id: 'container-runtime', label: 'Checking container runtime' },
    ...devcontainerStartProgressSteps()
  ]
}

function setupProgressSteps (targets: readonly SshConfigInstallTarget[]): ProgressStepDefinition[] {
  return [
    ...devcontainerStartProgressSteps(),
    { id: 'ssh-alias', label: 'Installing SSH alias' },
    ...targets.map((target) => ({
      id: `ssh-target:${target}`,
      label: sshTargetProgressLabel(target)
    }))
  ]
}

function setupPreflightProgressSteps (): ProgressStepDefinition[] {
  return [
    { id: 'container-runtime', label: 'Checking container runtime' },
    { id: 'setup-preflight', label: 'Checking host readiness' }
  ]
}
```

- [ ] **Step 9: Put setup readiness before doctor, prompts, and state**

In `runSetupPreflight`, call readiness immediately after `setSteps`, then run doctor without a duplicate runtime probe:

```ts
    progress.setSteps(setupPreflightProgressSteps())
    await runContainerRuntimePreflight(context, progress, options)
    progress.startStep('setup-preflight')
    const checks = await doctor(context, {
      includeOptional: false,
      containerRuntimeReady: true
    })
```

Leave `resolveSshInstallTargets`, `writeWorkspaceMetadata`, and `setupWorkspace` after `runSetupPreflight` in `runCli`. This retains the state-free setup failure contract.

Update the existing setup-warning test to inject a ready waiter so it remains independent of the host Docker daemon:

```ts
waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] })
```

- [ ] **Step 10: Move metadata into each gated non-setup branch after readiness**

Delete the early generic metadata block near the start of `runCli`:

```ts
    if (parsed.command !== 'ssh-install' && parsed.command !== 'setup' && parsed.command !== 'tunnel' && commandWritesWorkspaceMetadata(parsed.command)) {
      writeWorkspaceMetadata(context, alias)
    }
```

In each gated branch, insert the same line immediately after `progress.setSteps(...)` and before SSH configuration, `startDevcontainer`, generated config, or identity work:

```ts
          await prepareContainerLifecycle(context, alias, progress, options, logger)
```

The exact insertion points are:

- `ssh-proxy`: after `progress.setSteps(sshProxyProgressSteps())`, before `progress.startStep('ssh-alias')`.
- `tunnel`: after `progress.setSteps(tunnelProgressSteps())`, before `progress.startStep('ssh-alias')`; delete the earlier `writeWorkspaceMetadata(context, alias)` before `runLoggedLifecycle`.
- `refresh-gh-token`: after `progress.setSteps(ghAuthProgressSteps(true))`, before `startDevcontainer`.
- `coding-agent`: after `progress.setSteps(codingAgentProgressSteps(agent))`, before `startDevcontainer`.
- default `start`/`shell`: after `progress.setSteps(startProgressSteps())`, before `startDevcontainer`.

Do not add either line to `refresh-gh-token-running`. Leave `ssh install`'s explicit metadata write unchanged because it is an SSH-only inventory operation, not a container bring-up.

- [ ] **Step 11: Add structural ordering and exclusion assertions**

Add a source-level regression test beside the existing helper-source assertions. It is intentionally narrow: it protects the central ordering without trying to launch Docker.

```ts
test('gated lifecycle branches run readiness before metadata and container start', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8')
  const gatedInsert = 'await prepareContainerLifecycle(context, alias, progress, options, logger)'

  assert.strictEqual(source.split(gatedInsert).length - 1, 5)
  const runningBranch = source.slice(
    source.indexOf("if (parsed.command === 'refresh-gh-token-running')"),
    source.indexOf("if (parsed.command === 'refresh-gh-token')")
  )
  assert.doesNotMatch(runningBranch, /prepareContainerLifecycle|runContainerRuntimePreflight|writeWorkspaceMetadata/)
})
```

Keep the runtime-failure setup assertion from Step 2 and the direct ordering/recovery assertions from Step 7. Together they prove setup is state-free, non-setup metadata follows readiness, and an earlier failure does not create a persistent setup prerequisite.

- [ ] **Step 12: Verify CLI lifecycle behavior**

Run:

```sh
node --import tsx --test --test-name-pattern="container runtime|setup preflight|later attempt|gated lifecycle" __tests__/app.test.ts
pnpm test
pnpm lint
pnpm build
```

Expected: all commands exit 0. No test invokes real Docker or waits for real time.

- [ ] **Step 13: Commit lifecycle gating**

```sh
git add src/main.ts src/progress.ts __tests__/app.test.ts
git commit -m "fix: gate container lifecycles on runtime readiness"
```

### Task 5: Preserve useful Dev Containers diagnostics and log paths

**Files:**

- Modify: `src/progress.ts:508-594`
- Modify: `src/devcontainer.ts:391,506,593`
- Modify: `__tests__/app.test.ts:3560-3745`

**Interfaces:**

- Consumes: existing `CommandResult` and `WorkspaceContext.workspaceLogPath`.
- Produces: `CommandFailureOptions { tailLines?: number, logPath?: string }`; `formatCommandFailure` and `assertProgressCommandSucceeded` both accept it.
- A JSON line is a Dev Containers wrapper only when it parses to an object whose `outcome` is `error` and whose `message` is a string.

- [ ] **Step 1: Add concise failure-formatting regression tests**

Add to the progress/failure describe block in `__tests__/app.test.ts`:

```ts
test('zero failure-tail budget emits no output tails', () => {
  const message = formatCommandFailure('demo', {
    code: 1,
    stdout: 'stdout detail\n',
    stderr: 'stderr detail\n'
  }, { tailLines: 0 })

  assert.doesNotMatch(message, /stdout tail|stderr tail|stdout detail|stderr detail/)
})

test('specific stderr wins over a generic Dev Containers wrapper', () => {
  const wrapper = JSON.stringify({
    outcome: 'error',
    message: 'Command failed: docker buildx build --load',
    description: 'An error occurred setting up the container.'
  })
  const message = formatCommandFailure('devcontainer up', {
    code: 1,
    stdout: `${wrapper}\n`,
    stderr: 'failed to solve: registry authentication failed\n'
  }, { logPath: '/tmp/workspace/boxdown.log' })

  assert.match(message, /registry authentication failed/)
  assert.doesNotMatch(message, /docker buildx build --load/)
  assert.match(message, /Command log: \/tmp\/workspace\/boxdown\.log/)
})

test('wrapper-only failures explain the missing nested diagnostic', () => {
  const wrapper = JSON.stringify({
    outcome: 'error',
    message: 'Command failed: docker buildx build --load',
    description: 'An error occurred setting up the container.'
  })
  const message = formatCommandFailure('devcontainer up', {
    code: 1,
    stdout: `${wrapper}\n`,
    stderr: ''
  })

  assert.match(message, /nested command failure without diagnostic output/)
  assert.doesNotMatch(message, /docker buildx build --load/)
})
```

- [ ] **Step 2: Run the formatting tests and confirm current behavior fails**

Run:

```sh
node --import tsx --test --test-name-pattern="zero failure-tail|generic Dev Containers wrapper|wrapper-only" __tests__/app.test.ts
```

Expected: FAIL because `.slice(-0)` returns all lines, wrapper JSON is printed, and no log path is supported.

- [ ] **Step 3: Replace tail selection and wrapper detection**

In `src/progress.ts`, replace `tailLines` and `formatCommandFailure` with:

```ts
export interface CommandFailureOptions {
  tailLines?: number
  logPath?: string
}

function outputLines (output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
}

function tailLines (output: string, maxLines: number): string[] {
  if (maxLines <= 0) return []
  return outputLines(output).slice(-maxLines)
}

function isDevcontainerErrorEnvelope (line: string): boolean {
  try {
    const value = JSON.parse(line) as { outcome?: unknown, message?: unknown }
    return value !== null && typeof value === 'object' &&
      value.outcome === 'error' && typeof value.message === 'string'
  } catch {
    return false
  }
}

export function formatCommandFailure (
  label: string,
  result: CommandResult,
  options: CommandFailureOptions = {}
): string {
  const maxLines = options.tailLines ?? DEFAULT_FAILURE_TAIL_LINES
  const stderrTail = tailLines(outputWithoutProgressMarkers(result.stderr), maxLines)
  const stdoutLines = outputLines(outputWithoutProgressMarkers(result.stdout))
  const wrapperPresent = stdoutLines.some(isDevcontainerErrorEnvelope)
  const specificStdout = stdoutLines.filter((line) => !isDevcontainerErrorEnvelope(line))
  const stdoutBudget = Math.max(0, maxLines - stderrTail.length)
  const stdoutTail = stdoutBudget === 0 ? [] : specificStdout.slice(-stdoutBudget)
  const lines = [
    `${label} failed with exit code ${result.code}.`,
    'Rerun with --verbose to see full command output.'
  ]

  if (stderrTail.length > 0) lines.push('', 'stderr tail:', ...stderrTail.map((line) => `  ${line}`))
  if (stdoutTail.length > 0) lines.push('', 'stdout tail:', ...stdoutTail.map((line) => `  ${line}`))
  if (wrapperPresent && stderrTail.length === 0 && stdoutTail.length === 0) {
    lines.push('', 'The Dev Containers CLI reported a nested command failure without diagnostic output.')
  }
  if (options.logPath !== undefined) lines.push('', `Command log: ${options.logPath}`)

  return lines.join('\n')
}
```

- [ ] **Step 4: Forward formatting options from command assertions**

Replace `assertProgressCommandSucceeded` with:

```ts
export function assertProgressCommandSucceeded (
  label: string,
  result: CommandResult,
  message: string,
  options: CommandFailureOptions = {}
): void {
  if (result.code !== 0) {
    throw new Error(`${message}\n${formatCommandFailure(label, result, options)}`)
  }
}
```

- [ ] **Step 5: Attach the workspace log to all logged devcontainer helper failures**

Change the three progress-mode assertions in `src/devcontainer.ts` to pass the same fourth argument:

```ts
{ logPath: context.workspaceLogPath }
```

For example, the bring-up assertion becomes:

```ts
assertProgressCommandSucceeded(
  'devcontainer up',
  result,
  `devcontainer up failed for ${context.workspaceFolder}`,
  { logPath: context.workspaceLogPath }
)
```

Apply the same formatting to `prepare SSH runtime` and `prepare ${codingAgentBinary(agent)}`. Do not change the non-progress branches in this task.

- [ ] **Step 6: Assert a post-readiness Dev Containers failure is not retried**

Add a source-boundary test in `__tests__/app.test.ts`:

```ts
test('devcontainer up remains a single-attempt operation', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/devcontainer.ts', import.meta.url)), 'utf8')
  const start = source.indexOf('export async function startDevcontainer')
  const end = source.indexOf('export async function printPortHint')
  const implementation = source.slice(start, end)

  assert.strictEqual(implementation.match(/runProgressCommand\('devcontainer up'/g)?.length, 1)
  assert.doesNotMatch(implementation, /retry|waitForContainerRuntime/)
})
```

- [ ] **Step 7: Run formatting, logging, and full verification tests**

Run:

```sh
node --import tsx --test --test-name-pattern="failure-tail|Dev Containers wrapper|wrapper-only|single-attempt|command logging" __tests__/app.test.ts
pnpm test
pnpm lint
pnpm build
```

Expected: all commands exit 0. The existing redaction test still proves secrets are absent from the managed log.

- [ ] **Step 8: Commit failure reporting**

```sh
git add src/progress.ts src/devcontainer.ts __tests__/app.test.ts
git commit -m "fix: surface actionable devcontainer failures"
```

### Task 6: Document lifecycle recovery and run release-quality verification

**Files:**

- Modify: `README.md:164-190`
- Modify: `docs/features/setup.md`
- Modify: `docs/features/start-and-shell.md`
- Modify: `docs/features/lifecycle.md`

**Interfaces:**

- Consumes: the final CLI behavior from Tasks 1-5.
- Produces: user-facing lifecycle guarantees and troubleshooting commands; no code interface.

- [ ] **Step 1: Update the README readiness section**

Add this text to the README near the setup/start workflow:

```markdown
`boxdown start` is standalone: it can create or reuse the devcontainer even if
`boxdown setup` was skipped or its preflight failed. Setup-only SSH aliases and
Codex/Claude application integrations are still installed only by `setup`.

Before a command creates or starts a container, Boxdown waits up to 60 seconds
for the Docker daemon and the selected Docker Buildx builder. If Buildx is not
installed, the bundled Dev Containers CLI uses its supported classic-build
fallback and Boxdown continues with a warning. Boxdown does not retry an actual
Dev Containers build failure.
```

- [ ] **Step 2: Update setup and start feature pages**

Add this contract to `docs/features/setup.md`:

```markdown
Setup readiness runs before prompts or workspace state is written. A missing
Docker CLI fails immediately; a starting Docker daemon or discoverable Buildx
builder is polled once per second for up to 60 seconds. If this preflight fails,
setup leaves no workspace metadata, generated devcontainer config, or SSH key.
```

Add this contract to `docs/features/start-and-shell.md`:

```markdown
Start does not require a completed setup. It performs a fresh runtime-readiness
check, then writes workspace inventory metadata and creates the generated state
needed for the devcontainer. It does not install the setup-only SSH alias or
external application integrations.
```

- [ ] **Step 3: Add lifecycle troubleshooting guidance**

Add this section to `docs/features/lifecycle.md`:

```markdown
## Container runtime readiness

Commands that may create or start a devcontainer wait for Docker before writing
workspace metadata. Docker daemon and Buildx builder startup races are retried
for up to 60 seconds; the underlying `devcontainer up` command is still run only
once after readiness succeeds.

For a daemon timeout, run `docker info`. For a Buildx timeout, run
`docker buildx inspect`. Logged lifecycle errors also print the workspace
command-log path, which contains full redacted stdout and stderr. A generic Dev
Containers JSON error without nested output means the command log is the next
place to inspect.
```

- [ ] **Step 4: Run documentation lint and the complete project checks**

Run:

```sh
pnpm run lint:markdown
pnpm test
pnpm lint
pnpm build
git diff --check
```

Expected: all commands exit 0 with no lint, test, type/build, or whitespace errors.

- [ ] **Step 5: Inspect the final diff for scope and state guarantees**

Run:

```sh
git diff --stat
git diff -- src/container-runtime.ts src/doctor.ts src/main.ts src/progress.ts src/devcontainer.ts __tests__/container-runtime.test.ts __tests__/app.test.ts README.md docs/features/setup.md docs/features/start-and-shell.md docs/features/lifecycle.md
```

Confirm all of the following from the diff:

- `devcontainer up` has no retry loop.
- `refresh-gh-token-running` has no readiness waiter.
- Setup readiness precedes prompts and every state write.
- Every gated non-setup branch writes metadata only after readiness.
- No metadata schema field or migration was added.
- No dependency or Dev Container image/Feature version changed.

- [ ] **Step 6: Commit documentation**

```sh
git add README.md docs/features/setup.md docs/features/start-and-shell.md docs/features/lifecycle.md
git commit -m "docs: explain container runtime readiness"
```

- [ ] **Step 7: Record final verification evidence**

Run once more from a clean worktree:

```sh
git status --short
pnpm test
pnpm lint
pnpm build
```

Expected: `git status --short` prints nothing, and all three pnpm commands exit 0. Record the passing test count and command outputs in the implementation handoff or pull-request description.
