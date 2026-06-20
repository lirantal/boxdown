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
    typeof candidate.lastSeenAt === 'string'
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

export function writeWorkspaceMetadata (context: WorkspaceContext, sshAlias: string, now = new Date()): WorkspaceMetadata {
  const metadataPath = workspaceMetadataPath(context)
  const timestamp = now.toISOString()
  let firstSeenAt = timestamp

  if (existsSync(metadataPath)) {
    firstSeenAt = readWorkspaceMetadataFile(metadataPath).firstSeenAt
  }

  const metadata: WorkspaceMetadata = {
    version: WORKSPACE_METADATA_VERSION,
    workspaceId: context.workspaceId,
    workspaceFolder: context.workspaceFolder,
    workspaceBasename: context.workspaceBasename,
    sshAlias,
    firstSeenAt,
    lastSeenAt: timestamp
  }

  mkdirSync(context.workspaceDataDir, { recursive: true })
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
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
