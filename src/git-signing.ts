import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { WorkspaceContext } from './paths.ts'
import { runBuffered } from './process.ts'

export type GitSigningReason = 'agent-unavailable' | 'no-identities' | 'ambiguous-identities' | 'configured-key-not-loaded' | 'agent-mount-unavailable'

export interface GitSigningPlan {
  enabled: boolean
  reason?: GitSigningReason
  publicKey?: string
  agentSocketSource?: string
}

export function parseSshPublicKey (value: string): string | undefined {
  const [algorithm, key] = value.trim().split(/\s+/, 3)
  if (algorithm === undefined || key === undefined || !/^ssh-[A-Za-z0-9-]+$/.test(algorithm) || key.length === 0) {
    return undefined
  }

  return `${algorithm} ${key}`
}

export function selectGitSigningKey (identities: string[], configuredKey?: string, githubKeys?: string[]): { key?: string, reason?: GitSigningReason } {
  const keys = identities.map(parseSshPublicKey).filter((key): key is string => key !== undefined)
  if (keys.length === 0) return { reason: 'no-identities' }

  const configured = configuredKey === undefined ? undefined : parseSshPublicKey(configuredKey)
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

async function dockerCanMountAgent (source: string): Promise<boolean> {
  const images = await runBuffered('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'], { mirrorStdout: false, mirrorStderr: false })
  const image = images.stdout.split(/\r?\n/).map((value) => value.trim()).find((value) => value.length > 0 && value !== '<none>:<none>')
  if (images.code !== 0 || image === undefined) return false

  const created = await runBuffered('docker', ['create', '--pull=never', '--entrypoint', '/bin/true', '--mount', `type=bind,source=${source},target=/run/boxdown/ssh-agent.sock`, image], { mirrorStdout: false, mirrorStderr: false })
  const containerId = created.stdout.trim().split(/\r?\n/)[0]
  if (created.code !== 0 || containerId === undefined || containerId.length === 0) return false
  await runBuffered('docker', ['rm', '-f', containerId], { mirrorStdout: false, mirrorStderr: false })
  return true
}

export async function resolveGitSigningPlan (context: WorkspaceContext): Promise<GitSigningPlan> {
  const result = await runBuffered('ssh-add', ['-L'], { mirrorStdout: false, mirrorStderr: false })
  if (result.code !== 0) return { enabled: false, reason: 'agent-unavailable' }

  const identities = result.stdout.split(/\r?\n/)
  const format = await runBuffered('git', ['config', '--global', '--get', 'gpg.format'], { mirrorStdout: false, mirrorStderr: false })
  const configuredKey = format.code === 0 && format.stdout.trim() === 'ssh'
    ? (await runBuffered('git', ['config', '--global', '--get', 'user.signingkey'], { mirrorStdout: false, mirrorStderr: false })).stdout.trim()
    : undefined
  let githubKeys: string[] | undefined
  if (identities.filter((key) => parseSshPublicKey(key) !== undefined).length > 1) {
    const user = await runBuffered('gh', ['api', 'user', '--jq', '.login'], { mirrorStdout: false, mirrorStderr: false })
    const login = user.stdout.trim()
    if (user.code === 0 && login.length > 0) {
      const github = await runBuffered('gh', ['api', `users/${login}/keys`, '--paginate', '--jq', '.[].key'], { mirrorStdout: false, mirrorStderr: false })
      if (github.code === 0) githubKeys = github.stdout.split(/\r?\n/)
    }
  }
  const selected = selectGitSigningKey(identities, configuredKey, githubKeys)
  if (selected.key === undefined) return { enabled: false, reason: selected.reason }

  const agentSocketSource = process.platform === 'darwin'
    ? '/run/host-services/ssh-auth.sock'
    : process.env.SSH_AUTH_SOCK
  if (agentSocketSource === undefined || agentSocketSource.length === 0) return { enabled: false, reason: 'agent-mount-unavailable' }
  if (!await dockerCanMountAgent(agentSocketSource)) return { enabled: false, reason: 'agent-mount-unavailable' }

  writeGitSigningPublicKey(context, selected.key)
  return { enabled: true, publicKey: selected.key, agentSocketSource }
}
