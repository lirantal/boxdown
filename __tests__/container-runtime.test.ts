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
