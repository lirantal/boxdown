import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  formatContainerRuntimeFailure,
  probeContainerRuntime,
  waitForContainerRuntime,
  waitForContainerRuntimeInternal,
  type ContainerRuntimeCommandResult,
  type ContainerRuntimeCommandRunner,
  type ContainerRuntimeProbe
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

describe('container runtime waiter', () => {
  test('rejects invalid and non-finite timeouts before probing', async () => {
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const calls: string[][] = []
      await assert.rejects(
        waitForContainerRuntimeInternal({
          runCommand: runnerFrom([ok], calls),
          timeoutMs
        }),
        /timeoutMs must be a finite number between 0 and 60000 milliseconds/
      )
      assert.deepStrictEqual(calls, [])
    }
  })

  test('rejects a timeout above 60 seconds before probing', async () => {
    const calls: string[][] = []
    await assert.rejects(
      waitForContainerRuntimeInternal({
        runCommand: runnerFrom([ok], calls),
        timeoutMs: 60_001
      }),
      /timeoutMs must be a finite number between 0 and 60000 milliseconds/
    )
    assert.deepStrictEqual(calls, [])
  })

  test('rejects a polling cadence other than one second before probing', async () => {
    const calls: string[][] = []
    await assert.rejects(
      waitForContainerRuntimeInternal({
        runCommand: runnerFrom([ok], calls),
        pollIntervalMs: 999
      }),
      /pollIntervalMs must be exactly 1000 milliseconds/
    )
    assert.deepStrictEqual(calls, [])
  })

  test('probes immediately and sleeps exactly once per transient retry', async () => {
    let now = 0
    const sleeps: number[] = []
    const result = await waitForContainerRuntimeInternal({
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

  test('gives each command only the remaining absolute deadline', async () => {
    let now = 0
    const commandTimeouts: number[] = []
    const commandDurations = [100, 250, 200, 50]
    let commandIndex = 0
    const result = await waitForContainerRuntimeInternal({
      timeoutMs: 1_000,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
      runCommand: async (_command, _args, timeoutMs) => {
        assert.notStrictEqual(timeoutMs, undefined)
        commandTimeouts.push(timeoutMs as number)
        now += commandDurations[commandIndex] as number
        commandIndex += 1
        return ok
      }
    })

    assert.strictEqual(result.state, 'ready')
    assert.deepStrictEqual(commandTimeouts, [1_000, 900, 650, 450])
  })

  test('production timing cannot be overridden by callers', async () => {
    const result = await waitForContainerRuntime({
      runCommand: runnerFrom([ok, ok, ok, ok], []),
      ...({
        timeoutMs: 0,
        pollIntervalMs: 0,
        now: () => { throw new Error('caller clock must not run') },
        sleep: async () => { throw new Error('caller scheduler must not run') }
      } as Record<string, unknown>)
    })

    assert.deepStrictEqual(result, { state: 'ready', mode: 'buildx', warnings: [] })
  })

  test('does not sleep after a terminal failure', async () => {
    const sleeps: number[] = []
    const result = await waitForContainerRuntimeInternal({
      runCommand: runnerFrom([{ code: 127, stdout: '', stderr: 'ENOENT' }], []),
      sleep: async (milliseconds) => { sleeps.push(milliseconds) }
    })

    assert.deepStrictEqual(sleeps, [])
    assert.strictEqual(result.state, 'failed')
    assert.strictEqual(result.timedOut, false)
  })

  test('stops at the deadline and retains the final probe', async () => {
    let now = 0
    const calls: string[][] = []
    const sleeps: number[] = []
    const daemonDiagnostics = ['first diagnostic', 'last diagnostic']
    let daemonIndex = 0
    const result = await waitForContainerRuntimeInternal({
      runCommand: async (command, args) => {
        calls.push([command, ...args])
        if (args[0] === '--version') return ok
        if (args[0] === 'info') {
          const detail = daemonDiagnostics[Math.min(daemonIndex, daemonDiagnostics.length - 1)] as string
          daemonIndex += 1
          return { code: 1, stdout: '', stderr: detail }
        }
        assert.fail(`Unexpected command: ${command} ${args.join(' ')}`)
      },
      timeoutMs: 1_500,
      pollIntervalMs: 1_000,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
      }
    })

    assert.strictEqual(result.state, 'failed')
    assert.strictEqual(result.timedOut, true)
    assert.strictEqual(result.timeoutMs, 1_500)
    assert.strictEqual(result.failure.detail, 'last diagnostic')
    assert.deepStrictEqual(sleeps, [1_000, 500])
    assert.deepStrictEqual(calls, [
      ['docker', '--version'],
      ['docker', 'info'],
      ['docker', '--version'],
      ['docker', 'info']
    ])
  })

  test('emits only state and reason transitions', async () => {
    let now = 0
    const transitions: ContainerRuntimeProbe[] = []
    const result = await waitForContainerRuntimeInternal({
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
    const result = await waitForContainerRuntimeInternal({
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
