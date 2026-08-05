import { join } from 'node:path'

import { claudeSshConfigEntryForWorkspace, installClaudeSshConfigHost, uninstallClaudeSshConfigHost } from './claude-app-config.ts'
import { codexProjectEntryForWorkspace, installCodexAppConfigProject, installCodexGlobalStateProject, legacyCodexRemotePathForWorkspace, uninstallCodexAppConfigProject, uninstallCodexGlobalStateProject } from './codex-app-config.ts'
import { installCursorSshTarget, uninstallCursorSshTarget, uninstallCursorWorkspaceTarget, type CursorInstallResult, type CursorUninstallResult } from './cursor-app-config.ts'
import type { WorkspaceContext } from './paths.ts'
import { runBuffered } from './process.ts'
import type { AppInstallResult, InstallWarning } from './ssh-install-result.ts'

export type SshConfigInstallTarget = 'codex' | 'claude' | 'cursor'

export interface SshInstallTargetOptions {
  quiet?: boolean
  writeEssential?: (message: string) => void
  warn?: (message: string) => void
}

export interface SshInstallTargetDefinition {
  value: SshConfigInstallTarget
  label: string
  description: string
  flag: string
  usesContainerAgentProfile: boolean
  install: (context: WorkspaceContext, alias: string, options?: SshInstallTargetOptions) => Promise<AppInstallResult> | AppInstallResult
  uninstall: (context: WorkspaceContext, alias: string, options?: SshInstallTargetOptions) => Promise<void> | void
  uninstallWorkspace: (context: WorkspaceContext, aliases: readonly string[], options?: SshInstallTargetOptions) => Promise<void> | void
}

