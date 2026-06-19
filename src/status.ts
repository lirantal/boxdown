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
      publicKeyExists: exists(context.sshPublicKeyPath)
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

function yesNo (value: boolean): string {
  return value ? 'yes' : 'no'
}

export function formatStatusText (status: StatusInfo): string {
  const containerState = status.container.found ? status.container.state ?? 'unknown' : 'absent'
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
    `  Generated config: ${status.paths.generatedConfigPath} (${yesNo(status.paths.generatedConfigExists)})`,
    `  Devcontainer assets: ${status.paths.assetsDevcontainerDir} (${yesNo(status.paths.assetsDevcontainerExists)})`,
    '',
    'SSH:',
    `  Private key: ${status.ssh.keyPath} (${yesNo(status.ssh.keyExists)})`,
    `  Public key: ${status.ssh.publicKeyPath} (${yesNo(status.ssh.publicKeyExists)})`,
    '',
    'Container:',
    `  State: ${containerState}`,
    `  Running: ${yesNo(status.container.running)}`
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
