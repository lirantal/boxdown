import assert from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { syncDevcontainerImage } from '../scripts/sync-devcontainer-image.ts'
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

test('synchronizes the top-level image while preserving JSONC comments', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boxdown-devcontainer-image-'))
  const testPackagePath = join(directory, 'package.json')
  const configPath = join(directory, 'devcontainer.json')

  try {
    writeFileSync(testPackagePath, '{"version":"9.8.7"}\n')
    writeFileSync(configPath, '{\n "nested": {\n  "image":"nested"\n },\n // retain\n "image":"old",\n "name":"Keep"\n}\n')

    syncDevcontainerImage(testPackagePath, configPath)

    const synchronizedConfig = readFileSync(configPath, 'utf8')
    assert.match(synchronizedConfig, /retain/)
    assert.match(synchronizedConfig, /ghcr\.io\/lirantal\/boxdown:9\.8\.7/)
    assert.match(synchronizedConfig, /"image":"nested"/)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('rejects an image property that appears only inside a block comment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boxdown-devcontainer-image-'))
  const testPackagePath = join(directory, 'package.json')
  const configPath = join(directory, 'devcontainer.json')
  const source = '{\n/*\n "image":"old"\n*/\n "name":"Keep"\n}\n'

  try {
    writeFileSync(testPackagePath, '{"version":"9.8.7"}\n')
    writeFileSync(configPath, source)

    assert.throws(
      () => syncDevcontainerImage(testPackagePath, configPath),
      new Error(`Packaged devcontainer image is missing: ${configPath}`)
    )
    assert.equal(readFileSync(configPath, 'utf8'), source)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('preserves an inline JSONC comment while synchronizing the image', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boxdown-devcontainer-image-'))
  const testPackagePath = join(directory, 'package.json')
  const configPath = join(directory, 'devcontainer.json')

  try {
    writeFileSync(testPackagePath, '{"version":"9.8.7"}\n')
    writeFileSync(configPath, '{\n "image":"old", // retain\n "name":"Keep"\n}\n')

    syncDevcontainerImage(testPackagePath, configPath)

    assert.match(
      readFileSync(configPath, 'utf8'),
      /"image":"ghcr\.io\/lirantal\/boxdown:9\.8\.7", \/\/ retain/
    )
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})
