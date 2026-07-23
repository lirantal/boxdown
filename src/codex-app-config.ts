import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { WorkspaceContext } from './paths.ts'

export const CODEX_APP_CONFIG_VERSION = 1
export const CODEX_APP_CONFIG_DIRNAME = 'codex-app'
export const CODEX_APP_CONFIG_FILENAME = 'config.json'
export const CODEX_GLOBAL_STATE_FILENAME = '.codex-global-state.json'

export interface CodexAppProjectConfig {
  remotePath: string
  label?: string
}

export interface CodexAppRemoteConnectionConfig {
  sshAlias: string
  projects: CodexAppProjectConfig[]
}

export interface CodexAppConfig {
  version: 1
  remoteConnectionMaxRetryAttempts?: number
  sshConnectTimeoutSeconds?: number
  remoteConnections: CodexAppRemoteConnectionConfig[]
}

export interface CodexAppProjectEntry {
  sshAlias: string
  remotePath: string
  label: string
}

export interface InstallCodexAppConfigResult {
  configPath: string
  backupPath?: string
  changed: boolean
}

export interface UninstallCodexAppConfigResult {
  configPath: string
  backupPath?: string
  changed: boolean
}

export interface UninstallCodexGlobalStateResult {
  statePath: string
  backupPath?: string
  changed: boolean
}

