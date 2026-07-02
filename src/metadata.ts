import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { WorkspaceContext } from './paths.ts'

export const WORKSPACE_METADATA_VERSION = 1

export interface WorkspaceMetadata {
  version: 1
  workspaceId: string
  workspaceFolder: string
  workspaceBasename: string
  sshAlias: string
  firstSeenAt: string
  lastSeenAt: string
  dockerImageId?: string
  dockerImageName?: string
  dockerImageLastSeenAt?: string
}

export interface WorkspaceDockerImageMetadata {
  id: string
  name?: string
}

function isWorkspaceMetadata (value: unknown): value is WorkspaceMetadata {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>

  return candidate.version === WORKSPACE_METADATA_VERSION &&
    typeof candidate.workspaceId === 'string' &&
    typeof candidate.workspaceFolder === 'string' &&
    typeof candidate.workspaceBasename === 'string' &&
    typeof candidate.sshAlias === 'string' &&
    typeof candidate.firstSeenAt === 'string' &&
    typeof candidate.lastSeenAt === 'string' &&
    (candidate.dockerImageId === undefined || typeof candidate.dockerImageId === 'string') &&
    (candidate.dockerImageName === undefined || typeof candidate.dockerImageName === 'string') &&
    (candidate.dockerImageLastSeenAt === undefined || typeof candidate.dockerImageLastSeenAt === 'string')
}

export function workspaceMetadataPath (context: WorkspaceContext): string {
  return join(context.workspaceDataDir, 'metadata.json')
}

export function readWorkspaceMetadataFile (path: string): WorkspaceMetadata {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown

  if (!isWorkspaceMetadata(parsed)) {
    throw new Error(`Invalid Boxdown workspace metadata: ${path}`)
  }

  return parsed
}

export function readWorkspaceMetadata (context: WorkspaceContext): WorkspaceMetadata | undefined {
  const metadataPath = workspaceMetadataPath(context)

  if (!existsSync(metadataPath)) {
    return undefined
  }

  return readWorkspaceMetadataFile(metadataPath)
}

export function writeWorkspaceMetadata (context: WorkspaceContext, sshAlias: string, now = new Date()): WorkspaceMetadata {
  const metadataPath = workspaceMetadataPath(context)
  const timestamp = now.toISOString()
  let firstSeenAt = timestamp
  let existingMetadata: WorkspaceMetadata | undefined

  if (existsSync(metadataPath)) {
    existingMetadata = readWorkspaceMetadataFile(metadataPath)
    firstSeenAt = existingMetadata.firstSeenAt
  }

  const metadata: WorkspaceMetadata = {
    version: WORKSPACE_METADATA_VERSION,
    workspaceId: context.workspaceId,
    workspaceFolder: context.workspaceFolder,
    workspaceBasename: context.workspaceBasename,
    sshAlias,
    firstSeenAt,
    lastSeenAt: timestamp,
    ...(existingMetadata?.dockerImageId === undefined ? {} : { dockerImageId: existingMetadata.dockerImageId }),
    ...(existingMetadata?.dockerImageName === undefined ? {} : { dockerImageName: existingMetadata.dockerImageName }),
    ...(existingMetadata?.dockerImageLastSeenAt === undefined ? {} : { dockerImageLastSeenAt: existingMetadata.dockerImageLastSeenAt })
  }

  mkdirSync(context.workspaceDataDir, { recursive: true })
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
}

export function recordWorkspaceDockerImage (
  context: WorkspaceContext,
  image: WorkspaceDockerImageMetadata,
  now = new Date()
): WorkspaceMetadata | undefined {
  const metadata = readWorkspaceMetadata(context)

  if (metadata === undefined) {
    return undefined
  }

  const nextMetadata: WorkspaceMetadata = {
    ...metadata,
    dockerImageId: image.id,
    ...(image.name === undefined ? {} : { dockerImageName: image.name }),
    dockerImageLastSeenAt: now.toISOString()
  }

  mkdirSync(context.workspaceDataDir, { recursive: true })
  writeFileSync(workspaceMetadataPath(context), `${JSON.stringify(nextMetadata, null, 2)}\n`)
  return nextMetadata
}

export function listWorkspaceMetadata (dataRoot: string): WorkspaceMetadata[] {
  const workspacesDir = join(dataRoot, 'workspaces')

  if (!existsSync(workspacesDir)) {
    return []
  }

  return readdirSync(workspacesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(workspacesDir, entry.name, 'metadata.json'))
    .filter((metadataPath) => existsSync(metadataPath))
    .map((metadataPath) => readWorkspaceMetadataFile(metadataPath))
}
