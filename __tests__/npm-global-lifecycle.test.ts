import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const fixture = fileURLToPath(new URL('./fixtures/npm-global-lifecycle.sh', import.meta.url))
const utils = fileURLToPath(new URL('../assets/devcontainer/utils', import.meta.url))

test('npm globals replace image tools in cached shells and survive shell startup and runtime changes', {timeout: 120_000}, () => {
  const result = spawnSync('bash', [fixture, utils, process.execPath], {encoding: 'utf8'})
  assert.ifError(result.error)
  assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /npm global lifecycle fixture: ok/u)
})