export interface InstallCodexGlobalStateResult {
  statePath: string
  backupPath?: string
  changed: boolean
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseOptionalNonnegativeInteger (value: unknown, key: string): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid Codex app config: ${key} must be a nonnegative integer`)
  }

  return value
}

function parseOptionalLabel (value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string') {
    throw new Error('Invalid Codex app config: project label must be a string')
  }

  return value
}

function parseProjectConfig (value: unknown): CodexAppProjectConfig {
  if (!isRecord(value)) {
    throw new Error('Invalid Codex app config: project entries must be objects')
  }

  const remotePath = value.remotePath
  if (typeof remotePath !== 'string' || remotePath.trim().length === 0) {
    throw new Error('Invalid Codex app config: project remotePath must be a nonempty string')
  }

  const label = parseOptionalLabel(value.label)

  return {
    remotePath: normalizeRemotePath(remotePath),
    ...(label === undefined ? {} : { label })
  }
}

function parseRemoteConnectionConfig (value: unknown): CodexAppRemoteConnectionConfig {
  if (!isRecord(value)) {
    throw new Error('Invalid Codex app config: remoteConnections entries must be objects')
  }

  const sshAlias = value.sshAlias
  if (typeof sshAlias !== 'string' || sshAlias.trim().length === 0) {
    throw new Error('Invalid Codex app config: sshAlias must be a nonempty string')
  }

  const projects = value.projects
  if (projects !== undefined && !Array.isArray(projects)) {
    throw new Error('Invalid Codex app config: projects must be an array')
  }

  return {
    sshAlias: sshAlias.trim(),
    projects: (projects ?? []).map((project) => parseProjectConfig(project))
  }
}

export function parseCodexAppConfig (value: unknown): CodexAppConfig {
  if (!isRecord(value)) {
    throw new Error('Invalid Codex app config: top-level value must be an object')
  }

  const version = value.version
  if (version !== undefined && (!Number.isInteger(version) || version !== CODEX_APP_CONFIG_VERSION)) {
    throw new Error(`Unsupported Codex app config version: ${String(version)}`)
  }

  const remoteConnections = value.remoteConnections
  if (remoteConnections !== undefined && !Array.isArray(remoteConnections)) {
    throw new Error('Invalid Codex app config: remoteConnections must be an array')
  }

  return {
    version: CODEX_APP_CONFIG_VERSION,
    ...(value.remoteConnectionMaxRetryAttempts === undefined
      ? {}
      : { remoteConnectionMaxRetryAttempts: parseOptionalNonnegativeInteger(value.remoteConnectionMaxRetryAttempts, 'remoteConnectionMaxRetryAttempts') }),
    ...(value.sshConnectTimeoutSeconds === undefined
      ? {}
      : { sshConnectTimeoutSeconds: parseOptionalNonnegativeInteger(value.sshConnectTimeoutSeconds, 'sshConnectTimeoutSeconds') }),
    remoteConnections: (remoteConnections ?? []).map((connection) => parseRemoteConnectionConfig(connection))
  }
}

export function defaultCodexAppConfigPath (env: NodeJS.ProcessEnv = process.env): string {
  return env.BOXDOWN_CODEX_APP_CONFIG ?? join(env.HOME ?? homedir(), '.codex', CODEX_APP_CONFIG_DIRNAME, CODEX_APP_CONFIG_FILENAME)
}

export function defaultCodexGlobalStatePath (env: NodeJS.ProcessEnv = process.env): string {
  return env.BOXDOWN_CODEX_GLOBAL_STATE ?? join(env.HOME ?? homedir(), '.codex', CODEX_GLOBAL_STATE_FILENAME)
}

export function canonicalCodexRemotePathForWorkspace (context: WorkspaceContext): string {
  return `/workspaces/${context.workspaceBasename}`
}

export function legacyCodexRemotePathForWorkspace (context: WorkspaceContext): string {
  return `/home/node/${context.workspaceBasename}`
}

export function codexRemotePathForWorkspace (context: WorkspaceContext): string {
  return canonicalCodexRemotePathForWorkspace(context)
}

export function codexProjectEntryForWorkspace (context: WorkspaceContext, sshAlias: string): CodexAppProjectEntry {
  return {
    sshAlias,
    remotePath: codexRemotePathForWorkspace(context),
    label: context.workspaceBasename
  }
}

export function normalizeRemotePath (remotePath: string): string {
  const trimmed = remotePath.trim()

  if (trimmed === '/') {
    return trimmed
  }

  return trimmed.replace(/\/+$/u, '')
}

export function codexDiscoveredRemoteHostId (sshAlias: string): string {
  return `remote-ssh-discovered:${sshAlias}`
}

function normalizedRemotePathSet (remotePaths: readonly string[] = []): Set<string> {
  return new Set(remotePaths.map((remotePath) => normalizeRemotePath(remotePath)))
}

export function mergeCodexAppProject (
  config: CodexAppConfig,
  entry: CodexAppProjectEntry,
  options: { legacyRemotePaths?: readonly string[] } = {}
): CodexAppConfig {
  const remotePath = normalizeRemotePath(entry.remotePath)
  const legacyRemotePaths = normalizedRemotePathSet(options.legacyRemotePaths)
  let matchedConnection = false

  const remoteConnections = config.remoteConnections.map((connection) => {
    if (connection.sshAlias !== entry.sshAlias) {
      return connection
    }

    matchedConnection = true
    let matchedProject = false
    const projects: CodexAppProjectConfig[] = []

    for (const project of connection.projects) {
      const projectRemotePath = normalizeRemotePath(project.remotePath)

      if (projectRemotePath !== remotePath && !legacyRemotePaths.has(projectRemotePath)) {
        projects.push(project)
        continue
      }

      if (!matchedProject) {
        projects.push({
          remotePath,
          label: entry.label
        })
        matchedProject = true
      }
    }

    if (!matchedProject) {
      projects.push({
        remotePath,
        label: entry.label
      })
    }

    return {
      sshAlias: connection.sshAlias,
      projects
    }
  })

  if (!matchedConnection) {
    remoteConnections.push({
      sshAlias: entry.sshAlias,
      projects: [{
        remotePath,
        label: entry.label
      }]
    })
  }

  return {
    ...config,
    remoteConnections
  }
}

export function removeCodexAppProject (
  config: CodexAppConfig,
  entry: CodexAppProjectEntry,
  options: { additionalRemotePaths?: readonly string[] } = {}
): CodexAppConfig {
  const remotePaths = normalizedRemotePathSet([
    entry.remotePath,
    ...(options.additionalRemotePaths ?? [])
  ])
  const remoteConnections = config.remoteConnections.flatMap((connection) => {
    if (connection.sshAlias !== entry.sshAlias) {
      return [connection]
    }

    const projects = connection.projects.filter((project) => !remotePaths.has(normalizeRemotePath(project.remotePath)))

    if (projects.length === 0) {
      return []
    }

    return [{
      sshAlias: connection.sshAlias,
      projects
    }]
  })

  return {
    ...config,
    remoteConnections
  }
}

function cloneJsonObject (value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function removeObjectKey (value: unknown, key: string): void {
  if (isRecord(value)) {
    delete value[key]
  }
}

function removeFromStringArray (value: unknown, removedValues: Set<string>): unknown {
  if (!Array.isArray(value)) {
    return value
  }

  return value.filter((item) => typeof item !== 'string' || !removedValues.has(item))
}

function cleanupStringArrayField (container: Record<string, unknown>, key: string, removedValues: Set<string>): void {
  if (Array.isArray(container[key])) {
    container[key] = removeFromStringArray(container[key], removedValues)
  }
}

function cleanupCodexStateContainer (container: Record<string, unknown>, hostId: string, remotePaths: Set<string>): Set<string> {
  const removedProjectIds = new Set<string>()
  const remoteProjects = container['remote-projects']

  if (Array.isArray(remoteProjects)) {
    container['remote-projects'] = remoteProjects.filter((project) => {
      if (!isRecord(project)) {
        return true
      }

      const matches = project.hostId === hostId &&
        typeof project.remotePath === 'string' &&
        remotePaths.has(normalizeRemotePath(project.remotePath))

      if (matches && typeof project.id === 'string') {
        removedProjectIds.add(project.id)
      }

      return !matches
    })
  }

  return removedProjectIds
}

function cleanupCodexHostStateContainer (container: Record<string, unknown>, hostId: string): void {
  const managedConnections = container['codex-managed-remote-connections']
  if (Array.isArray(managedConnections)) {
    container['codex-managed-remote-connections'] = managedConnections.filter((connection) => !isRecord(connection) || connection.hostId !== hostId)
  }

  for (const key of [
    'remote-connection-analytics-id-by-host-id',
    'remote-connection-auto-connect-by-host-id',
    'preferred-non-full-access-agent-mode-by-host-id',
    'agent-mode-by-host-id',
    'unread-thread-ids-by-host-v1'
  ]) {
    removeObjectKey(container[key], hostId)
  }

  if (container['selected-remote-host-id'] === hostId) {
    delete container['selected-remote-host-id']
  }
}

function hasCodexStateProjectForHost (container: Record<string, unknown>, hostId: string): boolean {
  const remoteProjects = container['remote-projects']
  return Array.isArray(remoteProjects) && remoteProjects.some((project) => isRecord(project) && project.hostId === hostId)
}

function cleanupProjectReferences (state: Record<string, unknown>, atomState: unknown, removedProjectIds: Set<string>): void {
  if (removedProjectIds.size === 0) {
    return
  }

  cleanupStringArrayField(state, 'project-order', removedProjectIds)

  for (const projectId of removedProjectIds) {
    removeObjectKey(state['sidebar-collapsed-groups'], projectId)
  }

  if (isRecord(atomState)) {
    cleanupStringArrayField(atomState, 'project-order', removedProjectIds)
    for (const projectId of removedProjectIds) {
      removeObjectKey(atomState['sidebar-collapsed-groups'], projectId)
    }
  }
}

export function removeCodexGlobalStateProject (
  state: Record<string, unknown>,
  entry: CodexAppProjectEntry,
  options: { additionalRemotePaths?: readonly string[] } = {}
): Record<string, unknown> {
  const hostId = codexDiscoveredRemoteHostId(entry.sshAlias)
  const remotePaths = normalizedRemotePathSet([
    entry.remotePath,
    ...(options.additionalRemotePaths ?? [])
  ])
  const nextState = cloneJsonObject(state)
  const removedProjectIds = cleanupCodexStateContainer(nextState, hostId, remotePaths)
  const atomState = nextState['electron-persisted-atom-state']

  if (isRecord(atomState)) {
    for (const projectId of cleanupCodexStateContainer(atomState, hostId, remotePaths)) {
      removedProjectIds.add(projectId)
    }
  }

  const hostHasRemainingProject = hasCodexStateProjectForHost(nextState, hostId) ||
    (isRecord(atomState) && hasCodexStateProjectForHost(atomState, hostId))

  if (!hostHasRemainingProject) {
    cleanupCodexHostStateContainer(nextState, hostId)
    if (isRecord(atomState)) {
      cleanupCodexHostStateContainer(atomState, hostId)
    }
  }

  cleanupProjectReferences(nextState, atomState, removedProjectIds)

  return nextState
}

function normalizeCodexStateContainer (
  container: Record<string, unknown>,
  hostId: string,
  canonicalRemotePath: string,
  legacyRemotePaths: Set<string>
): Set<string> {
  const removedProjectIds = new Set<string>()
  const remoteProjects = container['remote-projects']

  if (!Array.isArray(remoteProjects)) {
    return removedProjectIds
  }

  let matchedProject = false
  container['remote-projects'] = remoteProjects.flatMap((project) => {
    if (!isRecord(project) || project.hostId !== hostId || typeof project.remotePath !== 'string') {
      return [project]
    }

    const remotePath = normalizeRemotePath(project.remotePath)
    if (remotePath !== canonicalRemotePath && !legacyRemotePaths.has(remotePath)) {
      return [project]
    }

    if (matchedProject) {
      if (typeof project.id === 'string') {
        removedProjectIds.add(project.id)
      }
      return []
    }

    matchedProject = true
    return [{
      ...project,
      remotePath: canonicalRemotePath
    }]
  })

  return removedProjectIds
}

export function normalizeCodexGlobalStateProject (
  state: Record<string, unknown>,
  entry: CodexAppProjectEntry,
  options: { legacyRemotePaths?: readonly string[] } = {}
): Record<string, unknown> {
  const hostId = codexDiscoveredRemoteHostId(entry.sshAlias)
  const canonicalRemotePath = normalizeRemotePath(entry.remotePath)
  const legacyRemotePaths = normalizedRemotePathSet(options.legacyRemotePaths)
  const nextState = cloneJsonObject(state)
  const removedProjectIds = normalizeCodexStateContainer(nextState, hostId, canonicalRemotePath, legacyRemotePaths)
  const atomState = nextState['electron-persisted-atom-state']

  if (isRecord(atomState)) {
    for (const projectId of normalizeCodexStateContainer(atomState, hostId, canonicalRemotePath, legacyRemotePaths)) {
      removedProjectIds.add(projectId)
    }
  }

  cleanupProjectReferences(nextState, atomState, removedProjectIds)

  return nextState
}

function readCodexAppConfigFile (configPath: string): CodexAppConfig {
  if (!existsSync(configPath)) {
    return {
      version: CODEX_APP_CONFIG_VERSION,
      remoteConnections: []
    }
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid Codex app config JSON: ${configPath}`, { cause: error })
    }

    throw error
  }

  return parseCodexAppConfig(parsed)
}

