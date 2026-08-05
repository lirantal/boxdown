import { maybeColor, type CliColor } from './cli-style.ts'
import type { ProgressReporter } from './progress.ts'
import type { SshConfigInstallTarget } from './ssh-install-targets.ts'

export type InstallDisposition = 'installed' | 'already-current' | 'already-compatible'

export interface InstallDetail {
  label: string
  value: string
}

export interface InstallAction {
  label: string
  command?: string
  displayLines?: readonly string[]
  commandLabel?: string
}

export interface InstallWarning {
  message: string
  remediation?: InstallAction
}

export interface SshAliasInstallResult {
  kind: 'ssh'
  disposition: Extract<InstallDisposition, 'installed' | 'already-current'>
  summary: string
  alias: string
  configPath: string
  identityPath: string
  validationCommand: string
  details: InstallDetail[]
}

export interface AppInstallResult {
  kind: 'app'
  target: SshConfigInstallTarget
  appLabel: string
  disposition: InstallDisposition
  summary: string
  warnings: InstallWarning[]
  action: InstallAction
  details: InstallDetail[]
}

export interface RemoteAccessInstallFailure {
  scope: 'ssh' | 'app'
  target?: SshConfigInstallTarget
  label: string
  message: string
  recovery?: InstallAction
}

export interface RemoteAccessInstallSkipped {
  target: SshConfigInstallTarget
  label: string
  reason: string
}

export interface RemoteAccessInstallNotice {
  message: string
}

export interface RemoteAccessInstallReport {
  ssh?: SshAliasInstallResult
  apps: AppInstallResult[]
  failures: RemoteAccessInstallFailure[]
  skipped: RemoteAccessInstallSkipped[]
  notices: RemoteAccessInstallNotice[]
}

export interface FormatRemoteAccessInstallReportOptions {
  outcomeLabel: 'Configuration' | 'Setup'
  interactive: boolean
  columns: number
  verbose: boolean
  color: boolean
}

export interface WriteRemoteAccessInstallReportOptions extends Omit<FormatRemoteAccessInstallReportOptions, 'columns' | 'interactive' | 'color'> {
  output?: NodeJS.WritableStream & { isTTY?: boolean, columns?: number }
  progress?: ProgressReporter
  env?: NodeJS.ProcessEnv
}

interface ReportAction {
  action: InstallAction
  message?: string
}

function visibleLength (value: string): number {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '').length
}

