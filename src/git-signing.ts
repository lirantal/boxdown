import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type { WorkspaceCommandLogger } from './logging.ts'
import type { WorkspaceContext } from './paths.ts'
import { runBuffered, type CommandResult } from './process.ts'

export type GitSigningReason = 'agent-unavailable' | 'no-identities' | 'ambiguous-identities' | 'configured-key-unreadable' | 'configured-key-invalid' | 'configured-key-not-loaded' | 'agent-socket-unavailable' | 'docker-probe-image-unavailable' | 'agent-mount-unavailable'

export interface GitSigningPlan {
  enabled: boolean
  reason?: GitSigningReason
  detail?: string
  publicKey?: string
  agentSocketSource?: string
}

const GIT_SIGNING_REASON_MESSAGES: Record<GitSigningReason, string> = {
  'agent-unavailable': 'the host SSH agent is unavailable',
  'no-identities': 'the host SSH agent has no loaded identities',
  'ambiguous-identities': 'multiple SSH identities are loaded and no signing key could be selected safely',
  'configured-key-unreadable': 'the configured SSH signing-key file could not be read',
  'configured-key-invalid': 'the configured SSH signing key is not a valid public key',
  'configured-key-not-loaded': 'the configured SSH signing key is not loaded in the agent',
  'agent-socket-unavailable': 'the host SSH-agent socket is unavailable',
  'docker-probe-image-unavailable': 'no local Docker image is available to probe the SSH-agent mount',
  'agent-mount-unavailable': 'Docker could not mount the host SSH-agent socket'
}

function compactDiagnosticDetail (detail: string): string {
  return detail
    .trim()
    .replace(/\s+/gu, ' ')
    .slice(0, 2000)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|$)/giu, '[redacted-private-key]')
    .replace(/\b(?:ssh-[A-Za-z0-9-]+|ecdsa-sha2-[A-Za-z0-9-]+|sk-(?:ssh-[A-Za-z0-9-]+|ecdsa-sha2-[A-Za-z0-9-]+))\s+[A-Za-z0-9+/=]{16,}/gu, '[redacted-ssh-key]')
    .replace(/\b(?:github_pat_|gh[pousr]_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{8,}/gu, '[redacted-token]')
    .replace(/\b(?:Bearer\s+|token[=:]\s*)[A-Za-z0-9._~+/-]{8,}/giu, '[redacted-token]')
    .slice(0, 300)
}

export function reportGitSigningPlan (
  plan: GitSigningPlan,
  options: {
    logger?: Pick<WorkspaceCommandLogger, 'boxdown'>
    quiet?: boolean
    writeWarning?: (message: string) => void
  } = {}
): void {
  if (plan.enabled) return

  const reason = plan.reason ?? 'agent-unavailable'
  const detail = plan.detail === undefined ? '' : ` detail=${compactDiagnosticDetail(plan.detail)}`
  options.logger?.boxdown(`git-signing: enabled=false reason=${reason}${detail}\n`)

  if (options.quiet !== true) {
    const writeWarning = options.writeWarning ?? ((message: string) => process.stderr.write(message))
    writeWarning(`boxdown: commit signing disabled: ${GIT_SIGNING_REASON_MESSAGES[reason]}; commits will remain unsigned.\n`)
  }
}

export function parseSshPublicKey (value: string): string | undefined {
  const [algorithm, key] = value.trim().split(/\s+/, 3)
  if (algorithm === undefined || key === undefined || !/^ssh-[A-Za-z0-9-]+$/.test(algorithm) || key.length === 0) {
    return undefined
  }

  return `${algorithm} ${key}`
}

export interface ConfiguredSshSigningKeyResult {
  key?: string
  reason?: Extract<GitSigningReason, 'configured-key-unreadable' | 'configured-key-invalid'>
  detail?: string
}

export function resolveConfiguredSshSigningKey (
  value: string,
  options: { homeDir?: string, workspaceFolder: string }
): ConfiguredSshSigningKeyResult {
  const inlineValue = value.startsWith('key::') ? value.slice('key::'.length) : value
  const inlineKey = parseSshPublicKey(inlineValue)
  if (inlineKey !== undefined) {
    return { key: inlineKey }
  }
  if (value.startsWith('key::')) {
    return {
      reason: 'configured-key-invalid',
      detail: 'configured inline value is not a valid SSH public key'
    }
  }

  let keyPath: string
  if (value.startsWith('~/')) {
    if (options.homeDir === undefined) {
      return {
        reason: 'configured-key-unreadable',
        detail: 'configured public-key file could not be read'
      }
    }
    keyPath = join(options.homeDir, value.slice(2))
  } else {
    keyPath = isAbsolute(value) ? value : resolve(options.workspaceFolder, value)
  }

  let publicKeyText: string
  try {
    publicKeyText = readFileSync(keyPath, 'utf8')
  } catch {
    return {
      reason: 'configured-key-unreadable',
      detail: 'configured public-key file could not be read'
    }
  }

  const publicKey = parseSshPublicKey(publicKeyText.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? '')
  return publicKey === undefined
    ? {
        reason: 'configured-key-invalid',
        detail: 'configured public-key file does not contain a valid SSH public key'
      }
    : { key: publicKey }
}

export function selectGitSigningKey (identities: string[], configuredKey?: string, githubKeys?: string[]): { key?: string, reason?: GitSigningReason } {
  const keys = identities.map(parseSshPublicKey).filter((key): key is string => key !== undefined)
  if (keys.length === 0) return { reason: 'no-identities' }

  const configured = configuredKey === undefined ? undefined : parseSshPublicKey(configuredKey)
  if (configuredKey !== undefined && configured === undefined) {
    return { reason: 'configured-key-invalid' }
  }
  if (configured !== undefined) {
    return keys.includes(configured) ? { key: configured } : { reason: 'configured-key-not-loaded' }
  }

  const github = new Set((githubKeys ?? []).map(parseSshPublicKey).filter((key): key is string => key !== undefined))
  const matches = keys.filter((key) => github.has(key))
  if (matches.length === 1) return { key: matches[0] }
  if (keys.length === 1) return { key: keys[0] }
  return { reason: 'ambiguous-identities' }
}

