import { readFileSync } from 'node:fs'

import type { WorkspaceContext } from './paths.ts'
import { buildSshConfigBlock, defaultSshConfigPath } from './ssh-config.ts'

export type SshAliasSource = 'default' | 'provided'
export type SshManagedBlockState = 'missing' | 'installed' | 'outdated'

export interface ContainerSummary {
  id: string
  name?: string
  state?: string
  status?: string
  localFolder?: string
}

export interface StatusInfo {
  workspace: {
    folder: string
    basename: string
    id: string
  }
  ssh: {
    alias: string
    aliasSource: SshAliasSource
    configPath: string
    configExists: boolean
    managedBlockState: SshManagedBlockState
    keyPath: string
    keyExists: boolean
    publicKeyPath: string
    publicKeyExists: boolean
    publicKeyRuntimePath: string
    publicKeyRuntimeExists: boolean
  }
  paths: {
    cacheRoot: string
    dataRoot: string
    workspaceCacheDir: string
    workspaceDataDir: string
    generatedConfigPath: string
    generatedConfigExists: boolean
    assetsDevcontainerDir: string
    assetsDevcontainerExists: boolean
  }
  container: {
    found: boolean
    running: boolean
    id?: string
    name?: string
    state?: string
    status?: string
  }
}

export interface SshConfigStatus {
  configPath: string
  configExists: boolean
  managedBlockState: SshManagedBlockState
}

interface DockerPsJson {
  ID?: unknown
  Names?: unknown
  State?: unknown
  Status?: unknown
  Labels?: unknown
}

function dockerLabelsFromString (labels: string): Record<string, string> {
  return Object.fromEntries(labels
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0)
    .map((label) => {
      const separator = label.indexOf('=')
      return separator === -1 ? [label, ''] : [label.slice(0, separator), label.slice(separator + 1)]
    }))
}

export function parseDockerPsJsonLines (output: string): ContainerSummary[] {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0)

  return lines.map((line) => {
    let parsed: DockerPsJson

    try {
      parsed = JSON.parse(line) as DockerPsJson
    } catch {
      throw new Error(`Could not parse docker ps output: ${line}`)
    }

    if (typeof parsed.ID !== 'string' || parsed.ID.length === 0) {
      throw new Error(`Docker ps output is missing container ID: ${line}`)
    }

    return {
      id: parsed.ID,
      name: typeof parsed.Names === 'string' && parsed.Names.length > 0 ? parsed.Names : undefined,
      state: typeof parsed.State === 'string' && parsed.State.length > 0 ? parsed.State : undefined,
      status: typeof parsed.Status === 'string' && parsed.Status.length > 0 ? parsed.Status : undefined,
      localFolder: typeof parsed.Labels === 'string' ? dockerLabelsFromString(parsed.Labels)['devcontainer.local_folder'] : undefined
    }
  })
}

function readFileUtf8 (path: string): string {
  return readFileSync(path, 'utf8')
}

function managedSshBlockMarkers (alias: string): { begin: string, end: string } {
  return {
    begin: `# BEGIN ${alias} boxdown devcontainer ssh`,
    end: `# END ${alias} boxdown devcontainer ssh`
  }
}

function findManagedSshConfigBlock (config: string, alias: string): string | undefined {
  const { begin, end } = managedSshBlockMarkers(alias)
  const beginIndex = config.indexOf(begin)

  if (beginIndex === -1) {
    return undefined
  }

  const endIndex = config.indexOf(end, beginIndex)

  if (endIndex === -1) {
    return ''
  }

  const afterEndMarkerIndex = endIndex + end.length
  const afterEndLineIndex = config[afterEndMarkerIndex] === '\n' ? afterEndMarkerIndex + 1 : afterEndMarkerIndex

  return config.slice(beginIndex, afterEndLineIndex)
}

export function inspectSshConfigStatus (
  context: WorkspaceContext,
  alias: string,
  configPath: string,
  exists: (path: string) => boolean,
  readFile: (path: string) => string = readFileUtf8
): SshConfigStatus {
  const configExists = exists(configPath)

  if (!configExists) {
    return {
      configPath,
      configExists,
      managedBlockState: 'missing'
    }
  }

  const config = readFile(configPath)
  const managedBlock = findManagedSshConfigBlock(config, alias)

  if (managedBlock === undefined) {
    return {
      configPath,
      configExists,
      managedBlockState: 'missing'
    }
  }

  return {
    configPath,
    configExists,
    managedBlockState: managedBlock === buildSshConfigBlock(context, alias) ? 'installed' : 'outdated'
  }
}

