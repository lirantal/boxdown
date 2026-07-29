import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkImageRelease,
  inspectReleaseLabels,
  validateReleaseIdentity
} from '../scripts/check-image-release.ts'
import {
  compressedLayerBytes,
  registryPlatformReference,
  verifyImageManifest
} from '../scripts/verify-image-manifest.ts'

const imageNpmPackagePath = fileURLToPath(new URL('../assets/image/npm/package.json', import.meta.url))
const imageNpmLockPath = fileURLToPath(new URL('../assets/image/npm/package-lock.json', import.meta.url))
const nativeToolLockPath = fileURLToPath(new URL('../assets/image/tools.lock.json', import.meta.url))
const imageSizeBudgetPath = fileURLToPath(new URL('../assets/image/image-size-budget.json', import.meta.url))
const dockerfilePath = fileURLToPath(new URL('../assets/image/Dockerfile', import.meta.url))
const imageLifecycleSmokePath = fileURLToPath(new URL('../assets/image/lifecycle-smoke-test.sh', import.meta.url))
const releaseWorkflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url))
const ciWorkflowPath = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url))

const requiredNpmPackages = ['@openai/codex', '@anthropic-ai/claude-code', 'snyk'] as const
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

function isExactVersion(version: string): boolean {
  const [baseVersion, prerelease, ...extraParts] = version.split('-')
  const isNumeric = (value: string) =>
    value.length > 0 && [...value].every(character => character >= '0' && character <= '9')
  const isPrereleaseCharacter = (character: string) =>
    (character >= '0' && character <= '9') ||
    (character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z') ||
    character === '_' ||
    character === '.'

  return (
    extraParts.length === 0 &&
    baseVersion.split('.').length === 3 &&
    baseVersion.split('.').every(isNumeric) &&
    (prerelease === undefined ||
      (prerelease.length > 0 && [...prerelease].every(isPrereleaseCharacter)))
  )
}

function assertVersionedArtifact(artifact: Artifact): void {
  const urlTokens = artifact.url.toLowerCase().split(/[^a-z0-9_]+/)

  assert.match(artifact.url, /^https:\/\//)
  assert.equal(urlTokens.includes('latest'), false)
  assert.equal(urlTokens.includes('stable'), false)
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
    assert.equal(isExactVersion(manifest.dependencies[name]), true)
    assert.equal(isExactVersion(lock.packages[''].dependencies?.[name] ?? ''), true)
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
    measurement?: {
      source?: string
      method?: string
      platforms?: Record<string, number>
    }
  }

  assert.equal(budget.schemaVersion, 1)
  assert.equal(typeof budget.compressedBytes, 'number')
  assert.equal(Number.isInteger(budget.compressedBytes), true)
  assert.equal(budget.compressedBytes! > 0, true)
  assert.equal(budget.allowedGrowthPercent, 10)
  assert.equal(budget.measurement?.source, 'current accepted Docker build')
  assert.match(budget.measurement?.method ?? '', /compressed layer bytes/i)
  assert.deepEqual(
    budget.compressedBytes,
    Math.max(...Object.values(budget.measurement?.platforms ?? {}))
  )
})

test('uses the pinned Node image and has no mutable installer or lazy tools', () => {
  const dockerfile = readFileSync(dockerfilePath, 'utf8')

  assert.match(dockerfile, /^FROM node:24-trixie-slim@sha256:[a-f0-9]{64}/m)
  assert.match(dockerfile, /apt-get install -y --no-install-recommends/)
  assert.match(dockerfile, /USER node/)
  assert.match(dockerfile, /visudo -cf/)
  assert.doesNotMatch(dockerfile, /coding-agent-clis\/(?:codex|claude)\.stamp/)
  assert.doesNotMatch(dockerfile, /\b(latest|stable)\b/i)
  assert.doesNotMatch(dockerfile, /python3|pipx|\buv\b|opencode|antigravity/)
})

test('creates the Claude credential mount parent for the node user', () => {
  const dockerfile = readFileSync(dockerfilePath, 'utf8')

  assert.match(
    dockerfile,
    /install -d -m 0700 -o node -g node \\\s+\/home\/node\/\.claude/
  )
})

test('creates the Codex configuration mount parent for the node user', () => {
  const dockerfile = readFileSync(dockerfilePath, 'utf8')

  assert.match(
    dockerfile,
    /install -d -m 0700 -o node -g node \\\s+\/home\/node\/\.claude \/home\/node\/\.codex/
  )
})

