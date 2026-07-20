import { runBuffered, type CommandResult } from './process.ts'

export type ContainerRuntimeReason =
  | 'docker-cli-unavailable'
  | 'docker-daemon-unavailable'
  | 'buildx-builder-unavailable'

export type ContainerRuntimeMode = 'buildx' | 'fallback'
export type ContainerRuntimeCommandResult = CommandResult
export type ContainerRuntimeCommandRunner = (
  command: string,
  args: string[]
) => Promise<ContainerRuntimeCommandResult>

export interface ContainerRuntimeFailure {
  reason: ContainerRuntimeReason
  command: string[]
  detail: string
}

export type ContainerRuntimeProbe =
  | { state: 'ready', mode: ContainerRuntimeMode, warnings: string[] }
  | { state: 'waiting', failure: ContainerRuntimeFailure }
  | { state: 'failed', failure: ContainerRuntimeFailure }

const BUILDX_FALLBACK_WARNING = 'Docker Buildx is unavailable; the Dev Containers CLI will use its classic-build fallback.'

async function runContainerRuntimeCommand (
  command: string,
  args: string[]
): Promise<ContainerRuntimeCommandResult> {
  return runBuffered(command, args, {
    mirrorStdout: false,
    mirrorStderr: false
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
    detail: compactCommandOutput(result)
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
