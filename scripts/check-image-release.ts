import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const releasePackageName = 'boxdown'
const imageSource = 'https://github.com/lirantal/boxdown'
const requiredLabels = [
  'org.opencontainers.image.source',
  'org.opencontainers.image.revision',
  'org.opencontainers.image.version'
] as const

type ImageLabels = Record<string, string | undefined>
type InspectImage = () => Promise<ImageLabels | undefined>
type InspectCommand = (...arguments_: string[]) => string

function isNumericIdentifier(identifier: string): boolean {
  if (identifier.length === 0) return false
  for (const character of identifier) {
    if (character < '0' || character > '9') return false
  }
  return true
}

function isSafePrereleaseIdentifier(identifier: string): boolean {
  if (identifier.length === 0) return false
  for (const character of identifier) {
    const isNumber = character >= '0' && character <= '9'
    const isUppercase = character >= 'A' && character <= 'Z'
    const isLowercase = character >= 'a' && character <= 'z'
    if (!isNumber && !isUppercase && !isLowercase && character !== '-') return false
  }
  return !isNumericIdentifier(identifier) || identifier === '0' || !identifier.startsWith('0')
}

function isSafeReleaseVersion(version: string): boolean {
  if (version.length === 0 || version.length > 128) return false

  const prereleaseSeparator = version.indexOf('-')
  const core = prereleaseSeparator === -1 ? version : version.slice(0, prereleaseSeparator)
  const prerelease = prereleaseSeparator === -1
    ? undefined
    : version.slice(prereleaseSeparator + 1)
  const coreIdentifiers = core.split('.')
  if (
    coreIdentifiers.length !== 3 ||
    coreIdentifiers.some(identifier => (
      !isNumericIdentifier(identifier) ||
      (identifier.length > 1 && identifier.startsWith('0'))
    ))
  ) {
    return false
  }

  return prerelease === undefined ||
    prerelease.split('.').every(isSafePrereleaseIdentifier)
}

export function validateReleaseIdentity(packageName: string, version: string): void {
  if (packageName !== releasePackageName) {
    throw new Error(`release package must be ${releasePackageName}`)
  }
  if (!isSafeReleaseVersion(version)) {
    throw new Error('release version must be a safe exact SemVer and Docker tag')
  }
}

function assertCurrentReleaseIdentity(
  expectedPackageName: string,
  expectedVersion: string
): void {
  validateReleaseIdentity(expectedPackageName, expectedVersion)
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  if (
    manifest.name !== expectedPackageName ||
    manifest.version !== expectedVersion
  ) {
    throw new Error(
      `release identity changed unexpectedly: expected ${expectedPackageName}@${expectedVersion}, ` +
      `found ${String(manifest.name)}@${String(manifest.version)}`
    )
  }
}

export async function checkImageRelease(
  version: string,
  revision: string,
  inspect: InspectImage
): Promise<'publish' | 'reuse'> {
  const labels = await inspect()
  if (labels === undefined) return 'publish'

  const expectedLabels: ImageLabels = {
    'org.opencontainers.image.source': imageSource,
    'org.opencontainers.image.revision': revision,
    'org.opencontainers.image.version': version
  }
  const mismatchedLabel = Object.entries(expectedLabels).find(
    ([label, expected]) => labels[label] !== expected
  )

  if (mismatchedLabel !== undefined) {
    const [label, expected] = mismatchedLabel
    throw new Error(
      `refusing to overwrite occupied image tag: ${label} is ${labels[label] ?? 'missing'}, expected ${expected}`
    )
  }

  return 'reuse'
}

function inspectWithDocker(...arguments_: string[]): string {
  return execFileSync(
    'docker',
    ['buildx', 'imagetools', 'inspect', ...arguments_],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}
  )
}

function errorStderr(error: unknown): string {
  return error instanceof Error && 'stderr' in error
    ? String((error as Error & {stderr?: string | Buffer}).stderr ?? '')
    : ''
}

function isTopLevelManifestAbsent(error: unknown, reference: string): boolean {
  const stderr = errorStderr(error).toLowerCase()
  const normalizedReference = reference.toLowerCase()
  return (
    stderr.includes('manifest unknown') ||
    stderr.includes('no such manifest') ||
    stderr.includes(`${normalizedReference}: not found`) ||
    stderr.includes(`${normalizedReference} not found`)
  )
}

export function inspectReleaseLabels(
  reference: string,
  inspect: InspectCommand = inspectWithDocker
): ImageLabels | undefined {
  try {
    const topLevelManifest = JSON.parse(inspect('--raw', reference)) as unknown
    if (
      typeof topLevelManifest !== 'object' ||
      topLevelManifest === null
    ) {
      throw new Error('occupied image tag returned an invalid top-level manifest')
    }
  } catch (error) {
    if (isTopLevelManifestAbsent(error, reference)) return undefined
    throw error
  }

  const platformLabels = ['linux/amd64', 'linux/arm64'].map(platform => {
    const output = inspect(
      '--format',
      `{{json (index .Image "${platform}")}}`,
      reference
    )
    const image = JSON.parse(output) as {config?: {Labels?: ImageLabels}}
    return image.config?.Labels ?? {}
  })
  const labels = platformLabels[0]!
  for (const label of requiredLabels) {
    if (platformLabels[1]![label] !== labels[label]) {
      labels[label] = `platform label mismatch: ${labels[label] ?? 'missing'} / ${platformLabels[1]![label] ?? 'missing'}`
    }
  }
  return labels
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined) throw new Error(`missing ${name}`)
  return value
}

async function main(arguments_: string[]): Promise<void> {
  const [command] = arguments_
  const packageName = requiredEnvironment('RELEASE_PACKAGE_NAME')
  const version = requiredEnvironment('RELEASE_VERSION')

  if (command === 'validate') {
    validateReleaseIdentity(packageName, version)
    return
  }
  if (command === 'assert-current') {
    assertCurrentReleaseIdentity(packageName, version)
    return
  }
  if (command !== 'check-image') {
    throw new Error(
      'usage: check-image-release.ts <validate|assert-current|check-image>'
    )
  }

  validateReleaseIdentity(packageName, version)
  const revision = requiredEnvironment('RELEASE_REVISION')
  const reference = `ghcr.io/lirantal/boxdown:${version}`
  const decision = await checkImageRelease(
    version,
    revision,
    async () => inspectReleaseLabels(reference)
  )
  process.stdout.write(`${decision}\n`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2))
}
