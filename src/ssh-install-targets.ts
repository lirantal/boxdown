import { claudeSshConfigEntryForWorkspace, installClaudeSshConfigHost } from './claude-app-config.ts'
import { codexProjectEntryForWorkspace, installCodexAppConfigProject } from './codex-app-config.ts'
import type { WorkspaceContext } from './paths.ts'

export type SshConfigInstallTarget = 'codex' | 'claude'

export interface SshInstallTargetDefinition {
  value: SshConfigInstallTarget
  label: string
  description: string
  flag: string
  install: (context: WorkspaceContext, alias: string, options?: SshInstallTargetInstallOptions) => Promise<void> | void
}

export interface SshInstallTargetInstallOptions {
  quiet?: boolean
}

function installCodexTarget (context: WorkspaceContext, alias: string, options: SshInstallTargetInstallOptions = {}): void {
  const entry = codexProjectEntryForWorkspace(context, alias)
  const result = installCodexAppConfigProject(entry)

  if (options.quiet === true) {
    return
  }

  process.stdout.write(`\nCodex app config: ${result.configPath}\n`)
  process.stdout.write(result.changed
    ? `Installed Codex remote project: ${entry.label} (${entry.remotePath})\n`
    : `Codex remote project already up to date: ${entry.label} (${entry.remotePath})\n`)

  if (result.backupPath !== undefined) {
    process.stdout.write(`Codex app config backup: ${result.backupPath}\n`)
  }

  process.stdout.write('Restart Codex to apply the remote project entry.\n')
}

function installClaudeTarget (context: WorkspaceContext, alias: string, options: SshInstallTargetInstallOptions = {}): void {
  const entry = claudeSshConfigEntryForWorkspace(context, alias)
  const result = installClaudeSshConfigHost(entry)

  if (options.quiet === true) {
    return
  }

  process.stdout.write(`\nClaude SSH config: ${result.configPath}\n`)
  process.stdout.write(result.changed
    ? `Installed Claude SSH remote: ${entry.name} (${entry.sshHost})\n`
    : `Claude SSH remote already up to date: ${entry.name} (${entry.sshHost})\n`)

  if (result.backupPath !== undefined) {
    process.stdout.write(`Claude SSH config backup: ${result.backupPath}\n`)
  }

  process.stdout.write('Restart Claude to apply the SSH remote entry.\n')
}

export const SSH_INSTALL_TARGETS: readonly SshInstallTargetDefinition[] = [
  {
    value: 'codex',
    label: 'Codex',
    description: 'Register this SSH alias as a Codex app remote project.',
    flag: '--target codex',
    install: installCodexTarget
  },
  {
    value: 'claude',
    label: 'Claude',
    description: 'Register this SSH alias as a Claude app SSH remote.',
    flag: '--target claude',
    install: installClaudeTarget
  }
]

export function supportedSshInstallTargetsText (): string {
  return SSH_INSTALL_TARGETS.map((target) => target.value).join(', ')
}

export function sshInstallTargetFlagHintsText (): string {
  return SSH_INSTALL_TARGETS.map((target) => target.flag).join(' ')
}

export function isSshConfigInstallTarget (value: string): value is SshConfigInstallTarget {
  return SSH_INSTALL_TARGETS.some((target) => target.value === value)
}

export function dedupeSshInstallTargets (targets: readonly SshConfigInstallTarget[]): SshConfigInstallTarget[] {
  return [...new Set(targets)]
}

export async function installSshInstallTarget (
  context: WorkspaceContext,
  alias: string,
  targetValue: SshConfigInstallTarget,
  options: SshInstallTargetInstallOptions = {}
): Promise<void> {
  const target = SSH_INSTALL_TARGETS.find((candidate) => candidate.value === targetValue)

  if (target === undefined) {
    throw new Error(`Unsupported ssh install target: ${targetValue}`)
  }

  await target.install(context, alias, options)
}
