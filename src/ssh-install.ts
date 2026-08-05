import type { WorkspaceContext } from './paths.ts'
import type { ProgressReporter, ProgressStepDefinition } from './progress.ts'
import { installSshConfig } from './ssh-config.ts'
import type { RemoteAccessInstallNotice, RemoteAccessInstallReport } from './ssh-install-result.ts'
import { SSH_INSTALL_TARGETS, installSshInstallTarget, type SshConfigInstallTarget } from './ssh-install-targets.ts'

export interface InstallRemoteAccessOptions {
  progress?: ProgressReporter
  installSsh?: typeof installSshConfig
  installTarget?: typeof installSshInstallTarget
  notices?: RemoteAccessInstallNotice[]
  retryCommand?: string
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function targetLabel (target: SshConfigInstallTarget): string {
  return SSH_INSTALL_TARGETS.find((candidate) => candidate.value === target)?.label ?? target
}

export function remoteAccessProgressSteps (
  targets: readonly SshConfigInstallTarget[]
): ProgressStepDefinition[] {
  return [
    { id: 'ssh-alias', label: 'Configuring SSH alias' },
    ...targets.map((target) => ({
      id: `ssh-target:${target}`,
      label: `Configuring ${targetLabel(target)}`
    }))
  ]
}

export async function installRemoteAccess (
  context: WorkspaceContext,
  alias: string,
  targets: readonly SshConfigInstallTarget[],
  options: InstallRemoteAccessOptions = {}
): Promise<RemoteAccessInstallReport> {
  const report: RemoteAccessInstallReport = {
    apps: [],
    failures: [],
    skipped: [],
    notices: [...(options.notices ?? [])]
  }
  const progress = options.progress
  const installSsh = options.installSsh ?? installSshConfig
  const installTarget = options.installTarget ?? installSshInstallTarget

  progress?.startStep('ssh-alias')
  try {
    report.ssh = await installSsh(context, alias)
    progress?.completeStep('ssh-alias')
  } catch (error) {
    progress?.failStep('ssh-alias')
    report.failures.push({
      scope: 'ssh',
      label: 'SSH alias',
      message: errorMessage(error),
      recovery: {
        label: 'Fix the SSH configuration problem, then rerun:',
        command: options.retryCommand ?? 'boxdown ssh install'
      }
    })
    for (const target of targets) {
      report.skipped.push({
        target,
        label: targetLabel(target),
        reason: 'SSH alias configuration failed'
      })
      progress?.skipStep(`ssh-target:${target}`)
    }
    return report
  }

  for (const target of targets) {
    const label = targetLabel(target)
    const stepId = `ssh-target:${target}`
    progress?.startStep(stepId)
    try {
      report.apps.push(await installTarget(context, alias, target))
      progress?.completeStep(stepId)
    } catch (error) {
      progress?.failStep(stepId)
      report.failures.push({
        scope: 'app',
        target,
        label,
        message: errorMessage(error),
        recovery: {
          label: `Fix ${label} configuration, then rerun:`,
          command: `boxdown ssh install --target ${target}`
        }
      })
    }
  }

  return report
}