function backupPathFor (configPath: string, now: Date): string {
  return `${configPath}.${now.toISOString().replace(/[:.]/gu, '-')}.bak`
}

function writeJsonAtomic (path: string, json: string): void {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmpPath, json)
  renameSync(tmpPath, path)
}

export function installCodexAppConfigProject (
  entry: CodexAppProjectEntry,
  options: { configPath?: string, now?: Date, legacyRemotePaths?: readonly string[] } = {}
): InstallCodexAppConfigResult {
  const configPath = options.configPath ?? defaultCodexAppConfigPath()
  const configDir = dirname(configPath)
  const existingConfigExists = existsSync(configPath)
  const existingConfig = readCodexAppConfigFile(configPath)
  const nextConfig = mergeCodexAppProject(existingConfig, entry, { legacyRemotePaths: options.legacyRemotePaths })
  const nextJson = `${JSON.stringify(nextConfig, null, 2)}\n`
  const existingJson = existingConfigExists ? readFileSync(configPath, 'utf8') : undefined

  if (existingJson === nextJson) {
    return {
      configPath,
      changed: false
    }
  }

  mkdirSync(configDir, { recursive: true })

  let backupPath: string | undefined
  if (existingConfigExists) {
    backupPath = backupPathFor(configPath, options.now ?? new Date())
    copyFileSync(configPath, backupPath)
  }

  writeJsonAtomic(configPath, nextJson)

  return {
    configPath,
    ...(backupPath === undefined ? {} : { backupPath }),
    changed: true
  }
}