export function writeGitSigningPublicKey (context: WorkspaceContext, key: string): void {
  mkdirSync(context.gitSigningStateDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(context.gitSigningStateDir, 'signing-key.pub'), `${parseSshPublicKey(key) ?? key}\n`, { mode: 0o644 })
}

type GitSigningCommandRunner = (command: string, args: string[]) => Promise<CommandResult>

interface ResolveGitSigningPlanOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  runCommand?: GitSigningCommandRunner
}

type AgentMountProbeResult =
  | { ok: true }
  | { ok: false, reason: Extract<GitSigningReason, 'docker-probe-image-unavailable' | 'agent-mount-unavailable'>, detail: string }

async function runGitSigningCommand (command: string, args: string[]): Promise<CommandResult> {
  return runBuffered(command, args, { mirrorStdout: false, mirrorStderr: false })
}

function failedCommandDetail (label: string, result: CommandResult): string {
  const stderr = compactDiagnosticDetail(result.stderr)
  return stderr.length === 0
    ? `${label} failed with exit code ${result.code}`
    : `${label} failed with exit code ${result.code}: ${stderr}`
}

async function probeDockerAgentMount (source: string, runCommand: GitSigningCommandRunner): Promise<AgentMountProbeResult> {
  const images = await runCommand('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])
  const image = images.stdout.split(/\r?\n/).map((value) => value.trim()).find((value) => value.length > 0 && value !== '<none>:<none>')
  if (images.code !== 0) {
    return {
      ok: false,
      reason: 'agent-mount-unavailable',
      detail: failedCommandDetail('Docker image listing', images)
    }
  }
  if (image === undefined) {
    return {
      ok: false,
      reason: 'docker-probe-image-unavailable',
      detail: 'no tagged local Docker image was found'
    }
  }

  const created = await runCommand('docker', ['create', '--pull=never', '--entrypoint', '/bin/true', '--mount', `type=bind,source=${source},target=/run/boxdown/ssh-agent.sock`, image])
  const containerId = created.stdout.trim().split(/\r?\n/)[0]
  if (created.code !== 0 || containerId === undefined || containerId.length === 0) {
    return {
      ok: false,
      reason: 'agent-mount-unavailable',
      detail: failedCommandDetail('Docker SSH-agent mount probe', created)
    }
  }
  await runCommand('docker', ['rm', '-f', containerId])
  return { ok: true }
}

export async function resolveGitSigningPlan (context: WorkspaceContext, options: ResolveGitSigningPlanOptions = {}): Promise<GitSigningPlan> {
  const runCommand = options.runCommand ?? runGitSigningCommand
  const result = await runCommand('ssh-add', ['-L'])
  if (result.code !== 0) {
    return {
      enabled: false,
      reason: 'agent-unavailable',
      detail: failedCommandDetail('ssh-add -L', result)
    }
  }

  const identities = result.stdout.split(/\r?\n/)
  const format = await runCommand('git', ['config', '--global', '--get', 'gpg.format'])
  let configuredKey: string | undefined
  if (format.code === 0 && format.stdout.trim() === 'ssh') {
    const signingKey = await runCommand('git', ['config', '--global', '--get', 'user.signingkey'])
    if (signingKey.code === 0 && signingKey.stdout.trim().length > 0) {
      const resolvedKey = resolveConfiguredSshSigningKey(signingKey.stdout.trim(), {
        homeDir: options.env?.HOME ?? process.env.HOME,
        workspaceFolder: context.workspaceFolder
      })
      if (resolvedKey.key === undefined) {
        return {
          enabled: false,
          reason: resolvedKey.reason ?? 'configured-key-invalid',
          detail: resolvedKey.detail
        }
      }
      configuredKey = resolvedKey.key
    }
  }
  let githubKeys: string[] | undefined
  if (configuredKey === undefined && identities.filter((key) => parseSshPublicKey(key) !== undefined).length > 1) {
    const user = await runCommand('gh', ['api', 'user', '--jq', '.login'])
    const login = user.stdout.trim()
    if (user.code === 0 && login.length > 0) {
      const github = await runCommand('gh', ['api', `users/${login}/keys`, '--paginate', '--jq', '.[].key'])
      if (github.code === 0) githubKeys = github.stdout.split(/\r?\n/)
    }
  }
  const selected = selectGitSigningKey(identities, configuredKey, githubKeys)
  if (selected.key === undefined) return { enabled: false, reason: selected.reason }

  const agentSocketSource = (options.platform ?? process.platform) === 'darwin'
    ? '/run/host-services/ssh-auth.sock'
    : options.env?.SSH_AUTH_SOCK ?? process.env.SSH_AUTH_SOCK
  if (agentSocketSource === undefined || agentSocketSource.length === 0) {
    return {
      enabled: false,
      reason: 'agent-socket-unavailable',
      detail: 'SSH_AUTH_SOCK is not set'
    }
  }
  const mountProbe = await probeDockerAgentMount(agentSocketSource, runCommand)
  if (!mountProbe.ok) {
    return {
      enabled: false,
      reason: mountProbe.reason,
      detail: mountProbe.detail
    }
  }

  writeGitSigningPublicKey(context, selected.key)
  return { enabled: true, publicKey: selected.key, agentSocketSource }
}
