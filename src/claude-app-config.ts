import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { WorkspaceContext } from './paths.ts'

export const CLAUDE_APP_SUPPORT_DIRNAME = 'Claude'
export const CLAUDE_SSH_CONFIGS_FILENAME = 'ssh_configs.json'

export interface ClaudeSshConfigEntry {
  name: string
  sshHost: string
  id: string
  source?: string
  [key: string]: unknown
}

export interface ClaudeSshConfigs {
  configs: ClaudeSshConfigEntry[]
  trustedHosts: string[]
  [key: string]: unknown
}

export interface ClaudeSshConfigTargetEntry {
  name: string
  sshHost: string
}

export interface InstallClaudeSshConfigResult {
  configPath: string
  backupPath?: string
  changed: boolean
}

export interface UninstallClaudeSshConfigResult {
  configPath: string
  backupPath?: string
  changed: boolean
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseRequiredString (value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid Claude SSH config: ${key} must be a nonempty string`)
  }

  return value.trim()
}

function parseOptionalString (value: unknown, key: string): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string') {
    throw new Error(`Invalid Claude SSH config: ${key} must be a string`)
  }

  return value
}

function parseStringArray (value: unknown, key: string): string[] {
  if (value === undefined) {
    return []
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid Claude SSH config: ${key} must be an array`)
  }

  return value.map((item) => {
    if (typeof item !== 'string') {
      throw new Error(`Invalid Claude SSH config: ${key} entries must be strings`)
    }

    return item
  })
}

function parseClaudeSshConfigEntry (value: unknown): ClaudeSshConfigEntry {
  if (!isRecord(value)) {
    throw new Error('Invalid Claude SSH config: configs entries must be objects')
  }

  const source = parseOptionalString(value.source, 'source')
  const parsed: ClaudeSshConfigEntry = {
    ...value,
    name: parseRequiredString(value.name, 'name'),
    sshHost: parseRequiredString(value.sshHost, 'sshHost'),
    id: parseRequiredString(value.id, 'id')
  }

  if (source !== undefined) {
    parsed.source = source
  } else {
    delete parsed.source
  }

  return parsed
}

export function parseClaudeSshConfigs (value: unknown): ClaudeSshConfigs {
  if (!isRecord(value)) {
    throw new Error('Invalid Claude SSH config: top-level value must be an object')
  }

  const configs = value.configs
  if (configs !== undefined && !Array.isArray(configs)) {
    throw new Error('Invalid Claude SSH config: configs must be an array')
  }

  return {
    ...value,
    configs: (configs ?? []).map((config) => parseClaudeSshConfigEntry(config)),
    trustedHosts: parseStringArray(value.trustedHosts, 'trustedHosts')
  }
}

export function defaultClaudeSshConfigsPath (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (env.BOXDOWN_CLAUDE_SSH_CONFIGS !== undefined) {
    return env.BOXDOWN_CLAUDE_SSH_CONFIGS
  }

  const home = env.HOME ?? homedir()

  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', CLAUDE_APP_SUPPORT_DIRNAME, CLAUDE_SSH_CONFIGS_FILENAME)
  }

  if (platform === 'win32') {
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), CLAUDE_APP_SUPPORT_DIRNAME, CLAUDE_SSH_CONFIGS_FILENAME)
  }

  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), CLAUDE_APP_SUPPORT_DIRNAME, CLAUDE_SSH_CONFIGS_FILENAME)
}

export function claudeSshConfigEntryForWorkspace (context: WorkspaceContext, sshHost: string): ClaudeSshConfigTargetEntry {
  return {
    name: context.workspaceBasename,
    sshHost
  }
}

function readClaudeSshConfigsFile (configPath: string): ClaudeSshConfigs {
  if (!existsSync(configPath)) {
    return {
      configs: [],
      trustedHosts: []
    }
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid Claude SSH config JSON: ${configPath}`, { cause: error })
    }

    throw error
  }

  return parseClaudeSshConfigs(parsed)
}

function backupPathFor (configPath: string, now: Date): string {
  return `${configPath}.${now.toISOString().replace(/[:.]/gu, '-')}.bak`
}

function writeJsonAtomic (path: string, json: string): void {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmpPath, json)
  renameSync(tmpPath, path)
}

function withTrustedHost (trustedHosts: readonly string[], sshHost: string): string[] {
  return [...new Set([...trustedHosts, sshHost])]
}

export function mergeClaudeSshConfigHost (
  config: ClaudeSshConfigs,
  entry: ClaudeSshConfigTargetEntry,
  createId: () => string = randomUUID
): ClaudeSshConfigs {
  let matched = false
  const configs = config.configs.map((configEntry) => {
    if (configEntry.sshHost !== entry.sshHost) {
      return configEntry
    }

    matched = true
    return {
      ...configEntry,
      name: entry.name,
      sshHost: entry.sshHost
    }
  })

  if (!matched) {
    configs.push({
      name: entry.name,
      sshHost: entry.sshHost,
      id: createId(),
      source: 'desktop'
    })
  }

  return {
    ...config,
    configs,
    trustedHosts: withTrustedHost(config.trustedHosts, entry.sshHost)
  }
}

export function removeClaudeSshConfigHost (
  config: ClaudeSshConfigs,
  entry: ClaudeSshConfigTargetEntry
): ClaudeSshConfigs {
  return {
    ...config,
    configs: config.configs.filter((configEntry) => configEntry.sshHost !== entry.sshHost),
    trustedHosts: config.trustedHosts.filter((trustedHost) => trustedHost !== entry.sshHost)
  }
}

export function installClaudeSshConfigHost (
  entry: ClaudeSshConfigTargetEntry,
  options: { configPath?: string, now?: Date, createId?: () => string } = {}
): InstallClaudeSshConfigResult {
  const configPath = options.configPath ?? defaultClaudeSshConfigsPath()
  const configDir = dirname(configPath)
  const existingConfigExists = existsSync(configPath)
  const existingConfig = readClaudeSshConfigsFile(configPath)
  const nextConfig = mergeClaudeSshConfigHost(existingConfig, entry, options.createId)
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

export function uninstallClaudeSshConfigHost (
  entry: ClaudeSshConfigTargetEntry,
  options: { configPath?: string, now?: Date } = {}
): UninstallClaudeSshConfigResult {
  const configPath = options.configPath ?? defaultClaudeSshConfigsPath()
  const existingConfigExists = existsSync(configPath)

  if (!existingConfigExists) {
    return {
      configPath,
      changed: false
    }
  }

  const existingConfig = readClaudeSshConfigsFile(configPath)
  const nextConfig = removeClaudeSshConfigHost(existingConfig, entry)

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