export function uninstallCodexAppConfigProject (
  entry: CodexAppProjectEntry,
  options: { configPath?: string, now?: Date, additionalRemotePaths?: readonly string[] } = {}
): UninstallCodexAppConfigResult {
  const configPath = options.configPath ?? defaultCodexAppConfigPath()
  const existingConfigExists = existsSync(configPath)

  if (!existingConfigExists) {
    return {
      configPath,
      changed: false
    }
  }

  const existingConfig = readCodexAppConfigFile(configPath)
  const nextConfig = removeCodexAppProject(existingConfig, entry, { additionalRemotePaths: options.additionalRemotePaths })

  if (JSON.stringify(existingConfig) === JSON.stringify(nextConfig)) {
    return {
      configPath,
      changed: false
    }
  }

  const nextJson = `${JSON.stringify(nextConfig, null, 2)}\n`
  const backupPath = backupPathFor(configPath, options.now ?? new Date())
  copyFileSync(configPath, backupPath)
  writeJsonAtomic(configPath, nextJson)

  return {
    configPath,
    backupPath,
    changed: true
  }
}

export function uninstallCodexGlobalStateProject (
  entry: CodexAppProjectEntry,
  options: { statePath?: string, now?: Date, additionalRemotePaths?: readonly string[] } = {}
): UninstallCodexGlobalStateResult {
  const statePath = options.statePath ?? defaultCodexGlobalStatePath()

  if (!existsSync(statePath)) {
    return {
      statePath,
      changed: false
    }
  }

  const existingJson = readFileSync(statePath, 'utf8')
  const existingState = JSON.parse(existingJson) as unknown

  if (!isRecord(existingState)) {
    throw new Error(`Invalid Codex global state JSON: ${statePath}`)
  }

  const nextState = removeCodexGlobalStateProject(existingState, entry, { additionalRemotePaths: options.additionalRemotePaths })
  const nextJson = `${JSON.stringify(nextState)}\n`

  if (JSON.stringify(existingState) === JSON.stringify(nextState)) {
    return {
      statePath,
      changed: false
    }
  }

  const backupPath = backupPathFor(statePath, options.now ?? new Date())
  copyFileSync(statePath, backupPath)
  writeJsonAtomic(statePath, nextJson)

  return {
    statePath,
    backupPath,
    changed: true
  }
}

export function installCodexGlobalStateProject (
  entry: CodexAppProjectEntry,
  options: { statePath?: string, now?: Date, legacyRemotePaths?: readonly string[] } = {}
): InstallCodexGlobalStateResult {
  const statePath = options.statePath ?? defaultCodexGlobalStatePath()

  if (!existsSync(statePath)) {
    return {
      statePath,
      changed: false
    }
  }

  const existingJson = readFileSync(statePath, 'utf8')
  const existingState = JSON.parse(existingJson) as unknown

  if (!isRecord(existingState)) {
    throw new Error(`Invalid Codex global state JSON: ${statePath}`)
  }

  const nextState = normalizeCodexGlobalStateProject(existingState, entry, { legacyRemotePaths: options.legacyRemotePaths })
  const nextJson = `${JSON.stringify(nextState)}\n`

  if (JSON.stringify(existingState) === JSON.stringify(nextState)) {
    return {
      statePath,
      changed: false
    }
  }

  const backupPath = backupPathFor(statePath, options.now ?? new Date())
  copyFileSync(statePath, backupPath)
  writeJsonAtomic(statePath, nextJson)

  return {
    statePath,
    backupPath,
    changed: true
  }
}
