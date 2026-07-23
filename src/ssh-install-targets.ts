import { claudeSshConfigEntryForWorkspace, installClaudeSshConfigHost, uninstallClaudeSshConfigHost } from './claude-app-config.ts'
import { codexProjectEntryForWorkspace, installCodexAppConfigProject, installCodexGlobalStateProject, legacyCodexRemotePathForWorkspace, uninstallCodexAppConfigProject, uninstallCodexGlobalStateProject } from './codex-app-config.ts'
import type { WorkspaceContext } from './paths.ts'

export type SshConfigInstallTarget = 'codex' | 'claude'

export interface SshInstallTargetOptions {
  quiet?: boolean
}

export interface SshInstallTargetDefinition {
  value: SshConfigInstallTarget
  label: string
  description: string
  flag: string
  install: (context: WorkspaceContext, alias: string, options?: SshInstallTargetOptions) => Promise<void> | void
  uninstall: (context: WorkspaceContext, alias: string, options?: SshInstallTargetOptions) => Promise<void> | void
}

function installCodexTarget (context: WorkspaceContext, alias: string, options: SshInstallTargetOptions = {}): void {
  const entry = codexProjectEntryForWorkspace(context, alias)
  const legacyRemotePath = legacyCodexRemotePathForWorkspace(context)
  const result = installCodexAppConfigProject(entry, { legacyRemotePaths: [legacyRemotePath] })
  const stateResult = installCodexGlobalStateProject(entry, { legacyRemotePaths: [legacyRemotePath] })

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

  if (stateResult.backupPath !== undefined) {
    process.stdout.write(`Codex app state backup: ${stateResult.backupPath}\n`)
  }

  process.stdout.write('Restart Codex to apply the remote project entry.\n')
}

function uninstallCodexTarget (context: WorkspaceContext, alias: string, options: SshInstallTargetOptions = {}): void {
  const entry = codexProjectEntryForWorkspace(context, alias)
  const legacyRemotePath = legacyCodexRemotePathForWorkspace(context)
  const result = uninstallCodexAppConfigProject(entry, {
    additionalRemotePaths: [legacyRemotePath]
  })

  if (options.quiet !== true) {
    process.stdout.write(`\nCodex app config: ${result.configPath}\n`)
    process.stdout.write(result.changed
      ? `Removed Codex remote project: ${entry.label} (${entry.remotePath})\n`
      : `Codex remote project not installed: ${entry.label} (${entry.remotePath})\n`)

    if (result.backupPath !== undefined) {
      process.stdout.write(`Codex app config backup: ${result.backupPath}\n`)
    }
  }

  const stateResult = uninstallCodexGlobalStateProject(entry, {
    additionalRemotePaths: [legacyRemotePath]
  })

  if (options.quiet === true) {
    return
  }

  process.stdout.write(`\nCodex app state: ${stateResult.statePath}\n`)
  process.stdout.write(stateResult.changed
    ? `Removed Codex sidebar state: ${entry.label} (${entry.remotePath})\n`
    : `Codex sidebar state not installed: ${entry.label} (${entry.remotePath})\n`)

  if (stateResult.backupPath !== undefined) {
    process.stdout.write(`Codex app state backup: ${stateResult.backupPath}\n`)
  }

  process.stdout.write('Restart Codex to apply the remote project removal.\n')
}

function installClaudeTarget (context: WorkspaceContext, alias: string, options: SshInstallTargetOptions = {}): void {
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

function uninstallClaudeTarget (context: WorkspaceContext, alias: string, options: SshInstallTargetOptions = {}): void {
  const entry = claudeSshConfigEntryForWorkspace(context, alias)
  const result = uninstallClaudeSshConfigHost(entry)

  if (options.quiet === true) {
    return
  }

  process.stdout.write(`\nClaude SSH config: ${result.configPath}\n`)
  process.stdout.write(result.changed
    ? `Removed Claude SSH remote: ${entry.name} (${entry.sshHost})\n`
    : `Claude SSH remote not installed: ${entry.name} (${entry.sshHost})\n`)

  if (result.backupPath !== undefined) {
    process.stdout.write(`Claude SSH config backup: ${result.backupPath}\n`)
  }

  process.stdout.write('Restart Claude to apply the SSH remote removal.\n')
}

export const SSH_INSTALL_TARGETS: readonly SshInstallTargetDefinition[] = [
  {
    value: 'codex',
    label: 'Codex',
    description: 'Register this SSH alias as a Codex app remote project.',
    flag: '--target codex',
    install: installCodexTarget,
    uninstall: uninstallCodexTarget
  },
  {
    value: 'claude',
    label: 'Claude',
    description: 'Register this SSH alias as a Claude app SSH remote.',
    flag: '--target claude',
    install: installClaudeTarget,
    uninstall: uninstallClaudeTarget
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
  options: SshInstallTargetOptions = {}
): Promise<void> {
  const target = SSH_INSTALL_TARGETS.find((candidate) => candidate.value === targetValue)

  if (target === undefined) {
    throw new Error(`Unsupported ssh install target: ${targetValue}`)
  }

  await target.install(context, alias, options)
}

export async function uninstallSshInstallTarget (
  context: WorkspaceContext,
  alias: string,
  targetValue: SshConfigInstallTarget,
  options: SshInstallTargetOptions = {}
): Promise<void> {
  const target = SSH_INSTALL_TARGETS.find((candidate) => candidate.value === targetValue)

  if (target === undefined) {
    throw new Error(`Unsupported ssh install target: ${targetValue}`)
  }

  await target.uninstall(context, alias, options)
}
