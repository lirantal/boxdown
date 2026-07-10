import { runBuffered, type BufferedCommandOptions, type CommandResult } from './process.ts'
import { color, formatPromptEnd, formatPromptTitle, promptRail, selectedMark } from './cli-style.ts'

export type ProgressOutputTarget = 'stdout' | 'stderr'
export type ProgressMode = 'interactive' | 'verbose' | 'none'
export type ProgressWriter = (target: ProgressOutputTarget, message: string) => void
export type ProgressRawWriter = (target: ProgressOutputTarget, message: string) => void

export interface ProgressReporterOptions {
  mode?: ProgressMode
  verbose?: boolean
  target?: ProgressOutputTarget
  write?: ProgressWriter
  writeRaw?: ProgressRawWriter
  isTTY?: boolean
  spinnerFrames?: readonly string[]
  spinnerIntervalMs?: number
}

export interface ProgressCommandOptions extends Pick<BufferedCommandOptions, 'cwd' | 'env' | 'input'> {
  logger?: BufferedCommandOptions['logger']
  progress?: ProgressReporter
  verboseStdout?: ProgressOutputTarget | false
  verboseStderr?: ProgressOutputTarget | false
  spinnerLabel?: string
  stepId?: string
}

export interface ResolveProgressModeOptions {
  verbose?: boolean
  json?: boolean
  target?: ProgressOutputTarget
  env?: NodeJS.ProcessEnv
  isTTY?: boolean
}

export type ProgressStepState = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'

export interface ProgressStepDefinition {
  id: string
  label: string
}

const PROGRESS_MARKER_PREFIX = 'BOXDOWN_PROGRESS:'
const DEFAULT_FAILURE_TAIL_LINES = 20
const DEFAULT_SPINNER_FRAMES = ['◒', '◐', '◓', '◑'] as const
const DEFAULT_SPINNER_INTERVAL_MS = 120

interface ActiveSpinner {
  message: string
  frameIndex: number
  timer?: ReturnType<typeof setInterval>
  tty: boolean
}

interface ProgressStep extends ProgressStepDefinition {
  state: ProgressStepState
}

function writeLine (target: ProgressOutputTarget, message: string): void {
  const stream = target === 'stderr' ? process.stderr : process.stdout
  stream.write(`${message}\n`)
}

function writeRaw (target: ProgressOutputTarget, message: string): void {
  const stream = target === 'stderr' ? process.stderr : process.stdout
  stream.write(message)
}

function targetIsTTY (target: ProgressOutputTarget): boolean {
  const stream = target === 'stderr' ? process.stderr : process.stdout
  return stream.isTTY === true
}

function isCiEnvironment (env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI
  return ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false'
}

function normalizeMessage (message: string): string {
  return message.trim().replace(/\s+/g, ' ')
}

export function resolveProgressMode (options: ResolveProgressModeOptions = {}): ProgressMode {
  if (options.json === true) {
    return 'none'
  }

  if (options.verbose === true) {
    return 'verbose'
  }

  if (isCiEnvironment(options.env ?? process.env)) {
    return 'verbose'
  }

  const target = options.target ?? 'stdout'
  const isTTY = options.isTTY ?? targetIsTTY(target)

  return isTTY ? 'interactive' : 'verbose'
}

export class ProgressReporter {
  readonly mode: ProgressMode
  readonly verbose: boolean
  readonly target: ProgressOutputTarget
  readonly #write: ProgressWriter
  readonly #writeRaw: ProgressRawWriter
  readonly #isTTY: boolean
  readonly #spinnerFrames: readonly string[]
  readonly #spinnerIntervalMs: number
  #sectionPrinted = false
  #sectionOpen = false
  #spinner: ActiveSpinner | undefined
  #steps: ProgressStep[] = []
  #renderedStepLineCount = 0
  #stepFrameIndex = 0
  #stepTimer: ReturnType<typeof setInterval> | undefined

