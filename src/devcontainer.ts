import {
  BOXDOWN_CONTAINER_DEVCONTAINER_DIR
} from './constants.ts'
import { buildGeneratedDevcontainerConfig, publishContainerPortFromConfig, writeGeneratedDevcontainerConfig } from './config.ts'
import { codingAgentBinary, type CodingAgentCli } from './coding-agents.ts'
import { resolveDevcontainerCli } from './devcontainer-cli.ts'
import { configureWorkspaceGithubGitAuth } from './github-git-auth.ts'
import { recordWorkspaceDockerImage } from './metadata.ts'
import type { WorkspaceContext } from './paths.ts'
import { runBuffered, runInteractive } from './process.ts'
import { assertProgressCommandSucceeded, type ProgressReporter, runProgressCommand } from './progress.ts'
import { interactiveCommandScript, interactiveShellEnvArgs, interactiveShellScript } from './shell.ts'
import { ensureHostSshKey } from './ssh-key.ts'
import { type ContainerSummary, parseDockerPsJsonLines } from './status.ts'

export interface StartOptions {
  recreate?: boolean
  proxyMode?: boolean
  progress?: ProgressReporter
  reuseRunning?: boolean
}

export interface ContainerCommandOptions {
  progress?: ProgressReporter
}

export interface TunnelPortForward {
  localPort: number
  remotePort: number
}

export interface SshTunnelOptions {
  bindAddress?: string
  remoteHost?: string
}

export interface DockerImageInfo {
  id: string
  name?: string
}

interface DockerInspectContainer {
  Image?: unknown
  Config?: unknown
}

function devcontainerWorkspaceArgs (context: WorkspaceContext): string[] {
  return [
    '--workspace-folder',
    context.workspaceFolder,
    '--override-config',
    context.generatedConfigPath
  ]
}

function log (message: string, proxyMode = false): void {
  if (proxyMode) {
    process.stderr.write(`${message}\n`)
  } else {
    process.stdout.write(`${message}\n`)
  }
}

function containerProgressEnvArgs (progress?: ProgressReporter): string[] {
  if (progress === undefined) {
    return []
  }

  return [
    'env',
    `BOXDOWN_VERBOSE=${progress.verbose ? '1' : '0'}`,
    `BOXDOWN_PROGRESS=${progress.verbose ? '0' : '1'}`
  ]
}

export function parseContainerIdFromUpOutput (output: string): string | undefined {
  return /"containerId"\s*:\s*"([^"]+)"/.exec(output)?.[1]
}

export async function findWorkspaceContainer (context: WorkspaceContext): Promise<ContainerSummary | undefined> {
  const result = await runBuffered('docker', [
    'ps',
    '-a',
    '--filter',
    `label=devcontainer.local_folder=${context.workspaceFolder}`,
    '--format',
    '{{json .}}'
  ], {
    mirrorStdout: false,
    mirrorStderr: false
  })

  if (result.code !== 0) {
    throw new Error(`Could not inspect devcontainer for ${context.workspaceFolder}`)
  }

  return parseDockerPsJsonLines(result.stdout)[0]
}

export async function listWorkspaceContainers (): Promise<ContainerSummary[] | undefined> {
  const result = await runBuffered('docker', [
    'ps',
    '-a',
    '--filter',
    'label=devcontainer.local_folder',
    '--format',
    '{{json .}}'
  ], {
    mirrorStdout: false,
    mirrorStderr: false
  })

  if (result.code !== 0) {
    return undefined
  }

  return parseDockerPsJsonLines(result.stdout)
}