function installCodexTarget (context: WorkspaceContext, alias: string, options: SshInstallTargetOptions = {}): AppInstallResult {
  const entry = codexProjectEntryForWorkspace(context, alias)
  const legacyRemotePath = legacyCodexRemotePathForWorkspace(context)
  const result = installCodexAppConfigProject(entry, { legacyRemotePaths: [legacyRemotePath] })
  const stateResult = installCodexGlobalStateProject(entry, { legacyRemotePaths: [legacyRemotePath] })
  const changed = result.changed || stateResult.changed
  const installResult: AppInstallResult = {
    kind: 'app',
    target: 'codex',
    appLabel: 'ChatGPT',
    disposition: changed ? 'installed' : 'already-current',
    summary: changed ? 'ChatGPT configured' : 'ChatGPT already configured',
    warnings: [],
    action: { label: `Restart ChatGPT, then open the remote project ${entry.label}.` },
    details: [
      { label: 'ChatGPT config', value: result.configPath },
      { label: 'ChatGPT remote project', value: `${entry.label} (${entry.remotePath})` },
      { label: 'ChatGPT state', value: stateResult.statePath },
      ...(result.backupPath === undefined ? [] : [{ label: 'ChatGPT config backup', value: result.backupPath }]),
      ...(stateResult.backupPath === undefined ? [] : [{ label: 'ChatGPT state backup', value: stateResult.backupPath }])
    ]
  }

  if (options.quiet === true) {
    return installResult
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

  return installResult
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

function installClaudeTarget (context: WorkspaceContext, alias: string, options: SshInstallTargetOptions = {}): AppInstallResult {
  const entry = claudeSshConfigEntryForWorkspace(context, alias)
  const result = installClaudeSshConfigHost(entry)
  const installResult: AppInstallResult = {
    kind: 'app',
    target: 'claude',
    appLabel: 'Claude',
    disposition: result.changed ? 'installed' : 'already-current',
    summary: result.changed ? 'Claude configured' : 'Claude already configured',
    warnings: [],
    action: { label: `Restart Claude, then open the configured SSH remote ${entry.name}.` },
    details: [
      { label: 'Claude SSH config', value: result.configPath },
      { label: 'Claude SSH remote', value: `${entry.name} (${entry.sshHost})` },
      ...(result.backupPath === undefined ? [] : [{ label: 'Claude SSH config backup', value: result.backupPath }])
    ]
  }

  if (options.quiet === true) {
    return installResult
  }

  process.stdout.write(`\nClaude SSH config: ${result.configPath}\n`)
  process.stdout.write(result.changed
    ? `Installed Claude SSH remote: ${entry.name} (${entry.sshHost})\n`
    : `Claude SSH remote already up to date: ${entry.name} (${entry.sshHost})\n`)

  if (result.backupPath !== undefined) {
    process.stdout.write(`Claude SSH config backup: ${result.backupPath}\n`)
  }

  process.stdout.write('Restart Claude to apply the SSH remote entry.\n')

  return installResult
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

async function cursorRemoteSshPrerequisiteWarnings (): Promise<InstallWarning[]> {
  const result = await runBuffered('cursor', ['--list-extensions'], {
    timeoutMs: 5_000,
    mirrorStdout: false,
    mirrorStderr: false,
    logOutput: false
  })
  const installed = result.code === 0 && result.stdout
    .split(/\r?\n/u)
    .some((extension) => extension.trim().toLowerCase() === 'anysphere.remote-ssh')

  if (installed) return []

  const remediation = {
    label: 'Install Cursor Remote SSH:',
    command: 'cursor --install-extension anysphere.remote-ssh'
  }

  if (result.code === 127) {
    return [{
      message: 'Cursor CLI was not found; install Cursor before opening the remote workspace.',
      remediation: {
        label: 'Install Cursor and its Remote SSH extension before opening this project.'
      }
    }]
  }

  const reason = result.timedOut === true
    ? 'the extension query timed out after 5 seconds'
    : result.code === 0
      ? 'the extension is not listed'
      : `the extension query exited with code ${result.code}`
  return [{
    message: `Could not verify Cursor Remote SSH: ${reason}.`,
    remediation
  }]
}

function cursorInstallDisposition (result: CursorInstallResult): AppInstallResult['disposition'] {
  if (result.disposition === 'installed') return 'installed'
  if (result.disposition === 'already-boxdown-managed') return 'already-current'
  return 'already-compatible'
}

function cursorInstallSummary (disposition: AppInstallResult['disposition']): string {
  if (disposition === 'installed') return 'Cursor configured'
  if (disposition === 'already-current') return 'Cursor already configured'
  return 'Cursor already compatible'
}

function emitCursorWarnings (warnings: readonly InstallWarning[], warn?: (message: string) => void): void {
  const writeWarning = warn ?? ((message: string) => process.stderr.write(`Warning: ${message}\n`))
  for (const warning of warnings) {
    if (warning.message === 'Cursor CLI was not found; install Cursor before opening the remote workspace.') {
      writeWarning('Cursor CLI was not found; install Cursor and the anysphere.remote-ssh extension before opening the remote workspace.')
      continue
    }
    if (warning.message.startsWith('Could not verify Cursor Remote SSH: ') && warning.remediation?.command !== undefined) {
      const reason = warning.message.slice('Could not verify Cursor Remote SSH: '.length)
      writeWarning(`Could not verify the Cursor Remote SSH extension (anysphere.remote-ssh): ${reason}`)
      writeWarning(`Install it if needed with: ${warning.remediation.command}`)
      continue
    }
    writeWarning(warning.message)
    if (warning.remediation !== undefined) {
      writeWarning(warning.remediation.label)
      if (warning.remediation.command !== undefined) writeWarning(warning.remediation.command)
    }
  }
}

async function installCursorTarget (context: WorkspaceContext, alias: string, options: SshInstallTargetOptions = {}): Promise<AppInstallResult> {
  const result = await installCursorSshTarget(context, alias)
  const warnings = await cursorRemoteSshPrerequisiteWarnings()
  const disposition = cursorInstallDisposition(result)
  const displayLines = result.commandLabel === 'PowerShell'
    ? [result.command]
    : [
        'cursor --folder-uri \\',
        `  '${result.folderUri}'`
      ]
  const installResult: AppInstallResult = {
    kind: 'app',
    target: 'cursor',
    appLabel: 'Cursor',
    disposition,
    summary: cursorInstallSummary(disposition),
    warnings,
    action: {
      label: 'Open this project in Cursor:',
      command: result.command,
      displayLines,
      ...(result.commandLabel === undefined ? {} : { commandLabel: result.commandLabel })
    },
    details: [
      { label: 'Cursor settings', value: result.settingsPath },
      { label: 'Cursor remote folder URI', value: result.folderUri },
      ...(result.disposition === 'preserved-user-owned'
        ? [{ label: 'Cursor remote platform mapping', value: 'User-owned Linux mapping preserved' }]
        : [])
    ]
  }
  const writeEssential = options.writeEssential ?? ((message: string) => process.stdout.write(`${message}\n`))

  if (options.quiet !== true) {
    process.stdout.write('\n')
    process.stdout.write(cursorDispositionMessage(alias, result))
  }
  if (options.quiet !== true || options.writeEssential !== undefined) {
    writeEssential(`Cursor settings: ${result.settingsPath}`)
    writeEssential(`Cursor remote folder URI: ${result.folderUri}`)
    writeEssential(`Cursor open command${result.commandLabel === undefined ? '' : ` (${result.commandLabel})`}: ${result.command}`)
    writeEssential('Refresh Cursor Remote Explorer or restart Cursor if the SSH alias is not visible.')
  }

  if (options.quiet !== true || options.warn !== undefined) {
    emitCursorWarnings(installResult.warnings, options.warn)
  }

  return installResult
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
): Promise<AppInstallResult> {
  const target = SSH_INSTALL_TARGETS.find((candidate) => candidate.value === targetValue)

  if (target === undefined) {
    throw new Error(`Unsupported ssh install target: ${targetValue}`)
  }

  return await target.install(context, alias, options)
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