test('creates UID-remap-safe sticky agent profile state', () => {
  const dockerfile = readFileSync(dockerfilePath, 'utf8')

  assert.match(
    dockerfile,
    /install -d -m 1777 -o root -g root \/opt\/boxdown\/state/
  )
})

test('runs a remapped non-root lifecycle smoke test against the actual profile marker path', () => {
  const lifecycleSmoke = readFileSync(imageLifecycleSmokePath, 'utf8')
  const ciWorkflow = readFileSync(ciWorkflowPath, 'utf8')
  const releaseWorkflow = readFileSync(releaseWorkflowPath, 'utf8')

  assert.match(lifecycleSmoke, /usermod --uid/)
  assert.match(lifecycleSmoke, /test "\$\(id -u\)" -ne 0/)
  assert.match(lifecycleSmoke, /test "\$\(id -u\)" -ne 1000/)
  assert.match(lifecycleSmoke, /sudo -n true/)
  assert.match(lifecycleSmoke, /ssh-bootstrap\.sh" runtime/)
  assert.match(lifecycleSmoke, /sudo -n -l .*boxdown-ssh-agent-proxy/)
  assert.match(lifecycleSmoke, /agent-profile-bootstrap\.mjs/)
  assert.match(lifecycleSmoke, /BOXDOWN_AGENT_PROFILE_SOURCE_DIR=/)
  assert.match(lifecycleSmoke, /BOXDOWN_AGENT_PROFILE_HOME=/)
  assert.match(lifecycleSmoke, /profile_marker="\/opt\/boxdown\/state\/agent-profile"/)
  assert.doesNotMatch(lifecycleSmoke, /BOXDOWN_AGENT_PROFILE_MARKER_PATH=/)
  assert.match(lifecycleSmoke, /test -w .*auth\.json/)
  assert.match(lifecycleSmoke, /test -w "\$\{profile_marker\}"/)
  assert.match(lifecycleSmoke, /stat -c '%a' "\$\{profile_marker\}".*600/)
  assert.match(ciWorkflow, /docker run --rm --user root[\s\S]*lifecycle-smoke-test\.sh/)
  assert.match(releaseWorkflow, /docker run --rm --user root[\s\S]*lifecycle-smoke-test\.sh/)
  assert.match(
    ciWorkflow,
    /assets\/devcontainer",target=\/opt\/boxdown\/devcontainer,readonly/
  )
})

test('checks the quoted mount policy fixture with Docker Go CSV parsing', () => {
  const ciWorkflow = readFileSync(ciWorkflowPath, 'utf8')
  const releaseWorkflow = readFileSync(releaseWorkflowPath, 'utf8')
  const quotedMount = String.raw`--mount 'type=tmpfs,"dst=/tmp/boxdown ""quoted"",mount"'`
  const decodedDestination = String.raw`test -d '/tmp/boxdown "quoted",mount'`

  for (const workflow of [ciWorkflow, releaseWorkflow]) {
    assert.ok(workflow.includes(quotedMount))
    assert.ok(workflow.includes(decodedDestination))
  }
})

const source = 'https://github.com/lirantal/boxdown'
const version = '1.4.0'
const revision = 'abc'
const toolLockSha256 = createHash('sha256')
  .update(readFileSync(nativeToolLockPath))
  .digest('hex')
const labels = {
  'org.opencontainers.image.source': source,
  'org.opencontainers.image.revision': revision,
  'org.opencontainers.image.version': version,
  'io.boxdown.tools-lock.sha256': toolLockSha256
}
const dualPlatformManifest = {
  manifests: [
    {platform: {architecture: 'amd64', os: 'linux'}},
    {platform: {architecture: 'arm64', os: 'linux'}}
  ]
}
const amd64OnlyManifest = {
  manifests: [
    {platform: {architecture: 'amd64', os: 'linux'}}
  ]
}
const budget = {
  schemaVersion: 1,
  compressedBytes: 100,
  allowedGrowthPercent: 10
}

test('requires AMD64 and ARM64 image manifest entries', () => {
  assert.throws(
    () => verifyImageManifest({
      manifest: amd64OnlyManifest,
      labels,
      expectedLabels: labels,
      compressedBytes: 1,
      budget
    }),
    /linux\/arm64/
  )
})

test('rejects compressed images beyond the allowed growth budget', () => {
  assert.throws(
    () => verifyImageManifest({
      manifest: dualPlatformManifest,
      labels,
      expectedLabels: labels,
      compressedBytes: 111,
      budget
    }),
    /size budget/
  )
})

test('rejects missing, malformed, empty, non-integer, and negative layer sizes', () => {
  for (const layers of [
    undefined,
    [],
    [{}],
    [{size: ''}],
    [{size: 1.5}],
    [{size: -1}],
    [{size: Number.MAX_SAFE_INTEGER}, {size: 1}]
  ]) {
    assert.throws(() => compressedLayerBytes(layers), /invalid image layer size/)
  }
})

test('counts zero-sized OCI layer descriptors as zero bytes', () => {
  assert.equal(compressedLayerBytes([{size: 0}, {size: 1}]), 1)
})

test('accepts a dual-platform image with release labels within the size budget', () => {
  assert.doesNotThrow(() => verifyImageManifest({
    manifest: dualPlatformManifest,
    labels,
    expectedLabels: labels,
    compressedBytes: 110,
    budget
  }))
})

test('publishes a missing release image tag', async () => {
  assert.equal(
    await checkImageRelease(version, revision, toolLockSha256, async () => undefined),
    'publish'
  )
})

test('reuses an identical release image tag', async () => {
  assert.equal(
    await checkImageRelease(version, revision, toolLockSha256, async () => labels),
    'reuse'
  )
})

test('refuses to overwrite an occupied release image tag with mismatched labels', async () => {
  await assert.rejects(
    () => checkImageRelease(version, revision, toolLockSha256, async () => ({
      ...labels,
      'org.opencontainers.image.revision': 'other'
    })),
    /refusing to overwrite/
  )
})

test('rejects a non-matching expected label value and tool-lock identity', () => {
  assert.throws(
    () => verifyImageManifest({
      manifest: dualPlatformManifest,
      labels: {
        ...labels,
        'io.boxdown.tools-lock.sha256': '0'.repeat(64)
      },
      expectedLabels: labels,
      compressedBytes: 1,
      budget
    }),
    /io\.boxdown\.tools-lock\.sha256.*expected/
  )
})

test('rejects malformed or multiline release versions', () => {
  for (const invalidVersion of [
    '1.4',
    '01.4.0',
    '1.4.0+build',
    '1.4.0\npublish=true',
    '1.4.0 latest'
  ]) {
    assert.throws(
      () => validateReleaseIdentity('boxdown', invalidVersion),
      /safe exact SemVer/
    )
  }
})

test('accepts a safe exact SemVer release version', () => {
  assert.doesNotThrow(() => validateReleaseIdentity('boxdown', '1.4.0-rc.1'))
})

test('inspects platform manifests beneath the exact immutable digest', () => {
  assert.equal(
    registryPlatformReference(
      'ghcr.io/lirantal/boxdown@sha256:index',
      'sha256:platform'
    ),
    'ghcr.io/lirantal/boxdown@sha256:platform'
  )
})

test('treats only top-level manifest absence as a publishable tag', () => {
  const reference = 'ghcr.io/lirantal/boxdown:1.4.0'
  const missingManifest = Object.assign(new Error('inspect failed'), {
    stderr: `manifest unknown: ${reference}`
  })
  const calls: string[][] = []

  assert.equal(
    inspectReleaseLabels(reference, (...arguments_) => {
      calls.push(arguments_)
      throw missingManifest
    }),
    undefined
  )
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['--raw', reference])
})

