import { runBuffered, type BufferedCommandOptions, type CommandResult } from './process.ts'
import { color, formatPromptEnd, formatPromptTitle, promptRail, selectedMark } from './cli-style.ts'

export type ProgressOutputTarget = 'stdout' | 'stderr'
export type ProgressWriter = (target: ProgressOutputTarget, message: string) => void
export type ProgressRawWriter = (target: ProgressOutputTarget, message: string) => void

export interface ProgressReporterOptions {
  verbose?: boolean
  target?: ProgressOutputTarget
  write?: ProgressWriter
  writeRaw?: ProgressRawWriter
  isTTY?: boolean
  spinnerFrames?: readonly string[]
  spinnerIntervalMs?: number
}

export interface ProgressCommandOptions extends Pick<BufferedCommandOptions, 'cwd' | 'env' | 'input'> {
  progress?: ProgressReporter
  verboseStdout?: ProgressOutputTarget | false
  verboseStderr?: ProgressOutputTarget | false
  spinnerLabel?: string
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

function normalizeMessage (message: string): string {
  return message.trim().replace(/\s+/g, ' ')
}

export class ProgressReporter {
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

  constructor (options: ProgressReporterOptions = {}) {
    this.verbose = options.verbose ?? false
    this.target = options.target ?? 'stdout'
    this.#write = options.write ?? writeLine
    this.#writeRaw = options.writeRaw ?? writeRaw
    this.#isTTY = options.isTTY ?? targetIsTTY(this.target)
    this.#spinnerFrames = options.spinnerFrames ?? DEFAULT_SPINNER_FRAMES
    this.#spinnerIntervalMs = options.spinnerIntervalMs ?? DEFAULT_SPINNER_INTERVAL_MS
  }

  section (title: string): void {
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

    if (!this.#sectionOpen) {
      return
    }

    this.#write(this.target, formatPromptEnd())
    this.#sectionOpen = false
  }

  item (message: string): void {
    this.#writeLine(`${promptRail()}  ${selectedMark()} ${message}`)
  }

  detail (message: string): void {
    this.#writeLine(`${promptRail()}  ${color(message, 'dim')}`)
  }

  warn (message: string): void {
    this.#writeLine(`${promptRail()}  ${color('!', 'dim')} ${message}`)
  }

  marker (message: string): void {
    const normalized = normalizeMessage(message)

    if (normalized.length > 0) {
      this.item(normalized)
    }
  }

  startSpinner (message: string): void {
    if (this.verbose) {
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
      BOXDOWN_PROGRESS: this.verbose ? '0' : '1'
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

  if (progress !== undefined && !verbose && options.spinnerLabel !== undefined) {
    progress.startSpinner(options.spinnerLabel)
  }

  try {
    const result = await runBuffered(command, args, {
      cwd: options.cwd,
      env: progress?.commandEnv(options.env) ?? options.env,
      input: options.input,
      mirrorStdout: verbose ? (options.verboseStdout ?? 'stdout') : false,
      mirrorStderr: verbose ? (options.verboseStderr ?? 'stderr') : false,
      onStdout: markerSink?.write,
      onStderr: markerSink?.write
    })

    markerSink?.flush()
    progress?.stopSpinner(result.code === 0 ? 'complete' : 'clear')
    return result
  } catch (error) {
    markerSink?.flush()
    progress?.stopSpinner()
    throw error
  }
}

export function assertProgressCommandSucceeded (label: string, result: CommandResult, message: string): void {
  if (result.code !== 0) {
    throw new Error(`${message}\n${formatCommandFailure(label, result)}`)
  }
}
