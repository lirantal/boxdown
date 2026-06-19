import type { WorkspaceContext } from './paths.ts'

export interface ContainerSummary {
  id: string
  name?: string
  state?: string
  status?: string
}

export interface StatusInfo {
  workspace: {
    folder: string
    basename: string
    id: string
  }
  ssh: {
    alias: string
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

interface DockerPsJson {
  ID?: unknown
  Names?: unknown
  State?: unknown
  Status?: unknown
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
      status: typeof parsed.Status === 'string' && parsed.Status.length > 0 ? parsed.Status : undefined
    }
  })
}

export function createStatusInfo (
  context: WorkspaceContext,
  alias: string,
  container: ContainerSummary | undefined,
  exists: (path: string) => boolean
): StatusInfo {
  const state = container?.state?.toLowerCase()

  return {
    workspace: {
      folder: context.workspaceFolder,
      basename: context.workspaceBasename,
      id: context.workspaceId
    },
    ssh: {
      alias,
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

function yesNo (value: boolean, colorEnabled: boolean): string {
  return colorize(value ? 'yes' : 'no', value ? 'green' : 'red', colorEnabled)
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
    `  SSH alias: ${status.ssh.alias}`,
    '',
    'Paths:',
    `  Cache root: ${status.paths.cacheRoot}`,
    `  Data root: ${status.paths.dataRoot}`,
    `  Workspace cache: ${status.paths.workspaceCacheDir}`,
    `  Workspace data: ${status.paths.workspaceDataDir}`,
    `  Generated config: ${status.paths.generatedConfigPath} (${yesNo(status.paths.generatedConfigExists, colorEnabled)})`,
    `  Devcontainer assets: ${status.paths.assetsDevcontainerDir} (${yesNo(status.paths.assetsDevcontainerExists, colorEnabled)})`,
    '',
    'SSH:',
    `  Private key: ${status.ssh.keyPath} (${yesNo(status.ssh.keyExists, colorEnabled)})`,
    `  Public key: ${status.ssh.publicKeyPath} (${yesNo(status.ssh.publicKeyExists, colorEnabled)})`,
    `  Runtime public key: ${status.ssh.publicKeyRuntimePath} (${yesNo(status.ssh.publicKeyRuntimeExists, colorEnabled)})`,
    '',
    'Container:',
    `  State: ${stateText(containerState, healthy, colorEnabled)}`,
    `  Running: ${yesNo(status.container.running, colorEnabled)}`
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