test('fails closed when an occupied tag has a broken platform lookup', () => {
  const reference = 'ghcr.io/lirantal/boxdown:1.4.0'
  let callCount = 0

  assert.throws(
    () => inspectReleaseLabels(reference, () => {
      callCount += 1
      if (callCount === 1) return JSON.stringify({manifests: []})
      throw Object.assign(new Error('platform inspect failed'), {
        stderr: 'manifest unknown'
      })
    }),
    /platform inspect failed/
  )
  assert.equal(callCount, 2)
})

test('validates and attests the immutable digest before moving release tags', () => {
  const workflow = readFileSync(releaseWorkflowPath, 'utf8')
  const push = workflow.indexOf('- name: Push immutable dual-platform release image')
  const resolveDigest = workflow.indexOf('- name: Resolve release image digest')
  const validateDigest = workflow.indexOf('- name: Validate immutable release image digest')
  const verifyBuildkitAttestations = workflow.indexOf('- name: Verify BuildKit provenance and SBOM attestations')
  const attestDigest = workflow.indexOf('- name: Attest immutable release image digest')
  const verifyAttestation = workflow.indexOf('- name: Verify immutable release image attestation')
  const moveTags = workflow.indexOf('- name: Update moving release image tags')
  const publishNpm = workflow.indexOf('- name: Publish to npm')

  assert.equal(
    [push, resolveDigest, validateDigest, verifyBuildkitAttestations, attestDigest, verifyAttestation, moveTags, publishNpm]
      .every(index => index >= 0),
    true
  )
  assert.deepEqual(
    [push, resolveDigest, validateDigest, verifyBuildkitAttestations, attestDigest, verifyAttestation, moveTags, publishNpm],
    [...[push, resolveDigest, validateDigest, verifyBuildkitAttestations, attestDigest, verifyAttestation, moveTags, publishNpm]]
      .sort((left, right) => left - right)
  )

  const pushStep = workflow.slice(push, resolveDigest)
  assert.match(
    pushStep,
    /tags: ghcr\.io\/lirantal\/boxdown:\$\{\{ steps\.release-state\.outputs\.version \}\}/
  )
  assert.doesNotMatch(pushStep, /boxdown:(?:1|latest)/)

  const validateStep = workflow.slice(validateDigest, verifyBuildkitAttestations)
  assert.match(
    validateStep,
    /IMAGE_REFERENCE: ghcr\.io\/lirantal\/boxdown@\$\{\{ steps\.image\.outputs\.digest \}\}/
  )
  assert.match(validateStep, /registry "\$\{IMAGE_REFERENCE\}"/)

  const buildkitAttestationStep = workflow.slice(verifyBuildkitAttestations, attestDigest)
  assert.match(buildkitAttestationStep, /for platform in linux\/amd64 linux\/arm64/)
  assert.match(buildkitAttestationStep, /index \.Provenance/)
  assert.match(buildkitAttestationStep, /index \.SBOM/)
  assert.match(buildkitAttestationStep, /\.SLSA/)
  assert.match(buildkitAttestationStep, /\.SPDX/)
  assert.match(buildkitAttestationStep, /for attempt in 1 2 3/)
  assert.match(buildkitAttestationStep, /sleep "\$\(\(attempt \* 2\)\)"/)

  const attestStep = workflow.slice(attestDigest, verifyAttestation)
  assert.match(attestStep, /subject-digest: \$\{\{ steps\.image\.outputs\.digest \}\}/)

  const movingTagStep = workflow.slice(moveTags, publishNpm)
  assert.match(movingTagStep, /IMAGE_REFERENCE: ghcr\.io\/lirantal\/boxdown@\$\{\{ steps\.image\.outputs\.digest \}\}/)
  assert.match(movingTagStep, /"\$\{IMAGE_REFERENCE\}"/)
})

