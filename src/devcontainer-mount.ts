import { posix } from 'node:path'

export interface DevcontainerMountObject {
  type?: string
  src?: string
  dst?: string
  source?: string
  target?: string
  destination?: string
  [key: string]: unknown
}

export type DevcontainerMount = string | DevcontainerMountObject

export type PosixPathRelationship =
  | 'exact'
  | 'ancestor'
  | 'descendant'
  | 'unrelated'

const destinationAliases = ['target', 'dst', 'destination'] as const

export function isDevcontainerMount (value: unknown): value is DevcontainerMount {
  return typeof value === 'string' ||
    (typeof value === 'object' && value !== null && !Array.isArray(value))
}

function normalizedAbsolutePosixPath (value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined

  const candidate = value.trim()
  if (
    candidate.length === 0 ||
    candidate.includes('\0') ||
    !posix.isAbsolute(candidate)
  ) {
    return undefined
  }

  const normalized = posix.normalize(candidate)
  return posix.isAbsolute(normalized) ? normalized : undefined
}

function stringMountDestinationValues (mount: string): string[] {
  const values: string[] = []

  for (const field of mount.split(',')) {
    const separator = field.indexOf('=')
    if (separator === -1) continue

    const key = field.slice(0, separator).trim()
    if (!destinationAliases.includes(key as typeof destinationAliases[number])) {
      continue
    }

    values.push(field.slice(separator + 1))
  }

  return values
}

export function normalizedMountDestinations (mount: unknown): string[] {
  const values = typeof mount === 'string'
    ? stringMountDestinationValues(mount)
    : typeof mount === 'object' && mount !== null && !Array.isArray(mount)
      ? destinationAliases.map(alias => (mount as Record<string, unknown>)[alias])
      : []

  return [...new Set(values
    .map(normalizedAbsolutePosixPath)
    .filter((destination): destination is string => destination !== undefined))]
}

function isDescendantOf (path: string, directory: string): boolean {
  return directory === '/'
    ? path !== '/' && path.startsWith('/')
    : path.startsWith(`${directory}/`)
}

export function classifyPosixPath (
  candidate: string,
  reference: string
): PosixPathRelationship {
  const normalizedCandidate = normalizedAbsolutePosixPath(candidate)
  const normalizedReference = normalizedAbsolutePosixPath(reference)

  if (normalizedCandidate === undefined || normalizedReference === undefined) {
    return 'unrelated'
  }
  if (normalizedCandidate === normalizedReference) return 'exact'
  if (isDescendantOf(normalizedReference, normalizedCandidate)) return 'ancestor'
  if (isDescendantOf(normalizedCandidate, normalizedReference)) return 'descendant'
  return 'unrelated'
}

export function posixPathsConflict (left: string, right: string): boolean {
  return classifyPosixPath(left, right) !== 'unrelated'
}

export function mountConflictsWithDestination (
  mount: unknown,
  destination: string
): boolean {
  return normalizedMountDestinations(mount)
    .some(target => posixPathsConflict(target, destination))
}

export function mountTargetsDestination (
  mount: unknown,
  destination: string
): boolean {
  return normalizedMountDestinations(mount)
    .some(target => classifyPosixPath(target, destination) === 'exact')
}