function wrapWords (value: string, width: number): string[] {
  const words = value.trim().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return []

  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`
    if (line.length > 0 && visibleLength(candidate) > width) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line.length > 0) lines.push(line)
  return lines
}

function indentedProse (value: string, indent: string, columns: number): string[] {
  const lines = wrapWords(value, Math.max(1, columns - visibleLength(indent)))
  return lines.map((line, index) => index === 0 ? line : `${indent}${line}`)
}

function actionLines (action: InstallAction, indent: string): string[] {
  const lines = [`${indent}${action.label}`]
  if (action.commandLabel !== undefined) lines.push(`${indent}${action.commandLabel}`)

  const commandLines = action.displayLines ?? (action.command === undefined ? [] : [action.command])
  for (const line of commandLines) lines.push(`${indent}  ${line}`)
  return lines
}

function detailLines (details: readonly InstallDetail[], verbose: boolean): string[] {
  if (!verbose) return []
  return details.map((detail) => `${detail.label}: ${detail.value}`)
}

function statusMark (status: 'success' | 'warning' | 'failure' | 'skipped', enabled: boolean): string {
  const value = status === 'success' ? '✔' : status === 'warning' ? '!' : status === 'failure' ? '✖' : '○'
  const style: CliColor = status === 'success' ? 'green' : status === 'warning' ? 'yellow' : status === 'failure' ? 'red' : 'dim'
  return maybeColor(value, style, enabled)
}

function styled (value: string, style: CliColor, enabled: boolean): string {
  return maybeColor(value, style, enabled)
}

function failureTitle (failure: RemoteAccessInstallFailure): string {
  return failure.scope === 'app'
    ? `${failure.label} configuration failed`
    : `${failure.label} failed`
}

function reportActions (report: RemoteAccessInstallReport): ReportAction[] {
  const actions: ReportAction[] = []
  for (const failure of report.failures) {
    if (failure.recovery !== undefined) actions.push({ action: failure.recovery })
  }
  for (const app of report.apps) {
    for (const warning of app.warnings) {
      if (warning.remediation !== undefined) actions.push({ action: warning.remediation, message: warning.message })
    }
    actions.push({ action: app.action })
  }
  return actions
}

export function remoteAccessExitCode (report: RemoteAccessInstallReport): 0 | 1 {
  return report.failures.length === 0 ? 0 : 1
}

export function formatRemoteAccessInstallReport (
  report: RemoteAccessInstallReport,
  options: FormatRemoteAccessInstallReportOptions
): string {
  const lines: string[] = []
  const hasWarnings = report.apps.some((app) => app.warnings.length > 0)
  const hasFailures = report.failures.length > 0

  if (options.interactive) lines.push('')

  if (!options.interactive) {
    if (report.ssh !== undefined) lines.push(`${statusMark('success', options.color)} ${report.ssh.summary}`)
    for (const app of report.apps) lines.push(`${statusMark(app.warnings.length > 0 ? 'warning' : 'success', options.color)} ${app.summary}`)
    for (const skipped of report.skipped) lines.push(`${statusMark('skipped', options.color)} ${skipped.label} skipped`)
    if (lines.length > 0) lines.push('')
  }

  const outcomeStatus = hasFailures ? 'failure' : hasWarnings ? 'warning' : 'success'
  const outcomeText = hasFailures
    ? `${options.outcomeLabel} incomplete`
    : hasWarnings ? `${options.outcomeLabel} complete with warnings` : `${options.outcomeLabel} complete`
  const outcomeStyle: CliColor = outcomeStatus === 'success' ? 'green' : outcomeStatus === 'warning' ? 'yellow' : 'red'
  lines.push(`${statusMark(outcomeStatus, options.color)} ${styled(outcomeText, outcomeStyle, options.color)}`)

  for (const notice of report.notices) {
    lines.push(...indentedProse(notice.message, '  ', options.columns))
  }

  if (report.notices.length > 0 && (hasFailures || report.skipped.length > 0 || reportActions(report).length > 0 || options.verbose)) lines.push('')

  for (const failure of report.failures) {
    lines.push(`${statusMark('failure', options.color)} ${failureTitle(failure)}`)
    lines.push(...indentedProse(failure.message, '  ', options.columns))
  }
  for (const skipped of report.skipped) {
    lines.push(`${statusMark('skipped', options.color)} ${skipped.label} skipped`)
    lines.push(...indentedProse(skipped.reason, '  ', options.columns))
  }

  const actions = reportActions(report)
  if ((hasFailures || report.skipped.length > 0) && actions.length > 0) lines.push('')
  if (actions.length > 0) {
    lines.push(styled(actions.length === 1 ? 'Next step' : 'Next steps', 'bold', options.color))
    for (const [index, entry] of actions.entries()) {
      const prefix = actions.length === 1 ? '' : `${index + 1}. `
      if (entry.message !== undefined) lines.push(...indentedProse(entry.message, '  ', options.columns))
      const action = prefix.length === 0
        ? actionLines(entry.action, '')
        : actionLines({ ...entry.action, label: `${prefix}${entry.action.label}` }, '  ')
      const commandStart = entry.action.commandLabel === undefined ? 1 : 2
      lines.push(...action.map((line, lineIndex) => {
        if (lineIndex === 0) return line
        const leading = actions.length === 1 ? '  ' : '    '
        const content = line.trimStart()
        return `${leading}${lineIndex >= commandStart ? styled(content, 'cyan', options.color) : content}`
      }))
    }
  }

  const details = [
    ...(report.ssh === undefined ? [] : detailLines(report.ssh.details, options.verbose)),
    ...report.apps.flatMap((app) => detailLines(app.details, options.verbose))
  ]
  if (details.length > 0) {
    if (actions.length > 0) lines.push('')
    lines.push('Details')
    lines.push(...details)
  }

  return `${lines.join('\n')}\n`
}

export function formatRemoteAccessCancellation (
  label: string,
  options: { color: boolean }
): string {
  return `${maybeColor(`${label} canceled.`, 'yellow', options.color)} No changes made.\n`
}

export function writeRemoteAccessInstallReport (
  report: RemoteAccessInstallReport,
  options: WriteRemoteAccessInstallReportOptions
): void {
  const output = options.output ?? process.stdout
  const interactive = options.progress === undefined
    ? output.isTTY === true
    : options.progress.mode === 'interactive'
  const env = options.env ?? process.env
  const color = interactive && env.NO_COLOR === undefined
  const formatted = formatRemoteAccessInstallReport(report, {
    outcomeLabel: options.outcomeLabel,
    interactive,
    columns: output.columns ?? 80,
    verbose: options.verbose,
    color
  })

  if (options.progress !== undefined) {
    options.progress.appendResult(formatted.trimEnd().split('\n'), { color })
    return
  }

  output.write(formatted)
}
