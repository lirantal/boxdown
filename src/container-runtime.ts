import { performance } from 'node:perf_hooks'

import { runBuffered, type CommandResult } from './process.ts'

export type ContainerRuntimeReason =
  | 'docker-cli-unavailable'
  | 'docker-daemon-unavailable'
  | 'buildx-builder-unavailable'

export type ContainerRuntimeMode = 'buildx' | 'fallback'
export type ContainerRuntimeCommandResult = CommandResult
export type ContainerRuntimeCommandRunner = (
  command: string,
  args: string[],
  timeoutMs?: number
) => Promise<ContainerRuntimeCommandResult>

export interface ContainerRuntimeFailure {
  reason: ContainerRuntimeReason
  command: string[]
  detail: string
  timedOut?: true
}

export type ContainerRuntimeProbe =
  | { state: 'ready', mode: ContainerRuntimeMode, warnings: string[] }
  | { state: 'waiting', failure: ContainerRuntimeFailure }
  | { state: 'failed', failure: ContainerRuntimeFailure }

const BUILDX_FALLBACK_WARNING = 'Docker Buildx is unavailable; the Dev Containers CLI will use its classic-build fallback.'

async function runContainerRuntimeCommand (
  command: string,
  args: string[],
  timeoutMs?: number
): Promise<ContainerRuntimeCommandResult> {
  return runBuffered(command, args, {
    mirrorStdout: false,
    mirrorStderr: false,
    timeoutMs
  })
}

function compactCommandOutput (result: ContainerRuntimeCommandResult): string {
  const output = result.stderr.trim().length > 0 ? result.stderr : result.stdout
  const compact = output.trim().replace(/\s+/gu, ' ').slice(0, 500)
  return compact.length > 0 ? compact : `Command exited with code ${result.code}`
}

function failure (
  reason: ContainerRuntimeReason,
  command: string[],
  result: ContainerRuntimeCommandResult
): ContainerRuntimeFailure {
  return {
    reason,
    command,
    detail: compactCommandOutput(result),
    ...(result.timedOut === true ? { timedOut: true as const } : {})
  }
}

export async function probeContainerRuntime (
  runCommand: ContainerRuntimeCommandRunner = runContainerRuntimeCommand
): Promise<ContainerRuntimeProbe> {
  const dockerVersionCommand = ['docker', '--version']
  const dockerVersion = await runCommand(dockerVersionCommand[0] as string, dockerVersionCommand.slice(1))
  if (dockerVersion.code !== 0) {
    return {
      state: 'failed',
      failure: failure('docker-cli-unavailable', dockerVersionCommand, dockerVersion)
    }
  }

  const dockerInfoCommand = ['docker', 'info']
  const dockerInfo = await runCommand(dockerInfoCommand[0] as string, dockerInfoCommand.slice(1))
  if (dockerInfo.code !== 0) {
    return {
      state: 'waiting',
      failure: failure('docker-daemon-unavailable', dockerInfoCommand, dockerInfo)
    }
  }

  const buildxVersionCommand = ['docker', 'buildx', 'version']
  const buildxVersion = await runCommand(buildxVersionCommand[0] as string, buildxVersionCommand.slice(1))
  if (buildxVersion.timedOut === true) {
    return {
      state: 'waiting',
      failure: failure('buildx-builder-unavailable', buildxVersionCommand, buildxVersion)
    }
  }
  if (buildxVersion.code !== 0) {
    return {
      state: 'ready',
      mode: 'fallback',
      warnings: [BUILDX_FALLBACK_WARNING]
    }
  }

  const buildxInspectCommand = ['docker', 'buildx', 'inspect', '--bootstrap']
  const buildxInspect = await runCommand(buildxInspectCommand[0] as string, buildxInspectCommand.slice(1))
  if (buildxInspect.code !== 0) {
    return {
      state: 'waiting',
      failure: failure('buildx-builder-unavailable', buildxInspectCommand, buildxInspect)
    }
  }

  return { state: 'ready', mode: 'buildx', warnings: [] }
}

export type ContainerRuntimeWaitResult =
  | { state: 'ready', mode: ContainerRuntimeMode, warnings: string[] }
  | {
      state: 'failed'
      failure: ContainerRuntimeFailure
      timedOut: boolean
      timeoutMs: number
    }

export interface WaitForContainerRuntimeOptions {
  runCommand?: ContainerRuntimeCommandRunner
  onTransition?: (probe: ContainerRuntimeProbe) => void
}

/** @internal */
export interface InternalContainerRuntimeWaitOptions extends WaitForContainerRuntimeOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