export async function findRunningContainerId (context: WorkspaceContext): Promise<string | undefined> {
  const result = await runBuffered('docker', [
    'ps',
    '--filter',
    `label=devcontainer.local_folder=${context.workspaceFolder}`,
    '--format',
    '{{.ID}}'
  ], {
    mirrorStdout: false,
    mirrorStderr: false
  })

  if (result.code !== 0) {
    return undefined
  }

  return result.stdout.split(/\r?\n/).find((line) => line.length > 0)
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseDockerInspectImage (output: string, containerId: string): DockerImageInfo | undefined {
  const trimmed = output.trim()

  if (trimmed.length === 0) {
    return undefined
  }

  let parsed: DockerInspectContainer

  try {
    parsed = JSON.parse(trimmed) as DockerInspectContainer
  } catch (error) {
    throw new Error(`Could not parse docker inspect output for ${containerId}`, { cause: error })
  }

  if (typeof parsed.Image !== 'string' || parsed.Image.length === 0) {
    return undefined
  }

  const configImage = isRecord(parsed.Config) && typeof parsed.Config.Image === 'string' && parsed.Config.Image.length > 0
    ? parsed.Config.Image
    : undefined

  return {
    id: parsed.Image,
    ...(configImage === undefined ? {} : { name: configImage })
  }
}

export async function inspectContainerImage (containerId: string): Promise<DockerImageInfo | undefined> {
  const result = await runBuffered('docker', [
    'inspect',
    '--format',
    '{{json .}}',
    containerId
  ], {
    mirrorStdout: false,
    mirrorStderr: false
  })

  if (result.code !== 0) {
    throw new Error(`Could not inspect devcontainer image for ${containerId}`)
  }

  return parseDockerInspectImage(result.stdout, containerId)
}

async function recordContainerImageIfPresent (context: WorkspaceContext, containerId: string): Promise<void> {
  try {
    const image = await inspectContainerImage(containerId)

    if (image !== undefined) {
      recordWorkspaceDockerImage(context, image)
    }
  } catch {
    process.stderr.write(`Warning: could not record devcontainer image metadata for ${containerId}.\n`)
  }
}

export async function stopWorkspaceContainer (context: WorkspaceContext): Promise<void> {
  const container = await findWorkspaceContainer(context)

  if (container === undefined) {
    process.stdout.write(`No devcontainer found for: ${context.workspaceFolder}\n`)
    return
  }

  if (container.state?.toLowerCase() !== 'running') {
    process.stdout.write(`Devcontainer is not running for: ${context.workspaceFolder}\n`)
    return
  }

  const result = await runBuffered('docker', ['stop', container.id], {
    mirrorStdout: false,
    mirrorStderr: false
  })

  if (result.code !== 0) {
    throw new Error(`Could not stop devcontainer ${container.id}`)
  }

  process.stdout.write(`Stopped devcontainer: ${container.id}\n`)
}

export async function removeWorkspaceContainer (context: WorkspaceContext): Promise<void> {
  const container = await findWorkspaceContainer(context)

  if (container === undefined) {
    process.stdout.write(`No devcontainer found for: ${context.workspaceFolder}\n`)
    return
  }

  await removeContainerById(container.id)
  process.stdout.write(`Removed devcontainer: ${container.id}\n`)
}

export async function removeContainerById (containerId: string, options: { volumes?: boolean } = {}): Promise<void> {
  const result = await runBuffered('docker', [
    'rm',
    '-f',
    ...(options.volumes === true ? ['-v'] : []),
    containerId
  ], {
    mirrorStdout: false,
    mirrorStderr: false
  })

  if (result.code !== 0) {
    throw new Error(`Could not remove devcontainer ${containerId}`)
  }
}

function dockerImageMissing (stderr: string): boolean {
  return /No such image/i.test(stderr) || /not found/i.test(stderr)
}

export async function removeDockerImage (imageId: string): Promise<boolean> {
  const result = await runBuffered('docker', ['image', 'rm', '-f', imageId], {
    mirrorStdout: false,
    mirrorStderr: false
  })

  if (result.code !== 0) {
    if (dockerImageMissing(result.stderr)) {
      process.stdout.write(`Docker image already absent: ${imageId}\n`)
      return false
    }

    throw new Error(`Could not remove Docker image ${imageId}`)
  }

  process.stdout.write(`Removed Docker image: ${imageId}\n`)
  return true
}

export async function startDevcontainer (context: WorkspaceContext, options: StartOptions = {}): Promise<string> {
  const progress = options.progress
  const proxyMode = options.proxyMode ?? false

  progress?.item('Preparing SSH identity')
  await ensureHostSshKey(context, {
    quiet: proxyMode,
    progress
  })

  progress?.item(`Writing generated devcontainer config: ${context.generatedConfigPath}`)
  writeGeneratedDevcontainerConfig(context)

  if (options.reuseRunning === true && options.recreate !== true) {
    const runningContainerId = await findRunningContainerId(context)

    if (runningContainerId !== undefined) {
      if (progress === undefined) {
        log(`Using running devcontainer for: ${context.workspaceFolder}`, proxyMode)
      } else {
        progress.item(`Using running devcontainer: ${runningContainerId}`)
      }
      await recordContainerImageIfPresent(context, runningContainerId)
      return runningContainerId
    }
  }

  const cli = resolveDevcontainerCli(context)
  if (progress === undefined) {
    log(`Starting devcontainer for: ${context.workspaceFolder}`, proxyMode)
  } else {
    progress.item(`Starting devcontainer for: ${context.workspaceFolder}`)
  }

  const args = [
    'up',
    ...devcontainerWorkspaceArgs(context)
  ]

  if (options.recreate === true) {
    args.push('--remove-existing-container')
    if (progress === undefined) {
      log('Removing existing dev container so create-time settings apply.', proxyMode)
    } else {
      progress.item('Removing existing devcontainer before start')
    }
  }

  const result = progress === undefined
    ? await runBuffered(cli.command, [...cli.argsPrefix, ...args], {
        mirrorStdout: proxyMode ? 'stderr' : 'stdout',
        mirrorStderr: 'stderr'
      })
    : await runProgressCommand('devcontainer up', cli.command, [...cli.argsPrefix, ...args], {
        progress,
        verboseStdout: proxyMode ? 'stderr' : 'stdout',
        verboseStderr: 'stderr'
      })

  if (progress === undefined && result.code !== 0) {
    throw new Error(`devcontainer up failed for ${context.workspaceFolder}`)
  }

  if (progress !== undefined) {
    assertProgressCommandSucceeded('devcontainer up', result, `devcontainer up failed for ${context.workspaceFolder}`)
  }

  const containerId = parseContainerIdFromUpOutput(`${result.stdout}\n${result.stderr}`) ?? await findRunningContainerId(context)

  if (containerId === undefined) {
    throw new Error(`Could not resolve devcontainer ID for ${context.workspaceFolder}`)
  }

  await recordContainerImageIfPresent(context, containerId)
  return containerId
}

export async function printPortHint (context: WorkspaceContext, containerId: string): Promise<void> {
  const config = buildGeneratedDevcontainerConfig(context)
  const containerPort = publishContainerPortFromConfig(config)

  if (containerPort === undefined) {
    process.stderr.write('Warning: could not find a runArgs publish port.\n')
    return
  }

  const result = await runBuffered('docker', ['port', containerId, `${containerPort}/tcp`], {
    mirrorStdout: false,
    mirrorStderr: false
  })

  const hostBinding = result.stdout.split(/\r?\n/).find((line) => line.length > 0)

  if (result.code === 0 && hostBinding !== undefined) {
    process.stdout.write(`\nDev server available at: http://${hostBinding}\n\n`)
  } else {
    process.stderr.write(`Warning: container is running but port ${containerPort}/tcp is not mapped.\n`)
  }
}

export async function openShell (context: WorkspaceContext): Promise<number> {
  const cli = resolveDevcontainerCli(context)
  process.stdout.write('Dropping into container shell...\n')

  return runInteractive(cli.command, [
    ...cli.argsPrefix,
    'exec',
    ...devcontainerWorkspaceArgs(context),
    '--',
    'env',
    ...interactiveShellEnvArgs(),
    'bash',
    '-c',
    interactiveShellScript()
  ])
}

export function codingAgentDevcontainerExecArgs (context: WorkspaceContext, agent: CodingAgentCli, agentArgs: string[] = []): string[] {
  return [
    'exec',
    ...devcontainerWorkspaceArgs(context),
    '--',
    'env',
    ...interactiveShellEnvArgs(),
    'bash',
    '-c',
    interactiveCommandScript(),
    'boxdown-agent',
    codingAgentBinary(agent),
    ...agentArgs
  ]
}

export async function openCodingAgentCli (context: WorkspaceContext, agent: CodingAgentCli, agentArgs: string[] = []): Promise<number> {
  const cli = resolveDevcontainerCli(context)
  process.stdout.write(`Dropping into ${codingAgentBinary(agent)} inside the devcontainer...\n`)

  return runInteractive(cli.command, [
    ...cli.argsPrefix,
    ...codingAgentDevcontainerExecArgs(context, agent, agentArgs)
  ])
}

export async function ensureContainerSshRuntime (context: WorkspaceContext, options: ContainerCommandOptions = {}): Promise<void> {
  const cli = resolveDevcontainerCli(context)
  options.progress?.item('Preparing container SSH runtime')
  const args = [
    ...cli.argsPrefix,
    'exec',
    ...devcontainerWorkspaceArgs(context),
    '--',
    ...containerProgressEnvArgs(options.progress),
    'bash',
    `${BOXDOWN_CONTAINER_DEVCONTAINER_DIR}/utils/ssh-bootstrap.sh`,
    'runtime'
  ]
  const result = options.progress === undefined
    ? await runBuffered(cli.command, args, {
        mirrorStdout: 'stderr',
        mirrorStderr: 'stderr'
      })
    : await runProgressCommand('prepare SSH runtime', cli.command, args, {
        progress: options.progress,
        verboseStdout: 'stderr',
        verboseStderr: 'stderr'
      })

  if (options.progress === undefined && result.code !== 0) {
    throw new Error('Failed to prepare devcontainer SSH runtime')
  }

  if (options.progress !== undefined) {
    assertProgressCommandSucceeded('prepare SSH runtime', result, 'Failed to prepare devcontainer SSH runtime')
  }
}

export async function refreshContainerCodingAgentClis (
  context: WorkspaceContext,
  proxyMode = false,
  agents: CodingAgentCli[] = [],
  options: ContainerCommandOptions = {}
): Promise<void> {
  const cli = resolveDevcontainerCli(context)
  options.progress?.item(agents.length === 0
    ? 'Refreshing default coding-agent CLIs'
    : `Refreshing coding-agent CLIs: ${agents.map(codingAgentBinary).join(', ')}`)
  const args = [
    ...cli.argsPrefix,
    'exec',
    ...devcontainerWorkspaceArgs(context),
    '--',
    ...containerProgressEnvArgs(options.progress),
    'bash',
    `${BOXDOWN_CONTAINER_DEVCONTAINER_DIR}/utils/coding-agent-cli-update.sh`,
    'maybe-update',
    ...agents
  ]
  const result = options.progress === undefined
    ? await runBuffered(cli.command, args, {
        mirrorStdout: proxyMode ? 'stderr' : 'stdout',
        mirrorStderr: 'stderr'
      })
    : await runProgressCommand('refresh coding-agent CLIs', cli.command, args, {
        progress: options.progress,
        verboseStdout: proxyMode ? 'stderr' : 'stdout',
        verboseStderr: 'stderr'
      })

  if (result.code !== 0) {
    if (options.progress === undefined) {
      process.stderr.write('Warning: could not refresh one or more coding-agent CLIs inside the devcontainer.\n')
    } else {
      options.progress.warn('Could not refresh one or more coding-agent CLIs inside the devcontainer.')
    }
  }
}

export async function ensureContainerCodingAgentCli (
  context: WorkspaceContext,
  agent: CodingAgentCli,
  options: ContainerCommandOptions = {}
): Promise<void> {
  const cli = resolveDevcontainerCli(context)
  options.progress?.item(`Preparing ${codingAgentBinary(agent)} inside the devcontainer`)
  const args = [
    ...cli.argsPrefix,
    'exec',
    ...devcontainerWorkspaceArgs(context),
    '--',
    ...containerProgressEnvArgs(options.progress),
    'bash',
    `${BOXDOWN_CONTAINER_DEVCONTAINER_DIR}/utils/coding-agent-cli-update.sh`,
    'ensure',
    agent
  ]
  const result = options.progress === undefined
    ? await runBuffered(cli.command, args, {
        mirrorStdout: 'stdout',
        mirrorStderr: 'stderr'
      })
    : await runProgressCommand(`prepare ${codingAgentBinary(agent)}`, cli.command, args, {
        progress: options.progress,
        verboseStdout: 'stdout',
        verboseStderr: 'stderr'
      })

  if (options.progress === undefined && result.code !== 0) {
    throw new Error(`Could not install or refresh ${codingAgentBinary(agent)} inside the devcontainer`)
  }

  if (options.progress !== undefined) {
    assertProgressCommandSucceeded(`prepare ${codingAgentBinary(agent)}`, result, `Could not install or refresh ${codingAgentBinary(agent)} inside the devcontainer`)
  }
}

export async function runSshdProxy (containerId: string): Promise<number> {
  return runInteractive('docker', [
    'exec',
    '-i',
    containerId,
    '/usr/sbin/sshd',
    '-i',
    '-o',
    'LogLevel=QUIET',
    '-o',
    'PubkeyAuthentication=yes',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'AllowTcpForwarding=yes',
    '-o',
    'AllowStreamLocalForwarding=yes',
    '-o',
    'PermitTTY=yes'
  ])
}

export function sshTunnelArgs (alias: string, ports: TunnelPortForward[], options: SshTunnelOptions = {}): string[] {
  const bindAddress = options.bindAddress ?? '127.0.0.1'
  const remoteHost = options.remoteHost ?? 'localhost'

  return [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    ...ports.flatMap((port) => [
      '-L',
      `${bindAddress}:${port.localPort}:${remoteHost}:${port.remotePort}`
    ]),
    alias
  ]
}

export async function openSshTunnel (alias: string, ports: TunnelPortForward[], options: SshTunnelOptions = {}): Promise<number> {
  return runInteractive('ssh', sshTunnelArgs(alias, ports, options))
}

async function hostGhTokenOrEmpty (): Promise<string> {
  const result = await runBuffered('gh', ['auth', 'token'], {
    mirrorStdout: false,
    mirrorStderr: false
  })

  if (result.code !== 0) {
    return ''
  }

  return result.stdout.trim()
}

export async function refreshContainerGhAuth (context: WorkspaceContext, options: ContainerCommandOptions = {}): Promise<void> {
  const progress = options.progress
  progress?.item('Preparing generated config for GitHub auth refresh')
  await ensureHostSshKey(context, {
    quiet: true,
    progress
  })
  writeGeneratedDevcontainerConfig(context)

  progress?.item('Reading host GitHub CLI token')
  const token = await hostGhTokenOrEmpty()

  if (token.length === 0) {
    progress?.warn('Host GitHub CLI token unavailable; skipping container auth refresh.')
    return
  }

  const cli = resolveDevcontainerCli(context)
  progress?.item('Refreshing GitHub CLI auth inside the devcontainer')
  const loginArgs = [
    ...cli.argsPrefix,
    'exec',
    ...devcontainerWorkspaceArgs(context),
    '--',
    'gh',
    'auth',
    'login',
    '--hostname',
    'github.com',
    '--git-protocol',
    'https',
    '--with-token',
    '--insecure-storage'
  ]
  const login = progress === undefined
    ? await runBuffered(cli.command, loginArgs, {
        input: `${token}\n`,
        mirrorStdout: false,
        mirrorStderr: false
      })
    : await runProgressCommand('refresh GitHub CLI auth', cli.command, loginArgs, {
        input: `${token}\n`,
        progress,
        verboseStdout: false,
        verboseStderr: false
      })

  if (login.code !== 0) {
    if (progress === undefined) {
      process.stderr.write('Warning: could not refresh GitHub CLI auth inside the devcontainer.\n')
    } else {
      progress.warn('Could not refresh GitHub CLI auth inside the devcontainer.')
    }
    return
  }

  progress?.item('Configuring workspace GitHub Git auth')
  const gitAuthConfigured = await configureWorkspaceGithubGitAuth(context.workspaceFolder)
  if (!gitAuthConfigured) {
    if (progress === undefined) {
      process.stderr.write('Warning: GitHub CLI auth refreshed, but GitHub Git auth was not configured for this workspace.\n')
    } else {
      progress.warn('GitHub CLI auth refreshed, but GitHub Git auth was not configured for this workspace.')
    }
  }

  progress?.item('Verifying GitHub CLI auth inside the devcontainer')
  const verifyArgs = [
    ...cli.argsPrefix,
    'exec',
    ...devcontainerWorkspaceArgs(context),
    '--',
    'gh',
    'auth',
    'status',
    '--hostname',
    'github.com'
  ]
  const verify = progress === undefined
    ? await runBuffered(cli.command, verifyArgs, {
        mirrorStdout: false,
        mirrorStderr: false
      })
    : await runProgressCommand('verify GitHub CLI auth', cli.command, verifyArgs, {
        progress,
        verboseStdout: false,
        verboseStderr: false
      })

  if (verify.code === 0) {
    if (progress === undefined) {
      process.stdout.write('GitHub CLI auth refreshed inside the devcontainer.\n')
    } else {
      progress.item('GitHub CLI auth refreshed inside the devcontainer')
    }
  } else {
    if (progress === undefined) {
      process.stderr.write('Warning: GitHub CLI auth refresh completed, but verification failed.\n')
    } else {
      progress.warn('GitHub CLI auth refresh completed, but verification failed.')
    }
  }
}
