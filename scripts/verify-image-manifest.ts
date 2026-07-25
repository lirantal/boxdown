import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const requiredPlatforms = ['linux/amd64', 'linux/arm64'] as const
const requiredLabels = [
  'org.opencontainers.image.source',
  'org.opencontainers.image.revision',
  'org.opencontainers.image.version',
  'io.boxdown.tools-lock.sha256'
] as const
const imageSource = 'https://github.com/lirantal/boxdown'

interface Descriptor {
  digest?: string
  platform?: {
    architecture?: string
    os?: string
  }
}

interface ImageManifest {
  config?: {digest?: string}
  layers?: unknown
}

interface ManifestIndex {
  manifests?: Descriptor[]
}

interface ImageConfig {
  config?: {
    Labels?: Record<string, string>
  }
}

interface ImageSizeBudget {
  schemaVersion: number
  compressedBytes: number
  allowedGrowthPercent: number
}

export interface VerifyImageManifestOptions {
  manifest: ManifestIndex
  labels: Record<string, string | undefined>
  expectedLabels: Record<string, string>
  compressedBytes: number
  budget: ImageSizeBudget
}

function platformName(descriptor: Descriptor): string {
  return `${descriptor.platform?.os ?? ''}/${descriptor.platform?.architecture ?? ''}`
}

function assertBudget(budget: ImageSizeBudget): void {
  if (
    budget.schemaVersion !== 1 ||
    !Number.isFinite(budget.compressedBytes) ||
    budget.compressedBytes <= 0 ||
    !Number.isFinite(budget.allowedGrowthPercent) ||
    budget.allowedGrowthPercent < 0
  ) {
    throw new Error('invalid image size budget')
  }
}

export function verifyImageManifest(options: VerifyImageManifestOptions): void {
  const {manifest, labels, expectedLabels, compressedBytes, budget} = options
  const platforms = new Set((manifest.manifests ?? []).map(platformName))

  for (const platform of requiredPlatforms) {
    if (!platforms.has(platform)) throw new Error(`image manifest is missing ${platform}`)
  }

  for (const label of requiredLabels) {
    const expected = expectedLabels[label]
    if (typeof expected !== 'string' || expected.length === 0) {
      throw new Error(`image verifier is missing expected ${label} label`)
    }
    if (labels[label] !== expected) {
      throw new Error(
        `image ${label} label is ${labels[label] ?? 'missing'}, expected ${expected}`
      )
    }
  }

  assertBudget(budget)
  if (!Number.isFinite(compressedBytes) || compressedBytes < 0) {
    throw new Error('invalid compressed image size')
  }

  const maximumBytes = budget.compressedBytes * (1 + budget.allowedGrowthPercent / 100)
  if (compressedBytes > maximumBytes) {
    throw new Error(
      `compressed image size ${compressedBytes} exceeds size budget ${maximumBytes}`
    )
  }
}

export function compressedLayerBytes(layers: unknown): number {
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new Error('invalid image layer size')
  }

  return layers.reduce((total, layer) => {
    const size = typeof layer === 'object' && layer !== null
      ? (layer as {size?: unknown}).size
      : undefined
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('invalid image layer size')
    }
    const nextTotal = total + size
    if (!Number.isSafeInteger(nextTotal)) {
      throw new Error('invalid image layer size')
    }
    return nextTotal
  }, 0)
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function blobPath(directory: string, digest: string): string {
  const [algorithm, hash, ...extra] = digest.split(':')
  if (algorithm !== 'sha256' || hash === undefined || extra.length > 0 || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`invalid OCI digest: ${digest}`)
  }
  return resolve(directory, 'blobs', algorithm, hash)
}

function readOciBlob<T>(directory: string, descriptor: {digest?: string}): T {
  if (descriptor.digest === undefined) throw new Error('OCI descriptor is missing a digest')
  return readJson<T>(blobPath(directory, descriptor.digest))
}

function resolveOciIndex(directory: string): ManifestIndex {
  const layoutIndex = readJson<ManifestIndex>(resolve(directory, 'index.json'))
  const descriptors = layoutIndex.manifests ?? []

  if (descriptors.some(descriptor => descriptor.platform !== undefined)) return layoutIndex
  if (descriptors.length !== 1) throw new Error('OCI layout does not contain an image index')

  const imageIndex = readOciBlob<ManifestIndex>(directory, descriptors[0]!)
  if (!Array.isArray(imageIndex.manifests)) throw new Error('OCI layout does not contain an image index')
  return imageIndex
}

