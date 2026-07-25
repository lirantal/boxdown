import assert from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseJsonc } from '../src/jsonc.ts'

const devcontainerPath = fileURLToPath(new URL('../assets/devcontainer/devcontainer.json', import.meta.url))
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const renovatePath = fileURLToPath(new URL('../renovate.json', import.meta.url))

interface RenovatePackageRule {
  description?: string
  matchManagers?: string[]
  matchDepTypes?: string[]
  matchPackageNames?: string[]
  matchFileNames?: string[]
  versioning?: string
  pinDigests?: boolean
  schedule?: string[]
  enabled?: boolean
}

interface RenovateConfig {
  enabledManagers?: string[]
  devcontainer?: {
    managerFilePatterns?: string[]
  }
  packageRules?: RenovatePackageRule[]
}

test('uses the release-matched Boxdown image without Dev Container Features', () => {
  const devcontainer = parseJsonc<{
    image: string
    features?: Record<string, unknown>
    overrideFeatureInstallOrder?: string[]
  }>(readFileSync(devcontainerPath, 'utf8'))
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }

  assert.equal(devcontainer.image, `ghcr.io/lirantal/boxdown:${packageJson.version}`)
  assert.equal(devcontainer.features, undefined)
  assert.equal(devcontainer.overrideFeatureInstallOrder, undefined)
})

test('scopes Renovate to monthly packaged Node image digest updates', () => {
  assert.equal(existsSync(renovatePath), true, 'renovate.json must exist')

  const renovate = JSON.parse(readFileSync(renovatePath, 'utf8')) as RenovateConfig
  assert.deepEqual(renovate.enabledManagers, ['devcontainer'])
  assert.deepEqual(renovate.devcontainer?.managerFilePatterns, [
    '/^assets\\/devcontainer\\/devcontainer\\.json$/'
  ])

  const featureRule = renovate.packageRules?.find(rule => rule.matchDepTypes?.includes('feature'))
  assert.deepEqual(featureRule?.matchManagers, ['devcontainer'])
  assert.equal(featureRule?.enabled, false)

  const imageRule = renovate.packageRules?.find(rule => rule.matchDepTypes?.includes('image'))
  assert.deepEqual(imageRule?.matchManagers, ['devcontainer'])
  assert.deepEqual(imageRule?.matchPackageNames, ['node'])
  assert.deepEqual(imageRule?.matchFileNames, ['assets/devcontainer/devcontainer.json'])
  assert.equal(imageRule?.versioning, 'exact')
  assert.equal(imageRule?.pinDigests, true)
  assert.deepEqual(imageRule?.schedule, ['* 0-3 1 * *'])
})

test('keeps the packaged devcontainer image policy independent of mutable image inputs', () => {
  const devcontainer = parseJsonc<{ image: string }>(readFileSync(devcontainerPath, 'utf8'))

  assert.doesNotMatch(devcontainer.image, /(?:^|[^\w])(?:latest|stable)(?:[^\w]|$)/i)
})
