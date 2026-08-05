import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  probeContainerRuntime,
  type ContainerRuntimeCommandResult,
  type ContainerRuntimeCommandRunner
} from './container-runtime.ts'
import { resolveDevcontainerCli } from './devcontainer-cli.ts'
import { buildGeneratedDevcontainerConfig, type DevcontainerConfig } from './config.ts'
import { BOXDOWN_SECRET_ENV_NAMES } from './constants.ts'
import { classifyGitSigningPreference, readGitSigningConfigValue, resolveConfiguredSshSigningKey, selectGitSigningKey, type GitSigningReason } from './git-signing.ts'
import type { WorkspaceContext } from './paths.ts'
import { runBuffered } from './process.ts'

export type DoctorLevel = 'ok' | 'fail' | 'warn'

export interface DoctorCheck {
  name: string
  level: DoctorLevel
  message: string
}

export type DoctorCommandResult = ContainerRuntimeCommandResult
export type DoctorCommandRunner = ContainerRuntimeCommandRunner

export interface RunDoctorChecksOptions {
  includeOptional?: boolean
  includeDockerMountProbe?: boolean
  containerRuntimeReady?: boolean
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

  const format = await readGitSigningConfigValue(context.workspaceFolder, runCommand, 'gpg.format')
  let signingPreference = classifyGitSigningPreference(format)
  const program = signingPreference === undefined
    ? await readGitSigningConfigValue(context.workspaceFolder, runCommand, 'gpg.program')
    : undefined
  signingPreference = classifyGitSigningPreference(format, program)
  const formatIsSsh = format.code === 0 && format.stdout.trim() === 'ssh'
  const defaultSigningKey = formatIsSsh || signingPreference !== undefined
    ? undefined
    : await readGitSigningConfigValue(context.workspaceFolder, runCommand, 'user.signingkey')
  const defaultCommitSign = formatIsSsh || signingPreference !== undefined
    ? undefined
    : await readGitSigningConfigValue(context.workspaceFolder, runCommand, 'commit.gpgsign')
  signingPreference = classifyGitSigningPreference(format, program, defaultSigningKey, defaultCommitSign)
  const preservesExistingSigning = signingPreference === 'user-signing-preference'
  const gpgSigningUnavailable = signingPreference === 'gpg-signing-unavailable'
  const skipsSshSigning = signingPreference !== undefined
  const sshAgent = skipsSshSigning ? undefined : await runCommand('ssh-add', ['-L'])
  const identityLines = sshAgent?.code === 0
    ? sshAgent.stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('ssh-'))
    : []
  const identities = identityLines.length
  let configuredKey: string | undefined
  let configuredFailure: { reason: GitSigningReason, detail?: string } | undefined
  if (!skipsSshSigning && formatIsSsh) {
    const signingKey = await readGitSigningConfigValue(context.workspaceFolder, runCommand, 'user.signingkey')
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
  if (includeOptional && !skipsSshSigning) {
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

  const selected: { key?: string, reason?: GitSigningReason } | undefined = skipsSshSigning
    ? undefined
    : configuredFailure ?? selectGitSigningKey(identityLines, configuredKey, githubAuthKeys)
  const selectedByConfiguration = selected?.key !== undefined && configuredKey !== undefined
  const selectedByGithub = selected?.key !== undefined && configuredKey === undefined && identities > 1
  const signingMessages: Record<GitSigningReason, string> = {
    'gpg-signing-unavailable': 'GPG commit signing is configured, but the default Boxdown image does not provide GnuPG or GPG-agent forwarding; commits in this container may fail to sign',
    'user-signing-preference': 'Existing non-SSH Git signing configuration detected; Boxdown SSH signing is skipped',
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
    level: preservesExistingSigning || (sshAgent?.code === 0 && selected?.key !== undefined) ? 'ok' : 'warn',
    message: gpgSigningUnavailable
      ? signingMessages['gpg-signing-unavailable']
      : preservesExistingSigning
      ? 'Existing non-SSH Git signing configuration detected; Boxdown SSH signing is skipped'
      : sshAgent?.code !== 0
        ? signingMessages['agent-unavailable']
        : selected?.key === undefined
          ? signingMessages[selected?.reason ?? 'ambiguous-identities']
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

  let dockerCliWorks = options.containerRuntimeReady === true
  let dockerDaemonWorks = options.containerRuntimeReady === true

  if (options.containerRuntimeReady !== true) {
    const runtime = await probeContainerRuntime(runCommand)
    dockerCliWorks = runtime.state === 'ready' || runtime.failure.reason !== 'docker-cli-unavailable'
    dockerDaemonWorks = runtime.state === 'ready' ||
      (runtime.state === 'waiting' && runtime.failure.reason === 'buildx-builder-unavailable')

    checks.push(check(
      'docker-cli',
      dockerCliWorks,
      'Docker CLI is available',
      'Docker CLI is required but was not available'
    ))
    checks.push(check(
      'docker-daemon',
      dockerDaemonWorks,
      'Docker daemon is reachable',
      'Docker daemon is required but was not reachable'
    ))

    if (!dockerCliWorks || !dockerDaemonWorks) {
      checks.push({
        name: 'docker-buildx',
        level: 'warn',
        message: 'Docker Buildx was not checked because the Docker runtime is unavailable'
      })
    } else if (runtime.state === 'ready' && runtime.mode === 'fallback') {
      checks.push({ name: 'docker-buildx', level: 'warn', message: runtime.warnings[0] as string })
    } else if (runtime.state === 'waiting') {
      checks.push({
        name: 'docker-buildx',
        level: 'fail',
        message: `Docker Buildx builder was not operational: ${runtime.failure.detail}`
      })
    } else {
      checks.push({ name: 'docker-buildx', level: 'ok', message: 'Docker Buildx builder is operational' })
    }
  }

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
      if (ghAuth && selected?.key !== undefined) {
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

function dockerBindSourceMissing (output: string): boolean {
  return /bind source path does not exist/i.test(output)
}

function compactOutput (output: string): string {
  return output.trim().replace(/\s+/g, ' ').slice(0, 300)
}

type DockerMountProbeResult =
  | { status: 'ok' }
  | { status: 'create-failed', output: string }
  | { status: 'missing-container-id' }
  | { status: 'cleanup-failed', output: string }

async function probeDockerBindMount (
  sourcePath: string,
  image: string,
  runCommand: DoctorCommandRunner
): Promise<DockerMountProbeResult> {
  const created = await runCommand('docker', [
    'create',
    '--pull=never',
    '--entrypoint',
    '/bin/true',
    '--mount',
    `type=bind,source=${sourcePath},target=/boxdown-preflight,readonly`,
    image
  ])

  if (created.code !== 0) {
    return { status: 'create-failed', output: `${created.stderr}\n${created.stdout}` }
  }

  const containerId = created.stdout.trim().split(/\r?\n/)[0]
  if (containerId === undefined || containerId.length === 0) {
    return { status: 'missing-container-id' }
  }

  const removed = await runCommand('docker', ['rm', '-f', containerId])
  if (removed.code !== 0) {
    return { status: 'cleanup-failed', output: removed.stderr }
  }

  return { status: 'ok' }
}

function mountProbeDetail (probe: DockerMountProbeResult): string {
  switch (probe.status) {
    case 'create-failed':
    case 'cleanup-failed':
      return compactOutput(probe.output) || 'Docker mount probe failed'
    case 'missing-container-id':
      return 'Docker did not return a container ID'
    case 'ok':
      return ''
  }
}

interface DockerMountSource {
  label: string
  path: string
  refreshParent?: string
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
    {
      label: 'Boxdown runtime state',
      path: runtimeProbeDir,
      refreshParent: dirname(context.workspaceDataDir)
    },
    {
      label: 'Boxdown runtime secret state',
      path: context.workspaceSecretEnvDir,
      refreshParent: dirname(context.workspaceRuntimeDir)
    }
  ]

  try {
    for (const source of sources) {
      let probe = await probeDockerBindMount(source.path, image, runCommand)

      if (
        probe.status === 'create-failed' &&
        source.refreshParent !== undefined &&
        existsSync(source.path) &&
        dockerBindSourceMissing(probe.output)
      ) {
        const refreshed = await probeDockerBindMount(source.refreshParent, image, runCommand)
        if (refreshed.status !== 'ok') {
          return {
            name: 'docker-bind-mounts',
            level: 'fail',
            message: `Docker could not refresh bind-mount visibility for ${source.label} path (${source.path}) through ${source.refreshParent}: ${mountProbeDetail(refreshed)}`
          }
        }
        probe = await probeDockerBindMount(source.path, image, runCommand)
      }

      if (probe.status === 'create-failed') {
        if (dockerMountError(probe.output)) {
          return {
            name: 'docker-bind-mounts',
            level: 'fail',
            message: `Docker cannot bind-mount the ${source.label} path (${source.path}). Check Docker Desktop file sharing and host-folder permissions.`
          }
        }

        return {
          name: 'docker-bind-mounts',
          level: 'warn',
          message: `Docker bind-mount readiness could not be checked for ${source.label}: ${mountProbeDetail(probe)}`
        }
      }

      if (probe.status === 'missing-container-id') {
        return {
          name: 'docker-bind-mounts',
          level: 'warn',
          message: `Docker bind-mount readiness could not be checked for ${source.label}: ${mountProbeDetail(probe)}`
        }
      }

      if (probe.status === 'cleanup-failed') {
        return {
          name: 'docker-bind-mounts',
          level: 'warn',
          message: `Docker bind-mount readiness was checked, but the disposable probe container could not be removed: ${mountProbeDetail(probe)}`
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
