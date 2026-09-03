import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { createWorkspaceContext } from '../src/paths.ts'
import { withWorkspaceLifecycleLock } from '../src/workspace-lifecycle-lock.ts'

function tempDir (name: string): string {
  return mkdtempSync(join(tmpdir(), `boxdown-${name}-`))
}

describe('workspace lifecycle lock', () => {
  test('serializes concurrent lifecycle operations for the same workspace', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('lifecycle-lock-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('lifecycle-lock-cache'),
        BOXDOWN_DATA_HOME: tempDir('lifecycle-lock-data')
      }
    })
    const events: string[] = []
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
      sleep: async () => {
        observeContention()
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    })

    await contentionObserved
    assert.deepStrictEqual(events, ['first-enter'])
    releaseFirst()

    assert.deepStrictEqual(await Promise.all([first, second]), ['first', 'second'])
    assert.deepStrictEqual(events, ['first-enter', 'first-exit', 'second-enter'])
  })
})
