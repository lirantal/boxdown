import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveDevcontainerCli } from './devcontainer-cli.ts'
import { buildGeneratedDevcontainerConfig, type DevcontainerConfig } from './config.ts'
import { BOXDOWN_SECRET_ENV_NAMES } from './constants.ts'
import { resolveConfiguredSshSigningKey, selectGitSigningKey, type GitSigningReason } from './git-signing.ts'
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

function secretEnvironmentConfigCheck (context: WorkspaceContext): DoctorCheck {
  let config: DevcontainerConfig

  try {
    config = existsSync(context.generatedConfigPath)
      ? JSON.parse(readFileSync(context.generatedConfigPath, 'utf8')) as DevcontainerConfig
      : buildGeneratedDevcontainerConfig(context)
  } catch {
    return {
      name: 'secret-environment-config',
      level: 'warn',
      message: 'Generated config could not be checked for secret-safe environment handling'
    }
  }

  const runArgs = Array.isArray(config.runArgs) ? config.runArgs : []
  const containerEnv = config.containerEnv ?? {}
  const unsafe = runArgs.includes('--env-file') ||
    runArgs.some((arg) => arg.includes('.env.development')) ||
    BOXDOWN_SECRET_ENV_NAMES.some((name) => Object.hasOwn(containerEnv, name))

  return {
    name: 'secret-environment-config',
    level: unsafe ? 'warn' : 'ok',
    message: unsafe
      ? 'Generated config still exposes Boxdown secrets through Docker environment settings; recreate after upgrading Boxdown'
      : 'Generated config uses runtime-mounted secrets without Docker environment values'
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
  const identityLines = sshAgent.code === 0
    ? sshAgent.stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('ssh-'))
    : []
  const identities = identityLines.length
  let configuredKey: string | undefined
  let configuredFailure: { reason: GitSigningReason, detail?: string } | undefined
  const format = await runCommand('git', ['config', '--global', '--get', 'gpg.format'])
  if (format.code === 0 && format.stdout.trim() === 'ssh') {
    const signingKey = await runCommand('git', ['config', '--global', '--get', 'user.signingkey'])
    if (signingKey.code === 0 && signingKey.stdout.trim().length > 0) {
      const resolved = resolveConfiguredSshSigningKey(signingKey.stdout.trim(), {
        homeDir: dirname(context.hostGitconfigPath),
        workspaceFolder: context.workspaceFolder
      })
      if (resolved.key === undefined) {
        configuredFailure = {
          reason: resolved.reason ?? 'configured-key-invalid',
          detail: resolved.detail
        }
      } else {
        configuredKey = resolved.key
      }
    }
  }

  const includeOptional = options.includeOptional ?? true
  let ghAvailable = false
  let ghAuth = false
  let githubLogin: string | undefined
  let githubAuthKeys: string[] | undefined
  if (includeOptional) {
    ghAvailable = await commandWorks(runCommand, 'gh', ['--version'])
    if (ghAvailable) {
      ghAuth = await commandWorks(runCommand, 'gh', ['auth', 'status', '--hostname', 'github.com'])
      if (ghAuth && configuredKey === undefined && configuredFailure === undefined && identities > 1) {
        const user = await runCommand('gh', ['api', 'user', '--jq', '.login'])
        githubLogin = user.code === 0 && user.stdout.trim().length > 0 ? user.stdout.trim() : undefined
        if (githubLogin !== undefined) {
          const authentication = await runCommand('gh', ['api', `users/${githubLogin}/keys`, '--paginate', '--jq', '.[].key'])
          if (authentication.code === 0) githubAuthKeys = authentication.stdout.split(/\r?\n/)
        }
      }
    }
  }

  const selected: { key?: string, reason?: GitSigningReason } = configuredFailure ?? selectGitSigningKey(identityLines, configuredKey, githubAuthKeys)
  const selectedByConfiguration = selected.key !== undefined && configuredKey !== undefined
  const selectedByGithub = selected.key !== undefined && configuredKey === undefined && identities > 1
  const signingMessages: Record<GitSigningReason, string> = {
    'agent-unavailable': 'SSH agent is unavailable; Boxdown commits will remain unsigned',
    'no-identities': 'SSH agent has no identities; Boxdown commits will remain unsigned',
    'ambiguous-identities': 'SSH agent has multiple identities; Boxdown will not guess a signing key and commits will remain unsigned',
    'configured-key-unreadable': 'Configured SSH signing-key file could not be read; Boxdown commits will remain unsigned',
    'configured-key-invalid': 'Configured SSH signing key is not a valid public key; Boxdown commits will remain unsigned',
    'configured-key-not-loaded': 'Configured SSH signing key is not loaded in the agent; Boxdown commits will remain unsigned',
    'agent-socket-unavailable': 'Host SSH-agent socket is unavailable; Boxdown commits will remain unsigned',
    'docker-probe-image-unavailable': 'No local Docker image is available to probe commit-signing agent forwarding',
    'agent-mount-unavailable': 'Docker could not mount the host SSH-agent socket; Boxdown commits will remain unsigned'
  }
  checks.push({
    name: 'git-signing-agent',
    level: sshAgent.code === 0 && selected.key !== undefined ? 'ok' : 'warn',
    message: sshAgent.code !== 0
      ? signingMessages['agent-unavailable']
      : selected.key === undefined
        ? signingMessages[selected.reason ?? 'ambiguous-identities']
        : selectedByConfiguration
          ? 'Configured SSH signing key is loaded in the agent'
          : selectedByGithub
            ? 'GitHub authentication keys identify one SSH agent identity for Boxdown commit signing'
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

  checks.push(secretEnvironmentConfigCheck(context))

  if (includeOptional) {
    if (ghAvailable) {
      checks.push({
        name: 'gh-auth',
        level: ghAuth ? 'ok' : 'warn',
        message: ghAuth ? 'GitHub CLI auth is available' : 'GitHub CLI is available but not authenticated'
      })
      if (ghAuth && selected.key !== undefined) {
        if (githubLogin === undefined) {
          const user = await runCommand('gh', ['api', 'user', '--jq', '.login'])
          githubLogin = user.code === 0 && user.stdout.trim().length > 0 ? user.stdout.trim() : undefined
        }
        const signing = githubLogin !== undefined
          ? await runCommand('gh', ['api', `users/${githubLogin}/ssh_signing_keys`, '--paginate', '--jq', '.[].key'])
          : { code: 1, stdout: '', stderr: '' }
        checks.push({
          name: 'git-signing-github',
          level: signing.code === 0 && signing.stdout.includes(selected.key) ? 'ok' : 'warn',
          message: signing.code !== 0
            ? 'GitHub SSH signing-key registration could not be checked'
            : signing.stdout.includes(selected.key)
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
  mkdirSync(context.workspaceSecretEnvDir, { recursive: true, mode: 0o700 })
  chmodSync(context.workspaceSecretEnvDir, 0o700)
  const sources: DockerMountSource[] = [
    { label: 'workspace', path: context.workspaceFolder },
    { label: 'Boxdown devcontainer assets', path: context.assetsDevcontainerDir },
    { label: 'Boxdown runtime state', path: runtimeProbeDir },
    { label: 'Boxdown runtime secret state', path: context.workspaceSecretEnvDir }
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
