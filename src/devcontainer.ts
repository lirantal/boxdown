import {
  BOXDOWN_CONTAINER_DEVCONTAINER_DIR
} from './constants.ts'
import { buildGeneratedDevcontainerConfig, publishContainerPortFromConfig, writeGeneratedDevcontainerConfig } from './config.ts'
import { codingAgentBinary, type CodingAgentCli } from './coding-agents.ts'
import { resolveDevcontainerCli } from './devcontainer-cli.ts'
import { configureWorkspaceGithubGitAuth } from './github-git-auth.ts'
import type { WorkspaceCommandLogger } from './logging.ts'
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
  logger?: WorkspaceCommandLogger
  reuseRunning?: boolean
}

export interface ContainerCommandOptions {
  progress?: ProgressReporter
  logger?: WorkspaceCommandLogger
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

export async function findWorkspaceContainer (context: WorkspaceContext, options: { logger?: WorkspaceCommandLogger } = {}): Promise<ContainerSummary | undefined> {
  const result = await runBuffered('docker', [
    'ps',
    '-a',
    '--filter',
    `label=devcontainer.local_folder=${context.workspaceFolder}`,
    '--format',
    '{{json .}}'
  ], {
    logger: options.logger,
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

export async function findRunningContainerId (context: WorkspaceContext, options: { logger?: WorkspaceCommandLogger } = {}): Promise<string | undefined> {
  const result = await runBuffered('docker', [
    'ps',
    '--filter',
    `label=devcontainer.local_folder=${context.workspaceFolder}`,
    '--format',
    '{{.ID}}'
  ], {
    logger: options.logger,
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

export async function inspectContainerImage (containerId: string, options: { logger?: WorkspaceCommandLogger } = {}): Promise<DockerImageInfo | undefined> {
  const result = await runBuffered('docker', [
    'inspect',
    '--format',
    '{{json .}}',
    containerId
  ], {
    logger: options.logger,
    mirrorStdout: false,
    mirrorStderr: false
  })

  if (result.code !== 0) {
    throw new Error(`Could not inspect devcontainer image for ${containerId}`)
  }

  return parseDockerInspectImage(result.stdout, containerId)
}

async function recordContainerImageIfPresent (context: WorkspaceContext, containerId: string, logger?: WorkspaceCommandLogger): Promise<void> {
  try {
    const image = await inspectContainerImage(containerId, { logger })

    if (image !== undefined) {
      recordWorkspaceDockerImage(context, image)
    }
  } catch {
    process.stderr.write(`Warning: could not record devcontainer image metadata for ${containerId}.\n`)
  }
}

export async function stopWorkspaceContainer (context: WorkspaceContext, options: { logger?: WorkspaceCommandLogger } = {}): Promise<void> {
  const container = await findWorkspaceContainer(context, { logger: options.logger })

  if (container === undefined) {
    process.stdout.write(`No devcontainer found for: ${context.workspaceFolder}\n`)
    return
  }

  if (container.state?.toLowerCase() !== 'running') {
    process.stdout.write(`Devcontainer is not running for: ${context.workspaceFolder}\n`)
    return
  }

  const result = await runBuffered('docker', ['stop', container.id], {
    logger: options.logger,
    mirrorStdout: false,
    mirrorStderr: false
  })

  if (result.code !== 0) {
    throw new Error(`Could not stop devcontainer ${container.id}`)
  }

  process.stdout.write(`Stopped devcontainer: ${container.id}\n`)
}

export async function removeWorkspaceContainer (context: WorkspaceContext, options: { logger?: WorkspaceCommandLogger } = {}): Promise<void> {
  const container = await findWorkspaceContainer(context, { logger: options.logger })

  if (container === undefined) {
    process.stdout.write(`No devcontainer found for: ${context.workspaceFolder}\n`)
    return
  }

  await removeContainerById(container.id, { logger: options.logger })
  process.stdout.write(`Removed devcontainer: ${container.id}\n`)
}

export async function removeContainerById (containerId: string, options: { volumes?: boolean, logger?: WorkspaceCommandLogger } = {}): Promise<void> {
  const result = await runBuffered('docker', [
    'rm',
    '-f',
    ...(options.volumes === true ? ['-v'] : []),
    containerId
  ], {
    logger: options.logger,
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

export async function removeDockerImage (imageId: string, options: { logger?: WorkspaceCommandLogger } = {}): Promise<boolean> {
  const result = await runBuffered('docker', ['image', 'rm', '-f', imageId], {
    logger: options.logger,
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
  const hasSshIdentityStep = progress?.hasStep('ssh-identity') === true
  const hasConfigStep = progress?.hasStep('devcontainer-config') === true
  const hasStartStep = progress?.hasStep('devcontainer-start') === true

  if (hasSshIdentityStep) {
    progress?.startStep('ssh-identity')
  } else {
    progress?.item('Preparing SSH identity')
  }

  try {
    await ensureHostSshKey(context, {
      quiet: proxyMode,
      progress
    })
    if (hasSshIdentityStep) {
      progress?.completeStep('ssh-identity')
    }
  } catch (error) {
    if (hasSshIdentityStep) {
      progress?.failStep('ssh-identity')
    }
    throw error
  }

  if (hasConfigStep) {
    progress?.startStep('devcontainer-config')
  } else if (progress !== undefined) {
    progress.item('Writing generated devcontainer config')
    progress.detail(context.generatedConfigPath)
  }
  try {
    writeGeneratedDevcontainerConfig(context)
    if (hasConfigStep) {
      progress?.completeStep('devcontainer-config')
    }
  } catch (error) {
    if (hasConfigStep) {
      progress?.failStep('devcontainer-config')
    }
    throw error
  }

  if (options.reuseRunning === true && options.recreate !== true) {
    const runningContainerId = await findRunningContainerId(context, { logger: options.logger })

    if (runningContainerId !== undefined) {
      if (progress === undefined) {
        log(`Using running devcontainer for: ${context.workspaceFolder}`, proxyMode)
      } else if (hasStartStep) {
        progress.startStep('devcontainer-start')
        progress.completeStep('devcontainer-start')
      } else {
        progress.item('Using running devcontainer')
        progress.detail(runningContainerId)
      }
      await recordContainerImageIfPresent(context, runningContainerId, options.logger)
      return runningContainerId
    }
  }

  const cli = resolveDevcontainerCli(context)
  if (progress === undefined) {
    log(`Starting devcontainer for: ${context.workspaceFolder}`, proxyMode)
  }

  const args = [
    'up',
    ...devcontainerWorkspaceArgs(context)
  ]

  if (options.recreate === true) {
    args.push('--remove-existing-container')
    if (progress === undefined) {
      log('Removing existing dev container so create-time settings apply.', proxyMode)
    } else if (!hasStartStep) {
      progress.item('Removing existing devcontainer before start')
    }
  }

  const result = progress === undefined
    ? await runBuffered(cli.command, [...cli.argsPrefix, ...args], {
        mirrorStdout: proxyMode ? 'stderr' : 'stdout',
        mirrorStderr: 'stderr',
        logger: options.logger
      })
    : await runProgressCommand('devcontainer up', cli.command, [...cli.argsPrefix, ...args], {
        progress,
        spinnerLabel: 'Starting devcontainer',
        stepId: 'devcontainer-start',
        verboseStdout: proxyMode ? 'stderr' : 'stdout',
        verboseStderr: 'stderr',
        logger: options.logger
      })

  if (progress === undefined && result.code !== 0) {
    throw new Error(`devcontainer up failed for ${context.workspaceFolder}`)
  }

  if (progress !== undefined) {
    assertProgressCommandSucceeded('devcontainer up', result, `devcontainer up failed for ${context.workspaceFolder}`)
  }

  const containerId = parseContainerIdFromUpOutput(`${result.stdout}\n${result.stderr}`) ?? await findRunningContainerId(context, { logger: options.logger })

  if (containerId === undefined) {
    if (hasStartStep) {
      progress?.failStep('devcontainer-start')
    }
    throw new Error(`Could not resolve devcontainer ID for ${context.workspaceFolder}`)
  }

  await recordContainerImageIfPresent(context, containerId, options.logger)
  return containerId
}

export async function printPortHint (context: WorkspaceContext, containerId: string, options: { logger?: WorkspaceCommandLogger } = {}): Promise<void> {
  const config = buildGeneratedDevcontainerConfig(context)
  const containerPort = publishContainerPortFromConfig(config)

  if (containerPort === undefined) {
    process.stderr.write('Warning: could not find a runArgs publish port.\n')
    return
  }

  const result = await runBuffered('docker', ['port', containerId, `${containerPort}/tcp`], {
    logger: options.logger,
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

export async function openShell (context: WorkspaceContext, options: { logger?: WorkspaceCommandLogger } = {}): Promise<number> {
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
  ], { logger: options.logger })
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

export async function openCodingAgentCli (context: WorkspaceContext, agent: CodingAgentCli, agentArgs: string[] = [], options: { logger?: WorkspaceCommandLogger } = {}): Promise<number> {
  const cli = resolveDevcontainerCli(context)
  process.stdout.write(`Dropping into ${codingAgentBinary(agent)} inside the devcontainer...\n`)

  return runInteractive(cli.command, [
    ...cli.argsPrefix,
    ...codingAgentDevcontainerExecArgs(context, agent, agentArgs)
  ], { logger: options.logger })
}

export async function ensureContainerSshRuntime (context: WorkspaceContext, options: ContainerCommandOptions = {}): Promise<void> {
  const cli = resolveDevcontainerCli(context)
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
        mirrorStderr: 'stderr',
        logger: options.logger
      })
    : await runProgressCommand('prepare SSH runtime', cli.command, args, {
        progress: options.progress,
        spinnerLabel: 'Preparing container SSH runtime',
        stepId: 'ssh-runtime',
        verboseStdout: 'stderr',
        verboseStderr: 'stderr',
        logger: options.logger
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
  const spinnerLabel = agents.length === 0
    ? 'Refreshing default coding-agent CLIs'
    : `Refreshing coding-agent CLIs: ${agents.map(codingAgentBinary).join(', ')}`
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
        mirrorStderr: 'stderr',
        logger: options.logger
      })
    : await runProgressCommand('refresh coding-agent CLIs', cli.command, args, {
        progress: options.progress,
        spinnerLabel,
        stepId: 'coding-agent-refresh',
        verboseStdout: proxyMode ? 'stderr' : 'stdout',
        verboseStderr: 'stderr',
        logger: options.logger
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
  const spinnerLabel = `Preparing ${codingAgentBinary(agent)} inside the devcontainer`
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
        mirrorStderr: 'stderr',
        logger: options.logger
      })
    : await runProgressCommand(`prepare ${codingAgentBinary(agent)}`, cli.command, args, {
        progress: options.progress,
        spinnerLabel,
        stepId: 'agent-cli',
        verboseStdout: 'stdout',
        verboseStderr: 'stderr',
        logger: options.logger
      })

  if (options.progress === undefined && result.code !== 0) {
    throw new Error(`Could not install or refresh ${codingAgentBinary(agent)} inside the devcontainer`)
  }

  if (options.progress !== undefined) {
    assertProgressCommandSucceeded(`prepare ${codingAgentBinary(agent)}`, result, `Could not install or refresh ${codingAgentBinary(agent)} inside the devcontainer`)
  }
}

export async function runSshdProxy (containerId: string, options: { logger?: WorkspaceCommandLogger } = {}): Promise<number> {
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
  ], { logger: options.logger })
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

export async function openSshTunnel (alias: string, ports: TunnelPortForward[], options: SshTunnelOptions & { logger?: WorkspaceCommandLogger } = {}): Promise<number> {
  const { logger, ...tunnelOptions } = options
  return runInteractive('ssh', sshTunnelArgs(alias, ports, tunnelOptions), { logger })
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
  const hasConfigStep = progress?.hasStep('gh-auth-config') === true
  const hasTokenStep = progress?.hasStep('gh-token-read') === true
  const hasGitAuthStep = progress?.hasStep('gh-git-auth') === true

  if (hasConfigStep) {
    progress?.startStep('gh-auth-config')
  } else {
    progress?.item('Preparing generated config for GitHub auth refresh')
  }

  try {
    await ensureHostSshKey(context, {
      quiet: true,
      progress
    })
    writeGeneratedDevcontainerConfig(context)
    if (hasConfigStep) {
      progress?.completeStep('gh-auth-config')
    }
  } catch (error) {
    if (hasConfigStep) {
      progress?.failStep('gh-auth-config')
    }
    throw error
  }

  if (hasTokenStep) {
    progress?.startStep('gh-token-read')
  } else {
    progress?.item('Reading host GitHub CLI token')
  }

  let token: string
  try {
    token = await hostGhTokenOrEmpty()
    if (hasTokenStep) {
      progress?.completeStep('gh-token-read')
    }
  } catch (error) {
    if (hasTokenStep) {
      progress?.failStep('gh-token-read')
    }
    throw error
  }

  if (token.length === 0) {
    progress?.skipStep('gh-auth-refresh')
    progress?.skipStep('gh-git-auth')
    progress?.skipStep('gh-auth-verify')
    if (progress === undefined) {
      process.stderr.write('Warning: Host GitHub CLI token unavailable; skipping container auth refresh.\n')
    } else {
      progress.warn('Host GitHub CLI token unavailable; skipping container auth refresh.')
    }
    return
  }

  options.logger?.addRedaction(token)

  const cli = resolveDevcontainerCli(context)
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
        logger: options.logger,
        mirrorStdout: false,
        mirrorStderr: false
      })
    : await runProgressCommand('refresh GitHub CLI auth', cli.command, loginArgs, {
        input: `${token}\n`,
        progress,
        logger: options.logger,
        spinnerLabel: 'Refreshing GitHub CLI auth inside the devcontainer',
        stepId: 'gh-auth-refresh',
        verboseStdout: false,
        verboseStderr: false
      })

  if (login.code !== 0) {
    progress?.skipStep('gh-git-auth')
    progress?.skipStep('gh-auth-verify')
    if (progress === undefined) {
      process.stderr.write('Warning: could not refresh GitHub CLI auth inside the devcontainer.\n')
    } else {
      progress.warn('Could not refresh GitHub CLI auth inside the devcontainer.')
    }
    return
  }

  if (hasGitAuthStep) {
    progress?.startStep('gh-git-auth')
  } else {
    progress?.item('Configuring workspace GitHub Git auth')
  }

  let gitAuthConfigured: boolean
  try {
    gitAuthConfigured = await configureWorkspaceGithubGitAuth(context.workspaceFolder)
    if (hasGitAuthStep) {
      if (gitAuthConfigured) {
        progress?.completeStep('gh-git-auth')
      } else {
        progress?.failStep('gh-git-auth')
      }
    }
  } catch (error) {
    if (hasGitAuthStep) {
      progress?.failStep('gh-git-auth')
    }
    throw error
  }

  if (!gitAuthConfigured) {
    if (progress === undefined) {
      process.stderr.write('Warning: GitHub CLI auth refreshed, but GitHub Git auth was not configured for this workspace.\n')
    } else {
      progress.warn('GitHub CLI auth refreshed, but GitHub Git auth was not configured for this workspace.')
    }
  }

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
        mirrorStderr: false,
        logger: options.logger
      })
    : await runProgressCommand('verify GitHub CLI auth', cli.command, verifyArgs, {
        progress,
        logger: options.logger,
        spinnerLabel: 'Verifying GitHub CLI auth inside the devcontainer',
        stepId: 'gh-auth-verify',
        verboseStdout: false,
        verboseStderr: false
      })

  if (verify.code === 0) {
    if (progress === undefined) {
      process.stdout.write('GitHub CLI auth refreshed inside the devcontainer.\n')
    } else if (!progress.hasStep('gh-auth-verify')) {
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