  constructor (options: ProgressReporterOptions = {}) {
    this.mode = options.mode ?? (options.verbose === true ? 'verbose' : 'interactive')
    this.verbose = this.mode === 'verbose'
    this.target = options.target ?? 'stdout'
    this.#write = options.write ?? writeLine
    this.#writeRaw = options.writeRaw ?? writeRaw
    this.#isTTY = options.isTTY ?? targetIsTTY(this.target)
    this.#spinnerFrames = options.spinnerFrames ?? DEFAULT_SPINNER_FRAMES
    this.#spinnerIntervalMs = options.spinnerIntervalMs ?? DEFAULT_SPINNER_INTERVAL_MS
  }

  section (title: string): void {
    if (this.mode !== 'interactive') {
      return
    }

    if (this.#sectionOpen) {
      this.end()
    } else if (this.#sectionPrinted) {
      this.#write(this.target, '')
    }

    this.#write(this.target, formatPromptTitle(title))
    this.#sectionPrinted = true
    this.#sectionOpen = true
  }

  end (): void {
    this.stopSpinner()
    this.#stopStepTimer()

    if (this.mode !== 'interactive') {
      return
    }

    if (!this.#sectionOpen) {
      return
    }

    this.#write(this.target, formatPromptEnd())
    this.#sectionOpen = false
    this.#steps = []
    this.#renderedStepLineCount = 0
  }

  item (message: string): void {
    if (this.mode !== 'interactive') {
      return
    }

    this.#writeLine(`${promptRail()}  ${selectedMark()} ${message}`)
  }

  detail (message: string): void {
    if (this.mode !== 'interactive') {
      return
    }

    this.#writeLine(`${promptRail()}  ${color(message, 'dim')}`)
  }

  warn (message: string): void {
    if (this.mode === 'none') {
      return
    }

    if (this.mode === 'verbose') {
      this.#write(this.target, `Warning: ${message}`)
      return
    }

    this.#writeLine(`${promptRail()}  ${color('!', 'dim')} ${message}`)
  }

  marker (message: string): void {
    if (this.#steps.length > 0) {
      return
    }

    const normalized = normalizeMessage(message)

    if (normalized.length > 0) {
      this.item(normalized)
    }
  }

