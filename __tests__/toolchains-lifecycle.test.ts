import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const assets = fileURLToPath(new URL('../assets/devcontainer', import.meta.url))
const fingerprint = 'a'.repeat(64)

function root (): string { return mkdtempSync(join(tmpdir(), 'boxdown-toolchain-lifecycle-')) }
function run (script: string, env: Record<string, string>): ReturnType<typeof spawnSync> {
  return spawnSync('bash', ['-c', script], {env: {...process.env, ...env}, encoding: 'utf8'})
}

test('post-create skips legacy dependency scripts for every valid plan, including no Node selection', () => {
  const dir = root(); const plan = join(dir, 'plan.json'); const marker = join(dir, 'legacy-ran')
  const dev = join(dir, 'dev'); mkdirSync(join(dev, 'utils'), {recursive: true})
  writeFileSync(join(dev, 'utils', 'deps-install.sh'), `#!/usr/bin/env bash\ntouch '${marker}'\n`)
  writeFileSync(plan, JSON.stringify({version: 1, fingerprint, selected: [{id: 'python', version: '3.14.6'}]}))
  const result = run(`source '${join(assets, 'hooks/post-create.sh')}'; DEVCONTAINER_DIR='${dev}'; run_deps_install`, {BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH: plan})
  assert.strictEqual(result.status, 0, result.stderr)
  assert.strictEqual(existsSync(marker), false)
})

test('post-start retries a malformed successful result instead of accepting it', () => {
  const dir = root(); const plan = join(dir, 'plan.json'); const results = join(dir, 'results'); mkdirSync(results)
  writeFileSync(plan, JSON.stringify({version: 1, fingerprint, selected: [{id: 'node', version: '24.17.0'}]}))
  writeFileSync(join(results, 'result.json'), JSON.stringify({version: 1, fingerprint, state: 'succeeded', runtimes: [{id: 'node', state: 'succeeded'}]}))
  const result = run(`source '${join(assets, 'hooks/post-start.sh')}'; toolchains_need_bootstrap`, {HOME: dir, BOXDOWN_PLAN_NODE: process.execPath, BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH: plan, BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR: results})
  assert.strictEqual(result.status, 0, result.stderr)
})
