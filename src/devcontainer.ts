import {
  BOXDOWN_CONTAINER_DEVCONTAINER_DIR
} from './constants.ts'
import { buildGeneratedDevcontainerConfig, publishContainerPortFromConfig, writeGeneratedDevcontainerConfig } from './config.ts'
import { resolveDevcontainerCli } from './devcontainer-cli.ts'
import type { WorkspaceContext } from './paths.ts'
import { runBuffered, runInteractive } from './process.ts'
import { interactiveShellEnvArgs, interactiveShellScript } from './shell.ts'
import { ensureHostSshKey } from './ssh-key.ts'
import { type ContainerSummary, parseDockerPsJsonLines } from './status.ts'

export interface StartOptions {
  recreate?: boolean
  proxyMode?: boolean
  reuseRunning?: boolean
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

  const result = await runBuffered('docker', ['rm', '-f', container.id], {
    mirrorStdout: false,
    mirrorStderr: false
  })

  if (result.code !== 0) {
    throw new Error(`Could not remove devcontainer ${container.id}`)
  }

  process.stdout.write(`Removed devcontainer: ${container.id}\n`)
}

export async function startDevcontainer (context: WorkspaceContext, options: StartOptions = {}): Promise<string> {
  await ensureHostSshKey(context, options.proxyMode ?? false)
  writeGeneratedDevcontainerConfig(context)

  if (options.reuseRunning === true && options.recreate !== true) {
    const runningContainerId = await findRunningContainerId(context)

    if (runningContainerId !== undefined) {
      log(`Using running devcontainer for: ${context.workspaceFolder}`, options.proxyMode)
      return runningContainerId
    }
  }

  const cli = resolveDevcontainerCli(context)
  log(`Starting devcontainer for: ${context.workspaceFolder}`, options.proxyMode)

  const args = [
    'up',
    ...devcontainerWorkspaceArgs(context)
  ]

  if (options.recreate === true) {
    args.push('--remove-existing-container')
    log('Removing existing dev container so create-time settings apply.', options.proxyMode)
  }

  const result = await runBuffered(cli.command, [...cli.argsPrefix, ...args], {
    mirrorStdout: options.proxyMode === true ? 'stderr' : 'stdout',
    mirrorStderr: 'stderr'
  })

  if (result.code !== 0) {
    throw new Error(`devcontainer up failed for ${context.workspaceFolder}`)
  }

  const containerId = parseContainerIdFromUpOutput(`${result.stdout}\n${result.stderr}`) ?? await findRunningContainerId(context)

  if (containerId === undefined) {
    throw new Error(`Could not resolve devcontainer ID for ${context.workspaceFolder}`)
  }

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

export async function ensureContainerSshRuntime (context: WorkspaceContext): Promise<void> {
  const cli = resolveDevcontainerCli(context)
  const result = await runBuffered(cli.command, [
    ...cli.argsPrefix,
    'exec',
    ...devcontainerWorkspaceArgs(context),
    '--',
    'bash',
    `${BOXDOWN_CONTAINER_DEVCONTAINER_DIR}/utils/ssh-bootstrap.sh`,
    'runtime'
  ], {
    mirrorStdout: 'stderr',
    mirrorStderr: 'stderr'
  })

  if (result.code !== 0) {
    throw new Error('Failed to prepare devcontainer SSH runtime')
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

export async function refreshContainerGhAuth (context: WorkspaceContext): Promise<void> {
  await ensureHostSshKey(context, true)
  writeGeneratedDevcontainerConfig(context)

  const token = await hostGhTokenOrEmpty()

  if (token.length === 0) {
    return
  }

  const cli = resolveDevcontainerCli(context)
  const login = await runBuffered(cli.command, [
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
  ], {
    input: `${token}\n`,
    mirrorStdout: false,
    mirrorStderr: false
  })

  if (login.code !== 0) {
    process.stderr.write('Warning: could not refresh GitHub CLI auth inside the devcontainer.\n')
    return
  }

  await runBuffered(cli.command, [
    ...cli.argsPrefix,
    'exec',
    ...devcontainerWorkspaceArgs(context),
    '--',
    'bash',
    '-lc',
    'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git config --local credential.https://github.com.helper "!gh auth git-credential"; fi'
  ], {
    mirrorStdout: false,
    mirrorStderr: false
  })

  const verify = await runBuffered(cli.command, [
    ...cli.argsPrefix,
    'exec',
    ...devcontainerWorkspaceArgs(context),
    '--',
    'gh',
    'auth',
    'status',
    '--hostname',
    'github.com'
  ], {
    mirrorStdout: false,
    mirrorStderr: false
  })

  if (verify.code === 0) {
    process.stdout.write('GitHub CLI auth refreshed inside the devcontainer.\n')
  } else {
    process.stderr.write('Warning: GitHub CLI auth refresh completed, but verification failed.\n')
  }
}