test('keeps retry image identity anchored to the version-introducing merge commit', () => {
  const workflow = readFileSync(releaseWorkflowPath, 'utf8')

  assert.match(workflow, /fetch-depth: 0/)
  assert.match(workflow, /release_revision="\$\(\s+git log --first-parent -G/)
  assert.match(workflow, /RELEASE_REVISION: \$\{\{ steps\.release-state\.outputs\.release_revision \}\}/)
  assert.match(workflow, /org\.opencontainers\.image\.revision=\$\{\{ steps\.release-state\.outputs\.release_revision \}\}/)
})

test('creates the GitHub Release after npm publication at the release revision', () => {
  const workflow = readFileSync(releaseWorkflowPath, 'utf8')
  const publishNpm = workflow.indexOf('- name: Publish to npm')
  const createRelease = workflow.indexOf('- name: Create GitHub Release')

  assert.equal(publishNpm >= 0 && createRelease > publishNpm, true)

  const releaseStep = workflow.slice(createRelease)
  assert.match(workflow, /- name: Create GitHub Release\n {8}env:/)
  assert.match(releaseStep, /RELEASE_REVISION: \$\{\{ steps\.release-state\.outputs\.release_revision \}\}/)
  assert.match(releaseStep, /RELEASE_REPOSITORY: \$\{\{ github\.repository \}\}/)
  assert.match(releaseStep, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/)
  assert.match(releaseStep, /scripts\/create-github-release\.ts/)
  assert.match(workflow, /pnpm exec changeset publish --no-git-tag/)
})
