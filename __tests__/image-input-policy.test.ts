import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const imageNpmPackagePath = fileURLToPath(new URL('../assets/image/npm/package.json', import.meta.url))
const imageNpmLockPath = fileURLToPath(new URL('../assets/image/npm/package-lock.json', import.meta.url))
const nativeToolLockPath = fileURLToPath(new URL('../assets/image/tools.lock.json', import.meta.url))
const imageSizeBudgetPath = fileURLToPath(new URL('../assets/image/image-size-budget.json', import.meta.url))

const requiredNpmPackages = ['@openai/codex', '@anthropic-ai/claude-code', 'snyk'] as const
const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
const sha256 = /^[a-f0-9]{64}$/

interface Artifact {
  url: string
  sha256: string
}

interface NativeToolLock {
  schemaVersion: number
  onepassword: { artifacts: Record<string, Artifact> }
  apm: { artifacts: Record<string, Artifact>, deferredPlatforms: string[] }
}

function assertVersionedArtifact(artifact: Artifact): void {
  assert.match(artifact.url, /^https:\/\//)
  assert.doesNotMatch(artifact.url, /\/(?:latest|stable)(?:\/|$)/i)
  assert.doesNotMatch(artifact.url, /(?:^|[^\w])(?:latest|stable)(?:[^\w]|$)/i)
  assert.match(artifact.url, /\d+\.\d+\.\d+/)
  assert.match(artifact.sha256, sha256)
}

test('locks image npm dependencies to exact versions with integrity metadata', () => {
  const manifest = JSON.parse(readFileSync(imageNpmPackagePath, 'utf8')) as {
    private?: boolean
    engines?: { node?: string }
    dependencies: Record<string, string>
  }
  const lock = JSON.parse(readFileSync(imageNpmLockPath, 'utf8')) as {
    lockfileVersion?: number
    packages: Record<string, { dependencies?: Record<string, string>, integrity?: string }>
  }

  assert.equal(manifest.private, true)
  assert.equal(manifest.engines?.node, '>=24 <25')
  assert.equal(lock.lockfileVersion, 3)
  for (const name of requiredNpmPackages) {
    assert.match(manifest.dependencies[name], exactVersion)
    assert.match(lock.packages[''].dependencies?.[name] ?? '', exactVersion)
    assert.match(lock.packages[`node_modules/${name}`].integrity ?? '', /^sha512-/)
  }
})

test('locks 1Password for both platforms and APM for AMD64 only', () => {
  const lock = JSON.parse(readFileSync(nativeToolLockPath, 'utf8')) as NativeToolLock

  assert.equal(lock.schemaVersion, 1)
  assert.deepEqual(Object.keys(lock.onepassword.artifacts).sort(), ['amd64', 'arm64'])
  for (const arch of ['amd64', 'arm64']) assertVersionedArtifact(lock.onepassword.artifacts[arch])

  assert.deepEqual(Object.keys(lock.apm.artifacts), ['amd64'])
  assertVersionedArtifact(lock.apm.artifacts.amd64)
  assert.deepEqual(lock.apm.deferredPlatforms, ['arm64'])
})

test('sets a 10 percent compressed image growth budget', () => {
  const budget = JSON.parse(readFileSync(imageSizeBudgetPath, 'utf8')) as {
    schemaVersion?: number
    compressedBytes?: number
    allowedGrowthPercent?: number
  }

  assert.equal(budget.schemaVersion, 1)
  assert.equal(typeof budget.compressedBytes, 'number')
  assert.equal(Number.isInteger(budget.compressedBytes), true)
  assert.equal(budget.compressedBytes! > 0, true)
  assert.equal(budget.allowedGrowthPercent, 10)
})
