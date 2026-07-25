import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const imageSource = 'https://github.com/lirantal/boxdown'
const requiredLabels = [
  'org.opencontainers.image.source',
  'org.opencontainers.image.revision',
  'org.opencontainers.image.version'
] as const

type ImageLabels = Record<string, string | undefined>
type InspectImage = () => Promise<ImageLabels | undefined>

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

function inspectReleaseLabels(reference: string): ImageLabels | undefined {
  try {
    const platformLabels = ['linux/amd64', 'linux/arm64'].map(platform => {
      const output = execFileSync(
        'docker',
        [
          'buildx',
          'imagetools',
          'inspect',
          '--format',
          `{{json (index .Image "${platform}")}}`,
          reference
        ],
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}
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
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error
      ? String((error as Error & {stderr?: string | Buffer}).stderr ?? '')
      : ''
    if (/manifest unknown|not found|no such manifest/i.test(stderr)) return undefined
    throw error
  }
}

async function main(arguments_: string[]): Promise<void> {
  const [version, revision] = arguments_
  if (version === undefined || revision === undefined) {
    throw new Error('usage: check-image-release.ts <version> <revision>')
  }

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
