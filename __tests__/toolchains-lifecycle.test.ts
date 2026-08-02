import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const fixture = fileURLToPath(new URL('./fixtures/toolchains-lifecycle.sh', import.meta.url))
const assets = fileURLToPath(new URL('../assets/devcontainer', import.meta.url))

test('workspace toolchain lifecycle enforces validation, ownership, and path safety', {timeout: 180_000}, () => {
  const result = spawnSync(fixture, [assets, process.execPath], {encoding: 'utf8'})

  assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /toolchains lifecycle fixture: ok/u)
})