  setSteps (steps: readonly ProgressStepDefinition[]): void {
    this.#stopStepTimer()
    this.#steps = steps.map((step) => ({
      ...step,
      state: 'pending'
    }))
    this.#stepFrameIndex = 0
    this.#renderedStepLineCount = 0
    this.#renderChecklist()
  }

  isChecklistActive (): boolean {
    return this.#steps.length > 0
  }

  startStep (id: string): void {
    this.#updateStep(id, 'running')
    this.#startStepTimer()
  }

  completeStep (id: string): void {
    this.#updateStep(id, 'complete')
    this.#stopStepTimerIfIdle()
  }

  failStep (id: string): void {
    this.#updateStep(id, 'failed')
    this.#stopStepTimerIfIdle()
  }

  skipStep (id: string): void {
    this.#updateStep(id, 'skipped')
    this.#stopStepTimerIfIdle()
  }

  hasStep (id: string): boolean {
    return this.#steps.some((step) => step.id === id)
  }

  startSpinner (message: string): void {
    if (this.mode !== 'interactive') {
      return
    }

    const normalized = normalizeMessage(message)
    if (normalized.length === 0) {
      return
    }

    this.stopSpinner()
    this.#spinner = {
      message: normalized,
      frameIndex: 0,
      tty: this.#isTTY
    }

    if (this.#spinner.tty) {
      this.#renderSpinner()
      this.#spinner.timer = setInterval(() => {
        this.tickSpinner()
      }, this.#spinnerIntervalMs)
      this.#spinner.timer.unref?.()
      return
    }

    this.#writeLine(`${promptRail()}  ${color(this.#spinnerFrames[0] ?? '◒', 'cyan')} ${normalized}`)
  }

  tickSpinner (): void {
    if (this.#steps.some((step) => step.state === 'running')) {
      this.#stepFrameIndex += 1
      this.#renderChecklist()
      return
    }

    const spinner = this.#spinner
    if (spinner === undefined || !spinner.tty) {
      return
    }

    spinner.frameIndex += 1
    this.#renderSpinner()
  }

  stopSpinner (status: 'complete' | 'clear' = 'clear'): void {
    const spinner = this.#spinner
    if (spinner === undefined) {
      return
    }

    if (spinner.timer !== undefined) {
      clearInterval(spinner.timer)
    }

    if (spinner.tty) {
      this.#clearSpinnerLine()
    }

    this.#spinner = undefined

    if (status === 'complete') {
      this.item(spinner.message)
    }
  }

  commandEnv (env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      ...(env ?? {}),
      BOXDOWN_VERBOSE: this.verbose ? '1' : '0',
      BOXDOWN_PROGRESS: this.mode === 'interactive' ? '1' : '0'
    }
  }

  #writeLine (message: string): void {
    const spinner = this.#spinner

    if (spinner !== undefined && spinner.tty) {
      this.#clearSpinnerLine()
      this.#write(this.target, message)
      this.#renderSpinner()
      return
    }

    this.#write(this.target, message)
  }

  #renderSpinner (): void {
    const spinner = this.#spinner
    if (spinner === undefined) {
      return
    }

    const frame = this.#spinnerFrames[spinner.frameIndex % this.#spinnerFrames.length] ?? '◒'
    this.#writeRaw(this.target, `\r\u001B[2K${promptRail()}  ${color(frame, 'cyan')} ${spinner.message}`)
  }

  #clearSpinnerLine (): void {
    this.#writeRaw(this.target, '\r\u001B[2K')
  }

  #updateStep (id: string, state: ProgressStepState): void {
    const index = this.#steps.findIndex((step) => step.id === id)

    if (index === -1) {
      return
    }

    const step = this.#steps[index]
    if (step === undefined) {
      return
    }

    this.#steps[index] = {
      ...step,
      state
    }

    this.#renderChecklist()
  }

  #renderChecklist (): void {
    if (this.mode !== 'interactive' || this.#steps.length === 0) {
      return
    }

    const lines = this.#steps.map((step) => this.#formatStep(step))

    if (this.#isTTY) {
      if (this.#renderedStepLineCount > 0) {
        this.#writeRaw(this.target, `\u001B[${this.#renderedStepLineCount}A`)
      }

      for (const line of lines) {
        this.#writeRaw(this.target, `\u001B[2K\r${line}\n`)
      }

      this.#renderedStepLineCount = lines.length
      return
    }

    if (this.#renderedStepLineCount === 0) {
      for (const line of lines) {
        this.#write(this.target, line)
      }
      this.#renderedStepLineCount = lines.length
    }
  }

  #formatStep (step: ProgressStep): string {
    const label = step.state === 'skipped' ? color(step.label, 'dim') : step.label
    return `${promptRail()}  ${this.#stepMark(step.state)} ${label}`
  }

  #stepMark (state: ProgressStepState): string {
    if (state === 'running') {
      const frame = this.#spinnerFrames[this.#stepFrameIndex % this.#spinnerFrames.length] ?? '◐'
      return color(frame, 'cyan')
    }

    if (state === 'complete') {
      return color('✔', 'green')
    }

    if (state === 'failed') {
      return color('!', 'dim')
    }

    return color('□', 'dim')
  }

  #startStepTimer (): void {
    if (this.mode !== 'interactive' || !this.#isTTY || this.#stepTimer !== undefined) {
      return
    }

    this.#stepTimer = setInterval(() => {
      this.tickSpinner()
    }, this.#spinnerIntervalMs)
    this.#stepTimer.unref?.()
  }

  #stopStepTimerIfIdle (): void {
    if (this.#steps.some((step) => step.state === 'running')) {
      return
    }

    this.#stopStepTimer()
  }

  #stopStepTimer (): void {
    if (this.#stepTimer === undefined) {
      return
    }

    clearInterval(this.#stepTimer)
    this.#stepTimer = undefined
  }
}

export function createProgress (options: ProgressReporterOptions = {}): ProgressReporter {
  return new ProgressReporter(options)
}

export function progressMarkerLine (message: string): string {
  return `${PROGRESS_MARKER_PREFIX} ${message}`
}

