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

export interface DevcontainerMountPolicy {
  destinations: string[]
  destinationIndeterminate: boolean
}

export type PosixPathRelationship =
  | 'exact'
  | 'ancestor'
  | 'descendant'
  | 'unrelated'

const destinationAliases = ['target', 'dst', 'destination'] as const
const sourceAliases = ['source', 'src'] as const
const structuredSerializedFieldNames = new Set([
  'type',
  ...sourceAliases,
  ...destinationAliases
])

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

function decodeCsvFields (record: string): string[] | undefined {
  const fields: string[] = []
  let index = 0

  while (true) {
    let field = ''

    if (record[index] === '"') {
      index += 1

      while (true) {
        if (index >= record.length) return undefined

        const character = record[index]
        if (character !== '"') {
          field += character
          index += 1
          continue
        }

        if (record[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }

        index += 1
        if (index < record.length && record[index] !== ',') {
          return undefined
        }
        break
      }
    } else {
      const fieldStart = index
      while (index < record.length && record[index] !== ',') {
        if (
          record[index] === '"' ||
          record[index] === '\r' ||
          record[index] === '\n'
        ) {
          return undefined
        }
        index += 1
      }
      field = record.slice(fieldStart, index)
    }

    fields.push(field)
    if (index >= record.length) return fields

    index += 1
    if (index === record.length) {
      fields.push('')
      return fields
    }
  }
}

function destinationValuesFromFields (fields: string[]): string[] {
  const values: string[] = []

  for (const field of fields) {
    const separator = field.indexOf('=')
    if (separator === -1) continue

    const key = field.slice(0, separator).trim().toLowerCase()
    if (!destinationAliases.includes(key as typeof destinationAliases[number])) {
      continue
    }

    values.push(field.slice(separator + 1))
  }

  return values
}

function containsUnresolvedSubstitution (value: unknown): boolean {
  return typeof value === 'string' && value.includes('${')
}

function structuredFieldValueIsIndeterminate (value: unknown): boolean {
  return typeof value !== 'string' ||
    containsUnresolvedSubstitution(value) ||
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\r') ||
    value.includes('\n') ||
    value.includes('\0')
}

export function inspectDevcontainerMount (mount: unknown): DevcontainerMountPolicy {
  let values: unknown[]
  let destinationIndeterminate = false

  if (typeof mount === 'string') {
    destinationIndeterminate = containsUnresolvedSubstitution(mount)
    const fields = decodeCsvFields(mount)
    if (fields === undefined) {
      return {
        destinations: [],
        destinationIndeterminate: true
      }
    }
    values = destinationValuesFromFields(fields)
  } else if (typeof mount === 'object' && mount !== null && !Array.isArray(mount)) {
    const serializedFields = Object.entries(mount)
      .map(([key, value]) => ({
        key: key.toLowerCase(),
        value
      }))
      .filter(field => structuredSerializedFieldNames.has(field.key))

    destinationIndeterminate = serializedFields
      .some(field => structuredFieldValueIsIndeterminate(field.value))
    values = serializedFields
      .filter(field =>
        destinationAliases.includes(field.key as typeof destinationAliases[number]) &&
        !structuredFieldValueIsIndeterminate(field.value)
      )
      .map(field => field.value)
  } else {
    values = []
  }

  return {
    destinations: [...new Set(values
      .map(normalizedAbsolutePosixPath)
      .filter((destination): destination is string => destination !== undefined))],
    destinationIndeterminate
  }
}

export function normalizedMountDestinations (mount: unknown): string[] {
  return inspectDevcontainerMount(mount).destinations
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
  const policy = inspectDevcontainerMount(mount)
  return policy.destinationIndeterminate || policy.destinations
    .some(target => posixPathsConflict(target, destination))
}

export function mountTargetsDestination (
  mount: unknown,
  destination: string
): boolean {
  const policy = inspectDevcontainerMount(mount)
  return !policy.destinationIndeterminate && policy.destinations
    .some(target => classifyPosixPath(target, destination) === 'exact')
}
