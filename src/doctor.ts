import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { resolveDevcontainerCli } from './devcontainer-cli.ts'
import type { WorkspaceContext } from './paths.ts'
import { runBuffered } from './process.ts'

export type DoctorLevel = 'ok' | 'fail' | 'warn'

export interface DoctorCheck {
  name: string
  level: DoctorLevel
  message: string
}

export interface DoctorCommandResult {
  code: number
  stdout: string
  stderr: string
}

export type DoctorCommandRunner = (command: string, args: string[]) => Promise<DoctorCommandResult>

export interface RunDoctorChecksOptions {
  includeOptional?: boolean
  includeDockerMountProbe?: boolean
  runCommand?: DoctorCommandRunner
}

function nodeVersionPasses (version: string): boolean {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isInteger(major) && major >= 24
}

function check (name: string, pass: boolean, okMessage: string, failMessage: string): DoctorCheck {
  return {
    name,
    level: pass ? 'ok' : 'fail',
    message: pass ? okMessage : failMessage
  }
}

async function runDoctorCommand (command: string, args: string[]): Promise<DoctorCommandResult> {
  return runBuffered(command, args, {
    mirrorStdout: false,
    mirrorStderr: false
  })
}

async function commandWorks (runCommand: DoctorCommandRunner, command: string, args: string[]): Promise<boolean> {
  const result = await runCommand(command, args)
  return result.code === 0
}

async function commandExists (runCommand: DoctorCommandRunner, command: string, args: string[]): Promise<boolean> {
  const result = await runCommand(command, args)
  return result.code !== 127
}

export async function runDoctorChecks (context: WorkspaceContext, options: RunDoctorChecksOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const runCommand = options.runCommand ?? runDoctorCommand
  const nodeVersion = process.versions.node

  checks.push(check(
    'node',
    nodeVersionPasses(nodeVersion),
    `Node ${nodeVersion}`,
    `Node ${nodeVersion}; expected >=24.0.0`
  ))

  const sshAgent = await runCommand('ssh-add', ['-L'])
  const identities = sshAgent.code === 0
    ? sshAgent.stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('ssh-')).length
    : 0
  checks.push({
    name: 'git-signing-agent',
    level: sshAgent.code === 0 && identities === 1 ? 'ok' : 'warn',
    message: sshAgent.code !== 0
      ? 'SSH agent is unavailable; Boxdown commits will remain unsigned'
      : identities === 0
        ? 'SSH agent has no identities; Boxdown commits will remain unsigned'
        : identities > 1
          ? 'SSH agent has multiple identities; Boxdown will not guess a signing key and commits will remain unsigned'
          : 'One SSH agent identity is available for Boxdown commit signing'
  })

  checks.push(check(
    'devcontainers-cli',
    await packagedDevcontainerCliWorks(context, runCommand),
    'Packaged @devcontainers/cli is available',
    'Packaged @devcontainers/cli is required but was not available'
  ))

  const dockerCliWorks = await commandWorks(runCommand, 'docker', ['--version'])
  checks.push(check(
    'docker-cli',
    dockerCliWorks,
    'Docker CLI is available',
    'Docker CLI is required but was not available'
  ))

  const dockerDaemonWorks = await commandWorks(runCommand, 'docker', ['info'])
  checks.push(check(
    'docker-daemon',
    dockerDaemonWorks,
    'Docker daemon is reachable',
    'Docker daemon is required but was not reachable'
  ))

  checks.push(check(
    'ssh',
    await commandExists(runCommand, 'ssh', ['-V']),
    'ssh is available',
    'ssh is required but was not available'
  ))

  if (options.includeDockerMountProbe ?? true) {
    checks.push(await checkDockerBindMounts(context, runCommand, dockerCliWorks && dockerDaemonWorks))
  }

  checks.push(check(
    'ssh-keygen',
    await commandExists(runCommand, 'ssh-keygen', ['-?']),
    'ssh-keygen is available',
    'ssh-keygen is required but was not available'
  ))

  checks.push(check(
    'assets',
    existsSync(context.assetsDevcontainerDir),
    `Devcontainer assets found at ${context.assetsDevcontainerDir}`,
    `Missing Boxdown devcontainer assets: ${context.assetsDevcontainerDir}`
  ))

  if (options.includeOptional ?? true) {
    if (await commandWorks(runCommand, 'gh', ['--version'])) {
      const ghAuth = await commandWorks(runCommand, 'gh', ['auth', 'status', '--hostname', 'github.com'])
      checks.push({
        name: 'gh-auth',
        level: ghAuth ? 'ok' : 'warn',
        message: ghAuth ? 'GitHub CLI auth is available' : 'GitHub CLI is available but not authenticated'
      })
      if (ghAuth && identities === 1) {
        const user = await runCommand('gh', ['api', 'user', '--jq', '.login'])
        const signing = user.code === 0 && user.stdout.trim().length > 0
          ? await runCommand('gh', ['api', `users/${user.stdout.trim()}/ssh_signing_keys`, '--paginate', '--jq', '.[].key'])
          : { code: 1, stdout: '', stderr: '' }
        const identity = sshAgent.stdout.split(/\r?\n/).find((line) => line.trim().startsWith('ssh-'))?.trim()
        checks.push({
          name: 'git-signing-github',
          level: signing.code === 0 && identity !== undefined && signing.stdout.includes(identity.split(/\s+/, 3).slice(0, 2).join(' ')) ? 'ok' : 'warn',
          message: signing.code !== 0
            ? 'GitHub SSH signing-key registration could not be checked'
            : signing.stdout.includes(identity?.split(/\s+/, 3).slice(0, 2).join(' ') ?? '')
              ? 'Selected SSH key is registered with GitHub for commit signing'
              : 'Register the selected public key with GitHub as a signing key to receive Verified badges'
        })
      }
    } else {
      checks.push({
        name: 'gh',
        level: 'warn',
        message: 'GitHub CLI is optional and was not available'
      })
    }
  }

  return checks
}

