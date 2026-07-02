import { codexProjectEntryForWorkspace, installCodexAppConfigProject } from './codex-app-config.ts'
import type { WorkspaceContext } from './paths.ts'

export type SshConfigInstallTarget = 'codex'

export interface SshInstallTargetDefinition {
  value: SshConfigInstallTarget
  label: string
  description: string
  flag: string
  install: (context: WorkspaceContext, alias: string) => Promise<void> | void
}

function installCodexTarget (context: WorkspaceContext, alias: string): void {
  const entry = codexProjectEntryForWorkspace(context, alias)
  const result = installCodexAppConfigProject(entry)

  process.stdout.write(`\nCodex app config: ${result.configPath}\n`)
  process.stdout.write(result.changed
    ? `Installed Codex remote project: ${entry.label} (${entry.remotePath})\n`
    : `Codex remote project already up to date: ${entry.label} (${entry.remotePath})\n`)

  if (result.backupPath !== undefined) {
    process.stdout.write(`Codex app config backup: ${result.backupPath}\n`)
  }

  process.stdout.write('Restart Codex to apply the remote project entry.\n')
}

export const SSH_INSTALL_TARGETS: readonly SshInstallTargetDefinition[] = [
  {
    value: 'codex',
    label: 'Codex',
    description: 'Register this SSH alias as a Codex app remote project.',
    flag: '--target codex',
    install: installCodexTarget
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
  targetValue: SshConfigInstallTarget
): Promise<void> {
  const target = SSH_INSTALL_TARGETS.find((candidate) => candidate.value === targetValue)

  if (target === undefined) {
    throw new Error(`Unsupported ssh install target: ${targetValue}`)
  }

  await target.install(context, alias)
}
