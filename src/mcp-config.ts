import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

import type { WorkspaceContext } from './paths.ts'

export type ClaudeMcpConfigPreparation =
  | { state: 'prepared', path: string }
  | { state: 'absent' }
  | { state: 'invalid', path: string }

type JsonObject = Record<string, unknown>

// TODO(#18): Determine and test a safe forwarding strategy for OAuth token stores
// used by remote MCP servers. Server definitions alone do not guarantee OAuth reuse.

function isJsonObject (value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneJsonObject (value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function removeRuntimeConfig (path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function projectClaudeMcpConfig (source: JsonObject, hostWorkspace: string, containerWorkspace: string): JsonObject | undefined {
  const projection: JsonObject = {}

  if (isJsonObject(source.mcpServers)) {
    projection.mcpServers = cloneJsonObject(source.mcpServers)
  }

  const hostProject = isJsonObject(source.projects) && isJsonObject(source.projects[hostWorkspace])
    ? source.projects[hostWorkspace]
    : undefined
  if (hostProject === undefined) return Object.keys(projection).length > 0 ? projection : undefined

  const projectProjection: JsonObject = {}
  if (isJsonObject(hostProject.mcpServers)) {
    projectProjection.mcpServers = cloneJsonObject(hostProject.mcpServers)
  }
  for (const key of ['enabledMcpjsonServers', 'disabledMcpjsonServers']) {
    if (Array.isArray(hostProject[key]) && hostProject[key].every((value) => typeof value === 'string')) {
      projectProjection[key] = [...hostProject[key]]
    }
  }

  if (Object.keys(projectProjection).length > 0) {
    projection.projects = { [containerWorkspace]: projectProjection }
  }

  return Object.keys(projection).length > 0 ? projection : undefined
}

export function prepareClaudeMcpConfig (context: WorkspaceContext): ClaudeMcpConfigPreparation {
  let source: unknown
  try {
    source = JSON.parse(readFileSync(context.hostClaudeConfigPath, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      removeRuntimeConfig(context.workspaceClaudeMcpConfigPath)
      return { state: 'absent' }
    }
    removeRuntimeConfig(context.workspaceClaudeMcpConfigPath)
    return { state: 'invalid', path: context.hostClaudeConfigPath }
  }

  if (!isJsonObject(source)) {
    removeRuntimeConfig(context.workspaceClaudeMcpConfigPath)
    return { state: 'invalid', path: context.hostClaudeConfigPath }
  }

  const projection = projectClaudeMcpConfig(
    source,
    context.workspaceFolder,
    `/workspaces/${context.workspaceBasename}`
  )
  if (projection === undefined) {
    removeRuntimeConfig(context.workspaceClaudeMcpConfigPath)
    return { state: 'absent' }
  }

  mkdirSync(context.workspaceMcpConfigDir, { recursive: true, mode: 0o700 })
  writeFileSync(context.workspaceClaudeMcpConfigPath, `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 })
  chmodSync(context.workspaceClaudeMcpConfigPath, 0o600)
  return { state: 'prepared', path: context.workspaceClaudeMcpConfigPath }
}