function dockerProbeImage (output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((image) => image.length > 0 && image !== '<none>:<none>')
}

function dockerMountError (output: string): boolean {
  return /invalid mount config|bind source path does not exist|mount denied|file sharing|mounts denied|permission denied|operation not permitted/i.test(output)
}

function compactOutput (output: string): string {
  return output.trim().replace(/\s+/g, ' ').slice(0, 300)
}

interface DockerMountSource {
  label: string
  path: string
}

async function checkDockerBindMounts (
  context: WorkspaceContext,
  runCommand: DoctorCommandRunner,
  dockerReady: boolean
): Promise<DoctorCheck> {
  if (!dockerReady) {
    return {
      name: 'docker-bind-mounts',
      level: 'warn',
      message: 'Docker bind-mount readiness was not checked because Docker is unavailable'
    }
  }

  const imageResult = await runCommand('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])
  const image = imageResult.code === 0 ? dockerProbeImage(imageResult.stdout) : undefined

  if (image === undefined) {
    return {
      name: 'docker-bind-mounts',
      level: 'warn',
      message: 'Docker bind-mount readiness was not checked because no local Docker image is available'
    }
  }

  mkdirSync(context.workspaceDataDir, { recursive: true })
  const runtimeProbeDir = mkdtempSync(join(context.workspaceDataDir, 'doctor-mount-probe-'))
  const sources: DockerMountSource[] = [
    { label: 'workspace', path: context.workspaceFolder },
    { label: 'Boxdown devcontainer assets', path: context.assetsDevcontainerDir },
    { label: 'Boxdown runtime state', path: runtimeProbeDir }
  ]

  try {
    for (const source of sources) {
      const createResult = await runCommand('docker', [
        'create',
        '--pull=never',
        '--entrypoint',
        '/bin/true',
        '--mount',
        `type=bind,source=${source.path},target=/boxdown-preflight,readonly`,
        image
      ])
      const output = `${createResult.stderr}\n${createResult.stdout}`

      if (createResult.code !== 0) {
        if (dockerMountError(output)) {
          return {
            name: 'docker-bind-mounts',
            level: 'fail',
            message: `Docker cannot bind-mount the ${source.label} path (${source.path}). Check Docker Desktop file sharing and host-folder permissions.`
          }
        }

        return {
          name: 'docker-bind-mounts',
          level: 'warn',
          message: `Docker bind-mount readiness could not be checked for ${source.label}: ${compactOutput(output) || 'Docker create failed'}`
        }
      }

      const containerId = createResult.stdout.trim().split(/\r?\n/)[0]
      if (containerId === undefined || containerId.length === 0) {
        return {
          name: 'docker-bind-mounts',
          level: 'warn',
          message: `Docker bind-mount readiness could not be checked for ${source.label}: Docker did not return a container ID`
        }
      }

      const removeResult = await runCommand('docker', ['rm', '-f', containerId])
      if (removeResult.code !== 0) {
        return {
          name: 'docker-bind-mounts',
          level: 'warn',
          message: `Docker bind-mount readiness was checked, but the disposable probe container could not be removed: ${compactOutput(removeResult.stderr) || 'docker rm failed'}`
        }
      }
    }
  } finally {
    rmSync(runtimeProbeDir, { recursive: true, force: true })
  }

  return {
    name: 'docker-bind-mounts',
    level: 'ok',
    message: 'Docker can bind-mount Boxdown workspace, assets, and runtime-state paths'
  }
}

async function packagedDevcontainerCliWorks (context: WorkspaceContext, runCommand: DoctorCommandRunner): Promise<boolean> {
  try {
    const cli = resolveDevcontainerCli(context)
    return await commandWorks(runCommand, cli.command, [...cli.argsPrefix, '--version'])
  } catch {
    return false
  }
}

export function doctorHasFailures (checks: DoctorCheck[]): boolean {
  return checks.some((item) => item.level === 'fail')
}

export function formatDoctorText (checks: DoctorCheck[]): string {
  const lines = ['Boxdown doctor', '']

  for (const item of checks) {
    lines.push(`[${item.level}] ${item.name}: ${item.message}`)
  }

  lines.push('', doctorHasFailures(checks) ? 'Result: failed' : 'Result: ok')
  return `${lines.join('\n')}\n`
}
