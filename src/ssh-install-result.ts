import { maybeColor, type CliColor } from './cli-style.ts'
import type { ProgressReporter } from './progress.ts'
import type { SshConfigInstallTarget } from './ssh-install-targets.ts'
import { visibleLength, wrapWithPrefixes } from './terminal-layout.ts'

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
}

function indentedProse (value: string, indent: string, columns: number): string[] {
  return wrapWithPrefixes(value, '', indent, columns)
}

function actionLines (
  action: InstallAction,
  firstPrefix: string,
  continuationPrefix: string,
  valueIndent: string,
  useDisplayLines: boolean,
  columns: number,
  colorEnabled: boolean
): string[] {
  const lines = wrapWithPrefixes(action.label, firstPrefix, continuationPrefix, columns)
  if (action.commandLabel !== undefined) {
    lines.push(...wrapWithPrefixes(action.commandLabel, valueIndent, `${valueIndent}  `, columns))
  }

  const commandLines = useDisplayLines
    ? action.displayLines ?? (action.command === undefined ? [] : [action.command])
    : action.command === undefined ? action.displayLines ?? [] : [action.command]
  for (const line of commandLines) {
    lines.push(`${valueIndent}${styled(line, 'cyan', colorEnabled)}`)
  }
  return lines
}

function detailLines (details: readonly InstallDetail[], verbose: boolean, columns: number): string[] {
  if (!verbose) return []
  return details.flatMap((detail) => [
    ...wrapWithPrefixes(`${detail.label}:`, '', '  ', columns),
    `  ${detail.value}`
  ])
}

function statusMark (status: 'success' | 'warning' | 'failure' | 'skipped', enabled: boolean): string {
  const value = status === 'success' ? '✔' : status === 'warning' ? '!' : status === 'failure' ? '✖' : '○'
  const style: CliColor = status === 'success' ? 'green' : status === 'warning' ? 'yellow' : status === 'failure' ? 'red' : 'dim'
  return maybeColor(value, style, enabled)
}

function styled (value: string, style: CliColor, enabled: boolean): string {
  return maybeColor(value, style, enabled)
}

function statusLines (
  status: 'success' | 'warning' | 'failure' | 'skipped',
  message: string,
  options: Pick<FormatRemoteAccessInstallReportOptions, 'columns' | 'color'>,
  messageStyle?: CliColor
): string[] {
  return wrapWithPrefixes(
    message,
    `${statusMark(status, options.color)} `,
    '  ',
    options.columns,
    (line) => messageStyle === undefined ? line : styled(line, messageStyle, options.color)
  )
}

function resultLabel (label: string): string {
  return label.endsWith(' app') ? label.slice(0, -' app'.length) : label
}

function failureTitle (failure: RemoteAccessInstallFailure): string {
  return failure.scope === 'app'
    ? `${resultLabel(failure.label)} configuration failed`
    : `${failure.label} failed`
}

function reportActions (report: RemoteAccessInstallReport): ReportAction[] {
  const actions: ReportAction[] = []
  const failedAppTargets = new Set(
    report.failures
      .filter((failure) => failure.scope === 'app' && failure.target !== undefined)
      .map((failure) => failure.target)
  )
  for (const failure of report.failures) {
    if (failure.recovery !== undefined) actions.push({ action: failure.recovery })
  }
  for (const app of report.apps) {
    if (failedAppTargets.has(app.target)) continue
    for (const warning of app.warnings) {
      if (warning.remediation !== undefined) actions.push({ action: warning.remediation })
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
    if (report.ssh !== undefined) lines.push(...statusLines('success', report.ssh.summary, options))
    for (const app of report.apps) lines.push(...statusLines(app.warnings.length > 0 ? 'warning' : 'success', app.summary, options))
    for (const skipped of report.skipped) lines.push(...statusLines('skipped', `${resultLabel(skipped.label)} skipped`, options))
    if (lines.length > 0) lines.push('')
  }

  const outcomeStatus = hasFailures ? 'failure' : hasWarnings ? 'warning' : 'success'
  const outcomeText = hasFailures
    ? `${options.outcomeLabel} incomplete`
    : hasWarnings ? `${options.outcomeLabel} complete with warnings` : `${options.outcomeLabel} complete`
  const outcomeStyle: CliColor = outcomeStatus === 'success' ? 'green' : outcomeStatus === 'warning' ? 'yellow' : 'red'
  lines.push(...statusLines(outcomeStatus, outcomeText, options, outcomeStyle))

  for (const notice of report.notices) {
    lines.push(...indentedProse(notice.message, '  ', options.columns))
  }

  if (report.notices.length > 0 && (hasFailures || report.skipped.length > 0 || reportActions(report).length > 0 || options.verbose)) lines.push('')

  for (const failure of report.failures) {
    lines.push(...statusLines('failure', failureTitle(failure), options))
    lines.push(...indentedProse(failure.message, '  ', options.columns))
  }
  for (const skipped of report.skipped) {
    lines.push(...statusLines('skipped', `${resultLabel(skipped.label)} skipped`, options))
    lines.push(...indentedProse(skipped.reason, '  ', options.columns))
  }
  for (const app of report.apps) {
    for (const warning of app.warnings) {
      lines.push(...statusLines('warning', warning.message, options))
    }
  }

  const actions = reportActions(report)
  if ((hasFailures || hasWarnings || report.skipped.length > 0) && actions.length > 0) lines.push('')
  if (actions.length > 0) {
    lines.push(styled(actions.length === 1 ? 'Next step' : 'Next steps', 'bold', options.color))
    for (const [index, entry] of actions.entries()) {
      const firstPrefix = actions.length === 1 ? '' : `  ${index + 1}. `
      const continuationPrefix = ' '.repeat(visibleLength(firstPrefix) + (actions.length === 1 ? 2 : 0))
      const valueIndent = actions.length === 1 ? '  ' : '    '
      lines.push(...actionLines(
        entry.action,
        firstPrefix,
        continuationPrefix,
        valueIndent,
        options.interactive,
        options.columns,
        options.color
      ))
    }
  }

  const details = [
    ...(report.ssh === undefined ? [] : detailLines(report.ssh.details, options.verbose, options.columns)),
    ...report.apps.flatMap((app) => detailLines(app.details, options.verbose, options.columns))
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
  const railWidth = options.progress?.mode === 'interactive' ? visibleLength('│  ') : 0
  const formatted = formatRemoteAccessInstallReport(report, {
    outcomeLabel: options.outcomeLabel,
    interactive,
    columns: Math.max(1, (output.columns ?? 80) - railWidth),
    verbose: options.verbose,
    color
  })

  if (options.progress !== undefined) {
    options.progress.appendResult(formatted.trimEnd().split('\n'), { color })
    return
  }

  output.write(formatted)
}
