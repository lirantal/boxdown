import { join } from 'node:path'

import { claudeSshConfigEntryForWorkspace, installClaudeSshConfigHost, uninstallClaudeSshConfigHost } from './claude-app-config.ts'
import { codexProjectEntryForWorkspace, installCodexAppConfigProject, installCodexGlobalStateProject, legacyCodexRemotePathForWorkspace, uninstallCodexAppConfigProject, uninstallCodexGlobalStateProject } from './codex-app-config.ts'
import { installCursorSshTarget, uninstallCursorSshTarget, uninstallCursorWorkspaceTarget, type CursorInstallResult, type CursorUninstallResult } from './cursor-app-config.ts'
import type { WorkspaceContext } from './paths.ts'
import { runBuffered } from './process.ts'

export type SshConfigInstallTarget = 'codex' | 'claude' | 'cursor'

export interface SshInstallTargetOptions {
  quiet?: boolean
  writeEssential?: (message: string) => void
}

export interface SshInstallTargetDefinition {
  value: SshConfigInstallTarget
  label: string
  description: string
  flag: string
  usesContainerAgentProfile: boolean
  install: (context: WorkspaceContext, alias: string, options?: SshInstallTargetOptions) => Promise<void> | void
  uninstall: (context: WorkspaceContext, alias: string, options?: SshInstallTargetOptions) => Promise<void> | void
  uninstallWorkspace: (context: WorkspaceContext, aliases: readonly string[], options?: SshInstallTargetOptions) => Promise<void> | void
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

function cursorDispositionMessage (alias: string, result: CursorInstallResult): string {
  if (result.disposition === 'installed') {
    return `Installed Cursor Linux platform mapping: ${alias}\n`
  }
  if (result.disposition === 'already-boxdown-managed') {
    return `Cursor Linux platform mapping already managed: ${alias}\n`
  }
  return `Preserved user-owned Cursor Linux platform mapping: ${alias}\n`
}

function cursorUninstallMessage (alias: string, result: CursorUninstallResult): string {
  if (result.settingsChanged) return `Removed Cursor Linux platform mapping: ${alias}\n`
  if (result.retainedBecause === 'user-owned') {
    return `Preserved user-owned Cursor Linux platform mapping while releasing Boxdown ownership: ${alias}\n`
  }
  if (result.retainedBecause === 'shared-owner') {
    return `Preserved shared Cursor Linux platform mapping for another Boxdown workspace: ${alias}\n`
  }
  if (result.retainedBecause === 'user-modified') {
    return `Preserved user-modified Cursor Linux platform mapping while releasing Boxdown ownership: ${alias}\n`
  }
  return `Preserved Cursor Linux platform mapping because peer ownership is uncertain: ${alias}\n`
}

function warnAboutCursorCleanupUncertainty (context: WorkspaceContext, results: readonly CursorUninstallResult[]): void {
  for (const result of results.filter(candidate => candidate.retainedBecause === 'uncertain-peer')) {
    const alias = result.aliases.join(', ')
    process.stderr.write(
      `Warning: Preserved Cursor Linux platform mapping because peer ownership is uncertain: ${alias} (${result.settingsPath}). ` +
      `Review unreadable Cursor integration records under ${join(context.dataRoot, 'workspaces')} before removing it manually.\n`
    )
  }
}

function printCursorUninstallResults (results: readonly CursorUninstallResult[]): void {
  for (const result of results) {
    process.stdout.write(cursorUninstallMessage(result.aliases.join(', '), result))
    process.stdout.write(`Cursor settings: ${result.settingsPath}\n`)
  }
}

async function warnAboutCursorRemoteSshPrerequisite (): Promise<void> {
  const result = await runBuffered('cursor', ['--list-extensions'], {
    timeoutMs: 5_000,
    mirrorStdout: false,
    mirrorStderr: false,
    logOutput: false
  })
  const installed = result.code === 0 && result.stdout
    .split(/\r?\n/u)
    .some((extension) => extension.trim().toLowerCase() === 'anysphere.remote-ssh')

  if (installed) return

  if (result.code === 127) {
    process.stderr.write('Warning: Cursor CLI was not found; install Cursor and the anysphere.remote-ssh extension before opening the remote workspace.\n')
    return
  }

  const reason = result.timedOut === true
    ? 'the extension query timed out after 5 seconds'
    : result.code === 0
      ? 'the extension is not listed'
      : `the extension query exited with code ${result.code}`
  process.stderr.write(`Warning: Could not verify the Cursor Remote SSH extension (anysphere.remote-ssh): ${reason}.\n`)
  process.stderr.write('Install it if needed with: cursor --install-extension anysphere.remote-ssh\n')
}

async function installCursorTarget (context: WorkspaceContext, alias: string, options: SshInstallTargetOptions = {}): Promise<void> {
  const result = await installCursorSshTarget(context, alias)
  const writeEssential = options.writeEssential ?? ((message: string) => process.stdout.write(`${message}\n`))

  if (options.quiet !== true) {
    process.stdout.write('\n')
    process.stdout.write(cursorDispositionMessage(alias, result))
  }
  writeEssential(`Cursor settings: ${result.settingsPath}`)
  writeEssential(`Cursor remote folder URI: ${result.folderUri}`)
  writeEssential(`Cursor open command${result.commandLabel === undefined ? '' : ` (${result.commandLabel})`}: ${result.command}`)
  writeEssential('Refresh Cursor Remote Explorer or restart Cursor if the SSH alias is not visible.')

  await warnAboutCursorRemoteSshPrerequisite()
}

async function uninstallCursorTarget (context: WorkspaceContext, alias: string, options: SshInstallTargetOptions = {}): Promise<void> {
  const results = await uninstallCursorSshTarget(context, alias)
  warnAboutCursorCleanupUncertainty(context, results)
  if (options.quiet === true) return

  if (results.length === 0) {
    process.stdout.write(`Cursor Linux platform mapping not installed: ${alias}\n`)
    return
  }
  printCursorUninstallResults(results)
}

async function uninstallCursorWorkspace (context: WorkspaceContext, _aliases: readonly string[], options: SshInstallTargetOptions = {}): Promise<void> {
  const results = await uninstallCursorWorkspaceTarget(context)
  warnAboutCursorCleanupUncertainty(context, results)
  if (options.quiet === true) return

  if (results.length === 0) {
    process.stdout.write('Cursor workspace integration not installed.\n')
    return
  }

  printCursorUninstallResults(results)
}

export const SSH_INSTALL_TARGETS: readonly SshInstallTargetDefinition[] = [
  {
    value: 'codex',
    label: 'ChatGPT app',
    description: 'Connect ChatGPT to this project.',
    flag: '--target codex',
    usesContainerAgentProfile: true,
    install: installCodexTarget,
    uninstall: uninstallCodexTarget,
    uninstallWorkspace: async (context, aliases, options) => {
      for (const alias of aliases) await uninstallCodexTarget(context, alias, options)
    }
  },
  {
    value: 'claude',
    label: 'Claude app',
    description: 'Connect Claude to this project.',
    flag: '--target claude',
    usesContainerAgentProfile: true,
    install: installClaudeTarget,
    uninstall: uninstallClaudeTarget,
    uninstallWorkspace: async (context, aliases, options) => {
      for (const alias of aliases) await uninstallClaudeTarget(context, alias, options)
    }
  },
  {
    value: 'cursor',
    label: 'Cursor',
    description: 'Connect Cursor to this project.',
    flag: '--target cursor',
    usesContainerAgentProfile: false,
    install: installCursorTarget,
    uninstall: uninstallCursorTarget,
    uninstallWorkspace: uninstallCursorWorkspace
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

export function sshInstallTargetsUseContainerAgentProfile (targets: readonly SshConfigInstallTarget[]): boolean {
  return targets.some((value) => SSH_INSTALL_TARGETS.find((target) => target.value === value)?.usesContainerAgentProfile === true)
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

export async function uninstallWorkspaceSshInstallTarget (
  context: WorkspaceContext,
  aliases: readonly string[],
  targetValue: SshConfigInstallTarget,
  options: SshInstallTargetOptions = {}
): Promise<void> {
  const target = SSH_INSTALL_TARGETS.find((candidate) => candidate.value === targetValue)

  if (target === undefined) {
    throw new Error(`Unsupported ssh install target: ${targetValue}`)
  }

  await target.uninstallWorkspace(context, aliases, options)
}
