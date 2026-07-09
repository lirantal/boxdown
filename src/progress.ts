import { runBuffered, type BufferedCommandOptions, type CommandResult } from './process.ts'

export type ProgressOutputTarget = 'stdout' | 'stderr'
export type ProgressWriter = (target: ProgressOutputTarget, message: string) => void

export interface ProgressReporterOptions {
  verbose?: boolean
  target?: ProgressOutputTarget
  write?: ProgressWriter
}

export interface ProgressCommandOptions extends Pick<BufferedCommandOptions, 'cwd' | 'env' | 'input'> {
  progress?: ProgressReporter
  verboseStdout?: ProgressOutputTarget | false
  verboseStderr?: ProgressOutputTarget | false
}

const PROGRESS_MARKER_PREFIX = 'BOXDOWN_PROGRESS:'
const DEFAULT_FAILURE_TAIL_LINES = 20

function writeLine (target: ProgressOutputTarget, message: string): void {
  const stream = target === 'stderr' ? process.stderr : process.stdout
  stream.write(`${message}\n`)
}

function normalizeMessage (message: string): string {
  return message.trim().replace(/\s+/g, ' ')
}

export class ProgressReporter {
  readonly verbose: boolean
  readonly target: ProgressOutputTarget
  readonly #write: ProgressWriter
  #sectionPrinted = false

  constructor (options: ProgressReporterOptions = {}) {
    this.verbose = options.verbose ?? false
    this.target = options.target ?? 'stdout'
    this.#write = options.write ?? writeLine
  }

  section (title: string): void {
    if (this.#sectionPrinted) {
      this.#write(this.target, '')
    }

    this.#write(this.target, title)
    this.#sectionPrinted = true
  }

  item (message: string): void {
    this.#write(this.target, `- ${message}`)
  }

  detail (message: string): void {
    this.#write(this.target, `  ${message}`)
  }

  warn (message: string): void {
    this.#write(this.target, `! ${message}`)
  }

  marker (message: string): void {
    const normalized = normalizeMessage(message)

    if (normalized.length > 0) {
      this.item(normalized)
    }
  }

  commandEnv (env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      ...(env ?? {}),
      BOXDOWN_VERBOSE: this.verbose ? '1' : '0',
      BOXDOWN_PROGRESS: this.verbose ? '0' : '1'
    }
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
  return result
}

export function assertProgressCommandSucceeded (label: string, result: CommandResult, message: string): void {
  if (result.code !== 0) {
    throw new Error(`${message}\n${formatCommandFailure(label, result)}`)
  }
}