function verifyOciLayout(
  directory: string,
  budgetPath: string,
  expectedLabels: Record<string, string>
): void {
  const manifest = resolveOciIndex(directory)
  const budget = readJson<ImageSizeBudget>(budgetPath)
  let compressedBytes = 0
  const platformLabels: Array<Record<string, string>> = []

  for (const descriptor of manifest.manifests ?? []) {
    if (!requiredPlatforms.includes(platformName(descriptor) as typeof requiredPlatforms[number])) continue

    const imageManifest = readOciBlob<ImageManifest>(directory, descriptor)
    const imageConfig = readOciBlob<ImageConfig>(directory, imageManifest.config ?? {})
    platformLabels.push(imageConfig.config?.Labels ?? {})
    compressedBytes = Math.max(
      compressedBytes,
      compressedLayerBytes(imageManifest.layers)
    )
  }

  for (const labels of platformLabels) {
    verifyImageManifest({manifest, labels, expectedLabels, compressedBytes, budget})
  }
  for (const label of requiredLabels) {
    if (platformLabels.some(labels => labels[label] !== platformLabels[0]?.[label])) {
      throw new Error(`image platforms have mismatched ${label} labels`)
    }
  }
  if (platformLabels.length === 0) {
    verifyImageManifest({manifest, labels: {}, expectedLabels, compressedBytes, budget})
  }
}

function inspectJson<T>(...arguments_: string[]): T {
  const output = execFileSync('docker', ['buildx', 'imagetools', 'inspect', ...arguments_], {
    encoding: 'utf8'
  })
  return JSON.parse(output) as T
}

export function registryPlatformReference(
  reference: string,
  platformDigest: string
): string {
  const digestSeparator = reference.lastIndexOf('@')
  const imageName = digestSeparator === -1
    ? reference
    : reference.slice(0, digestSeparator)
  return `${imageName}@${platformDigest}`
}

function verifyRegistryImage(
  reference: string,
  budgetPath: string,
  expectedLabels: Record<string, string>
): void {
  const manifest = inspectJson<ManifestIndex>('--raw', reference)
  const budget = readJson<ImageSizeBudget>(budgetPath)
  let compressedBytes = 0
  const platformLabels: Array<Record<string, string>> = []

  for (const platform of requiredPlatforms) {
    const descriptor = (manifest.manifests ?? []).find(candidate => platformName(candidate) === platform)
    if (descriptor?.digest === undefined) {
      verifyImageManifest({manifest, labels: {}, expectedLabels, compressedBytes, budget})
      return
    }

    const imageManifest = inspectJson<ImageManifest>(
      '--raw',
      registryPlatformReference(reference, descriptor.digest)
    )
    const imageConfig = inspectJson<ImageConfig>(
      '--format',
      `{{json (index .Image "${platform}")}}`,
      reference
    )
    compressedBytes = Math.max(
      compressedBytes,
      compressedLayerBytes(imageManifest.layers)
    )
    platformLabels.push(imageConfig.config?.Labels ?? {})
    verifyImageManifest({
      manifest,
      labels: platformLabels.at(-1)!,
      expectedLabels,
      compressedBytes,
      budget
    })
  }
  for (const label of requiredLabels) {
    if (platformLabels.some(labels => labels[label] !== platformLabels[0]?.[label])) {
      throw new Error(`image platforms have mismatched ${label} labels`)
    }
  }
}

function main(arguments_: string[]): void {
  const [sourceType, source, budgetPath, revision, version, toolLockSha256] = arguments_
  if (
    source === undefined ||
    budgetPath === undefined ||
    revision === undefined ||
    version === undefined ||
    toolLockSha256 === undefined
  ) {
    throw new Error(
      'usage: verify-image-manifest.ts <oci-layout|registry> <source> <size-budget.json> <revision> <version> <tool-lock-sha256>'
    )
  }
  if (!/^[a-f0-9]{64}$/.test(toolLockSha256)) {
    throw new Error('invalid tool lock SHA-256')
  }
  const expectedLabels = {
    'org.opencontainers.image.source': imageSource,
    'org.opencontainers.image.revision': revision,
    'org.opencontainers.image.version': version,
    'io.boxdown.tools-lock.sha256': toolLockSha256
  }

  if (sourceType === 'oci-layout') {
    verifyOciLayout(source, budgetPath, expectedLabels)
  } else if (sourceType === 'registry') {
    verifyRegistryImage(source, budgetPath, expectedLabels)
  } else {
    throw new Error(`unsupported image source type: ${sourceType ?? ''}`)
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2))
}