function defaultSleep (milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function transitionKey (probe: ContainerRuntimeProbe): string {
  return probe.state === 'ready' ? 'ready' : `${probe.state}:${probe.failure.reason}`
}

class ContainerRuntimeDeadlineError extends Error {
  readonly command: string[]

  constructor (command: string[]) {
    super(`Container runtime deadline expired before ${command.join(' ')}`)
    this.command = command
  }
}

function deadlineFailure (command: string[]): ContainerRuntimeFailure {
  const reason: ContainerRuntimeReason = command[1] === 'info'
    ? 'docker-daemon-unavailable'
    : command[1] === 'buildx'
      ? 'buildx-builder-unavailable'
      : 'docker-cli-unavailable'

  return {
    reason,
    command,
    detail: `Readiness deadline expired before ${command.join(' ')} could start.`,
    timedOut: true
  }
}

/** @internal */
export async function waitForContainerRuntimeInternal (
  options: InternalContainerRuntimeWaitOptions = {}
): Promise<ContainerRuntimeWaitResult> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    throw new Error('timeoutMs must be a finite number between 0 and 60000 milliseconds')
  }
  if (pollIntervalMs !== 1_000) {
    throw new Error('pollIntervalMs must be exactly 1000 milliseconds')
  }
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const deadline = now() + timeoutMs
  let lastTransition: string | undefined
  let lastWaitingFailure: ContainerRuntimeFailure | undefined

  while (true) {
    if (lastWaitingFailure !== undefined && deadline - now() <= 0) {
      return { state: 'failed', failure: lastWaitingFailure, timedOut: true, timeoutMs }
    }

    const runCommand = options.runCommand ?? runContainerRuntimeCommand
    let lastStartedCommand: string[] | undefined
    let probe: ContainerRuntimeProbe
    try {
      probe = await probeContainerRuntime(async (command, args) => {
        const commandArgs = [command, ...args]
        const remainingMs = Math.floor(deadline - now())
        if (remainingMs <= 0) throw new ContainerRuntimeDeadlineError(commandArgs)
        lastStartedCommand = commandArgs
        return runCommand(command, args, remainingMs)
      })
    } catch (error) {
      if (!(error instanceof ContainerRuntimeDeadlineError)) throw error
      return {
        state: 'failed',
        failure: lastWaitingFailure ?? deadlineFailure(error.command),
        timedOut: true,
        timeoutMs
      }
    }

    if (deadline - now() <= 0) {
      const currentFailure = probe.state === 'ready'
        ? deadlineFailure(lastStartedCommand ?? ['docker', '--version'])
        : probe.failure
      return {
        state: 'failed',
        failure: lastWaitingFailure ?? currentFailure,
        timedOut: true,
        timeoutMs
      }
    }

    if (probe.state === 'ready') return probe

    const currentTransition = transitionKey(probe)
    if (currentTransition !== lastTransition) {
      options.onTransition?.(probe)
      lastTransition = currentTransition
    }

    if (probe.state === 'failed') {
      return {
        state: 'failed',
        failure: probe.failure,
        timedOut: probe.failure.timedOut === true,
        timeoutMs
      }
    }

    lastWaitingFailure = probe.failure

    const remainingMs = deadline - now()
    if (remainingMs <= 0) {
      return { state: 'failed', failure: probe.failure, timedOut: true, timeoutMs }
    }

    await sleep(Math.min(pollIntervalMs, remainingMs))
  }
}

export async function waitForContainerRuntime (
  options: WaitForContainerRuntimeOptions = {}
): Promise<ContainerRuntimeWaitResult> {
  return waitForContainerRuntimeInternal({
    runCommand: options.runCommand,
    onTransition: options.onTransition,
    timeoutMs: 60_000,
    pollIntervalMs: 1_000,
    now: () => performance.now(),
    sleep: defaultSleep
  })
}

function commandText (command: readonly string[]): string {
  return command.join(' ')
}

export function formatContainerRuntimeFailure (
  result: Extract<ContainerRuntimeWaitResult, { state: 'failed' }>,
  options: { logPath?: string } = {}
): string {
  const seconds = result.timeoutMs / 1_000
  const descriptions: Record<ContainerRuntimeReason, string> = {
    'docker-cli-unavailable': 'Docker CLI is required but was not available.',
    'docker-daemon-unavailable': result.timedOut
      ? `Docker daemon did not become ready within ${seconds} seconds.`
      : 'Docker daemon is required but was not reachable.',
    'buildx-builder-unavailable': result.timedOut
      ? `Docker Buildx builder did not become ready within ${seconds} seconds.`
      : 'Docker Buildx builder was not operational.'
  }
  const manualCheck = result.failure.reason === 'buildx-builder-unavailable'
    ? 'docker buildx inspect'
    : result.failure.reason === 'docker-daemon-unavailable'
      ? 'docker info'
      : 'docker --version'
  const lines = [
    descriptions[result.failure.reason],
    `Last check: ${commandText(result.failure.command)}`,
    `Detail: ${result.failure.detail}`,
    `Check ${result.failure.reason === 'buildx-builder-unavailable' ? 'Buildx' : 'Docker'} with: ${manualCheck}`
  ]

  if (options.logPath !== undefined) lines.push(`Command log: ${options.logPath}`)
  return lines.join('\n')
}