export function createStatusInfo (
  context: WorkspaceContext,
  alias: string,
  container: ContainerSummary | undefined,
  exists: (path: string) => boolean,
  options: {
    aliasSource?: SshAliasSource
    sshConfigPath?: string
    readFile?: (path: string) => string
  } = {}
): StatusInfo {
  const state = container?.state?.toLowerCase()
  const sshConfig = inspectSshConfigStatus(
    context,
    alias,
    options.sshConfigPath ?? defaultSshConfigPath(),
    exists,
    options.readFile
  )

  return {
    workspace: {
      folder: context.workspaceFolder,
      basename: context.workspaceBasename,
      id: context.workspaceId
    },
    ssh: {
      alias,
      aliasSource: options.aliasSource ?? 'provided',
      configPath: sshConfig.configPath,
      configExists: sshConfig.configExists,
      managedBlockState: sshConfig.managedBlockState,
      keyPath: context.sshKeyPath,
      keyExists: exists(context.sshKeyPath),
      publicKeyPath: context.sshPublicKeyPath,
      publicKeyExists: exists(context.sshPublicKeyPath),
      publicKeyRuntimePath: context.sshPublicKeyRuntimePath,
      publicKeyRuntimeExists: exists(context.sshPublicKeyRuntimePath)
    },
    paths: {
      cacheRoot: context.cacheRoot,
      dataRoot: context.dataRoot,
      workspaceCacheDir: context.workspaceCacheDir,
      workspaceDataDir: context.workspaceDataDir,
      generatedConfigPath: context.generatedConfigPath,
      generatedConfigExists: exists(context.generatedConfigPath),
      assetsDevcontainerDir: context.assetsDevcontainerDir,
      assetsDevcontainerExists: exists(context.assetsDevcontainerDir)
    },
    container: {
      found: container !== undefined,
      running: state === 'running',
      id: container?.id,
      name: container?.name,
      state: container?.state,
      status: container?.status
    }
  }
}

export function statusIsHealthy (status: StatusInfo): boolean {
  return status.paths.generatedConfigExists &&
    status.paths.assetsDevcontainerExists &&
    status.ssh.keyExists &&
    status.ssh.publicKeyExists &&
    status.ssh.publicKeyRuntimeExists &&
    status.container.found &&
    status.container.running
}

const color = {
  green: '\u001B[32m',
  red: '\u001B[31m',
  reset: '\u001B[0m'
}

function colorize (value: string, colorName: 'green' | 'red', enabled: boolean): string {
  if (!enabled) {
    return value
  }

  return `${color[colorName]}${value}${color.reset}`
}

function existenceText (value: boolean, colorEnabled: boolean): string {
  return colorize(value ? 'exists' : 'missing', value ? 'green' : 'red', colorEnabled)
}

function runningText (value: boolean, colorEnabled: boolean): string {
  return colorize(value ? 'yes' : 'no', value ? 'green' : 'red', colorEnabled)
}

function managedBlockText (state: SshManagedBlockState, colorEnabled: boolean): string {
  return colorize(state, state === 'installed' ? 'green' : 'red', colorEnabled)
}

function aliasSourceText (source: SshAliasSource): string {
  return source === 'default' ? 'computed default' : 'provided'
}

function installedText (state: SshManagedBlockState): string {
  return state === 'installed' ? 'installed' : 'not installed'
}

function stateText (state: string, healthy: boolean, colorEnabled: boolean): string {
  return colorize(state, healthy ? 'green' : 'red', colorEnabled)
}

export function formatStatusText (status: StatusInfo, options: { color?: boolean } = {}): string {
  const colorEnabled = options.color ?? false
  const containerState = status.container.found ? status.container.state ?? 'unknown' : 'absent'
  const healthy = statusIsHealthy(status)
  const lines = [
    'Boxdown status',
    '',
    'Workspace:',
    `  Path: ${status.workspace.folder}`,
    `  Name: ${status.workspace.basename}`,
    `  ID: ${status.workspace.id}`,
    `  SSH alias: ${status.ssh.alias} (${aliasSourceText(status.ssh.aliasSource)}; ${installedText(status.ssh.managedBlockState)})`,
    '',
    'Paths:',
    `  Cache root: ${status.paths.cacheRoot}`,
    `  Data root: ${status.paths.dataRoot}`,
    `  Workspace cache: ${status.paths.workspaceCacheDir}`,
    `  Workspace data: ${status.paths.workspaceDataDir}`,
    `  Generated config: ${status.paths.generatedConfigPath} (${existenceText(status.paths.generatedConfigExists, colorEnabled)})`,
    `  Devcontainer assets: ${status.paths.assetsDevcontainerDir} (${existenceText(status.paths.assetsDevcontainerExists, colorEnabled)})`,
    '',
    'SSH:',
    `  SSH config: ${status.ssh.configPath} (${existenceText(status.ssh.configExists, colorEnabled)})`,
    `  Boxdown SSH block: ${managedBlockText(status.ssh.managedBlockState, colorEnabled)}`,
    `  Private key: ${status.ssh.keyPath} (${existenceText(status.ssh.keyExists, colorEnabled)})`,
    `  Public key: ${status.ssh.publicKeyPath} (${existenceText(status.ssh.publicKeyExists, colorEnabled)})`,
    `  Runtime public key: ${status.ssh.publicKeyRuntimePath} (${existenceText(status.ssh.publicKeyRuntimeExists, colorEnabled)})`,
    '',
    'Container:',
    `  State: ${stateText(containerState, healthy, colorEnabled)}`,
    `  Running: ${runningText(status.container.running, colorEnabled)}`
  ]

  if (status.container.id !== undefined) {
    lines.push(`  ID: ${status.container.id}`)
  }

  if (status.container.name !== undefined) {
    lines.push(`  Name: ${status.container.name}`)
  }

  if (status.container.status !== undefined) {
    lines.push(`  Docker status: ${status.container.status}`)
  }

  return `${lines.join('\n')}\n`
}
