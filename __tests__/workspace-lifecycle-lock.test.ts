import assert from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { createWorkspaceContext } from '../src/paths.ts'
import { withWorkspaceLifecycleLock } from '../src/workspace-lifecycle-lock.ts'

function tempDir (name: string): string {
  return mkdtempSync(join(tmpdir(), `boxdown-${name}-`))
}

describe('workspace lifecycle lock', () => {
  test('reclaims a lock immediately when its owner process is dead', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('dead-owner-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('dead-owner-cache'),
        BOXDOWN_DATA_HOME: tempDir('dead-owner-data')
      }
    })
    const lockPath = join(context.workspaceDataDir, 'lifecycle.lock')

    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, 'owner.json'), `${JSON.stringify({
      pid: 424242,
      timestamp: '2026-09-15T15:50:33.577Z',
      nonce: 'orphaned-owner'
    })}\n`)

    const result = await withWorkspaceLifecycleLock(context, async () => 'recovered', {
      now: () => new Date('2026-09-15T15:50:34.000Z'),
      pidIsAlive: () => false,
      sleep: async () => {
        throw new Error('dead owner was not reclaimed immediately')
      }
    })

    assert.strictEqual(result, 'recovered')
  })

  test('serializes concurrent lifecycle operations for the same workspace', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('lifecycle-lock-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('lifecycle-lock-cache'),
        BOXDOWN_DATA_HOME: tempDir('lifecycle-lock-data')
      }
    })
    const events: string[] = []
    let waitNotifications = 0
    let contentionPolls = 0
    let releaseFirst!: () => void
    let observeContention!: () => void
    const firstEntered = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const contentionObserved = new Promise<void>(resolve => {
      observeContention = resolve
    })

    const first = withWorkspaceLifecycleLock(context, async () => {
      events.push('first-enter')
      await firstEntered
      events.push('first-exit')
      return 'first'
    })
    const second = withWorkspaceLifecycleLock(context, async () => {
      events.push('second-enter')
      return 'second'
    }, {
      pidIsAlive: () => true,
      onWait: () => { waitNotifications += 1 },
      sleep: async () => {
        contentionPolls += 1
        observeContention()
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    })

    await contentionObserved
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepStrictEqual(events, ['first-enter'])
    assert.ok(contentionPolls >= 1)
    releaseFirst()

    assert.deepStrictEqual(await Promise.all([first, second]), ['first', 'second'])
    assert.deepStrictEqual(events, ['first-enter', 'first-exit', 'second-enter'])
    assert.strictEqual(waitNotifications, 1)
  })
})