function isProgressMarkerLine (line: string): boolean {
  return line.trimStart().startsWith(PROGRESS_MARKER_PREFIX)
}

function progressMarkerMessage (line: string): string | undefined {
  const trimmed = line.trimStart()

  if (!trimmed.startsWith(PROGRESS_MARKER_PREFIX)) {
    return undefined
  }

  return trimmed.slice(PROGRESS_MARKER_PREFIX.length).trim()
}

function createMarkerSink (progress: ProgressReporter): {
  write: (chunk: Buffer) => void
  flush: () => void
} {
  let pending = ''

  function processLine (line: string): void {
    const message = progressMarkerMessage(line)

    if (message !== undefined) {
      progress.marker(message)
    }
  }

  return {
    write: (chunk: Buffer) => {
      pending += chunk.toString('utf8')

      const lines = pending.split(/\r?\n/u)
      pending = lines.pop() ?? ''

      for (const line of lines) {
        processLine(line)
      }
    },
    flush: () => {
      if (pending.length > 0) {
        processLine(pending)
        pending = ''
      }
    }
  }
}

function outputWithoutProgressMarkers (output: string): string {
  return output
    .split(/\r?\n/u)
    .filter((line) => !isProgressMarkerLine(line))
    .join('\n')
}

function tailLines (output: string, maxLines: number): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-maxLines)
}

export function formatCommandFailure (label: string, result: CommandResult, options: { tailLines?: number } = {}): string {
  const maxLines = options.tailLines ?? DEFAULT_FAILURE_TAIL_LINES
  const stderrTail = tailLines(outputWithoutProgressMarkers(result.stderr), maxLines)
  const stdoutTail = tailLines(outputWithoutProgressMarkers(result.stdout), Math.max(0, maxLines - stderrTail.length))
  const lines = [
    `${label} failed with exit code ${result.code}.`,
    'Rerun with --verbose to see full command output.'
  ]

  if (stderrTail.length > 0) {
    lines.push('', 'stderr tail:', ...stderrTail.map((line) => `  ${line}`))
  }

  if (stdoutTail.length > 0) {
    lines.push('', 'stdout tail:', ...stdoutTail.map((line) => `  ${line}`))
  }

  return lines.join('\n')
}

export async function runProgressCommand (
  label: string,
  command: string,
  args: string[],
  options: ProgressCommandOptions = {}
): Promise<CommandResult> {
  const progress = options.progress
  const verbose = progress?.verbose ?? true
  const markerSink = progress !== undefined && !verbose ? createMarkerSink(progress) : undefined
  const checklistStepId = progress !== undefined && options.stepId !== undefined && progress.hasStep(options.stepId)
    ? options.stepId
    : undefined

  if (progress !== undefined && !verbose && checklistStepId !== undefined) {
    progress.startStep(checklistStepId)
  } else if (progress !== undefined && !verbose && options.spinnerLabel !== undefined) {
    progress.startSpinner(options.spinnerLabel)
  }

  try {
    const result = await runBuffered(command, args, {
      cwd: options.cwd,
      env: progress?.commandEnv(options.env) ?? options.env,
      input: options.input,
      logger: options.logger,
      mirrorStdout: verbose ? (options.verboseStdout ?? 'stdout') : false,
      mirrorStderr: verbose ? (options.verboseStderr ?? 'stderr') : false,
      onStdout: markerSink?.write,
      onStderr: markerSink?.write
    })

    markerSink?.flush()
    if (checklistStepId !== undefined) {
      if (result.code === 0) {
        progress?.completeStep(checklistStepId)
      } else {
        progress?.failStep(checklistStepId)
      }
    } else {
      progress?.stopSpinner(result.code === 0 ? 'complete' : 'clear')
    }
    return result
  } catch (error) {
    markerSink?.flush()
    if (checklistStepId !== undefined) {
      progress?.failStep(checklistStepId)
    } else {
      progress?.stopSpinner()
    }
    throw error
  }
}

export function assertProgressCommandSucceeded (label: string, result: CommandResult, message: string): void {
  if (result.code !== 0) {
    throw new Error(`${message}\n${formatCommandFailure(label, result)}`)
  }
}
