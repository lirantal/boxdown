import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { BOXDOWN_SECRET_ENV_NAMES } from './constants.ts'
import type { WorkspaceContext } from './paths.ts'

export type LogStreamName = 'stdout' | 'stderr' | 'boxdown'

export interface WorkspaceCommandLoggerOptions {
  redactions?: string[]
  now?: () => Date
}

export interface LoggedCommand {
  stream: (stream: Extract<LogStreamName, 'stdout' | 'stderr'>, chunk: Buffer | string) => void
  error: (error: unknown) => void
  finish: (code: number) => void
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function argvText (command: string, args: string[]): string {
  return JSON.stringify([command, ...args])
}

function escapeRegExp (value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export function redactKnownSecretEnvironmentAssignments (value: string): string {
  return BOXDOWN_SECRET_ENV_NAMES.reduce((current, name) => current.replace(
    new RegExp(`${escapeRegExp(name)}=[^\\s,"\\]}]+`, 'gu'),
    `${name}=[redacted]`
  ), value)
}

export class WorkspaceCommandLogger {
  readonly logPath: string
  readonly workspaceFolder: string
  readonly #redactions: string[]
  readonly #now: () => Date
  #disabled = false

  constructor (context: Pick<WorkspaceContext, 'workspaceFolder' | 'workspaceLogPath'>, options: WorkspaceCommandLoggerOptions = {}) {
    this.logPath = context.workspaceLogPath
    this.workspaceFolder = context.workspaceFolder
    this.#redactions = options.redactions?.filter((value) => value.length > 0) ?? []
    this.#now = options.now ?? (() => new Date())
  }

  addRedaction (value: string): void {
    if (value.length > 0) {
      this.#redactions.push(value)
    }
  }

  disable (): void {
    this.#disabled = true
  }

  section (title: string, details: Record<string, string | number | boolean | undefined> = {}): void {
    this.#append([
      '',
      `${this.#timestamp()} === ${this.#redact(title)} ===`,
      `${this.#timestamp()} workspace: ${this.#redact(this.workspaceFolder)}`,
      ...Object.entries(details)
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
        .map(([key, value]) => `${this.#timestamp()} ${key}: ${this.#redact(String(value))}`)
    ])
  }

  boxdown (chunk: Buffer | string): void {
    this.#stream('boxdown', chunk)
  }

  startCommand (command: string, args: string[], options: { cwd?: string } = {}): LoggedCommand {
    const startedAt = Date.now()

    this.#append([
      `${this.#timestamp()} command start: ${this.#redact(argvText(command, args))}`,
      ...(options.cwd === undefined ? [] : [`${this.#timestamp()} cwd: ${this.#redact(options.cwd)}`])
    ])

    return {
      stream: (stream, chunk) => {
        this.#stream(stream, chunk)
      },
      error: (error) => {
        this.#append([`${this.#timestamp()} command error: ${this.#redact(errorMessage(error))}`])
      },
      finish: (code) => {
        this.#append([`${this.#timestamp()} command exit: ${code} (${Date.now() - startedAt}ms)`])
      }
    }
  }

  #timestamp (): string {
    return `[${this.#now().toISOString()}]`
  }

  #redact (value: string): string {
    return this.#redactions.reduce(
      (current, redaction) => current.replaceAll(redaction, '[redacted]'),
      redactKnownSecretEnvironmentAssignments(value)
    )
  }

  #stream (stream: LogStreamName, chunk: Buffer | string): void {
    const text = this.#redact(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    const lines = text.split(/\r?\n/u)

    if (lines.at(-1) === '') {
      lines.pop()
    }

    if (lines.length === 0) {
      return
    }

    this.#append(lines.map((line) => `${this.#timestamp()} [${stream}] ${line}`))
  }

  #append (lines: string[]): void {
    if (this.#disabled) {
      return
    }

    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
      appendFileSync(this.logPath, `${lines.join('\n')}\n`)
    } catch {
      this.#disabled = true
    }
  }
}

export function createWorkspaceCommandLogger (
  context: Pick<WorkspaceContext, 'workspaceFolder' | 'workspaceLogPath'>,
  options: WorkspaceCommandLoggerOptions = {}
): WorkspaceCommandLogger {
  return new WorkspaceCommandLogger(context, options)
}

export async function withLoggedProcessOutput<T> (
  logger: WorkspaceCommandLogger,
  action: () => Promise<T>
): Promise<T> {
  const stdoutWrite = process.stdout.write
  const stderrWrite = process.stderr.write

  process.stdout.write = function patchedStdoutWrite (this: typeof process.stdout, chunk: string | Uint8Array, ...args: unknown[]): boolean {
    logger.boxdown(Buffer.isBuffer(chunk) ? chunk : String(chunk))
    return stdoutWrite.call(this, chunk, ...args as []) as boolean
  } as typeof process.stdout.write

  process.stderr.write = function patchedStderrWrite (this: typeof process.stderr, chunk: string | Uint8Array, ...args: unknown[]): boolean {
    logger.boxdown(Buffer.isBuffer(chunk) ? chunk : String(chunk))
    return stderrWrite.call(this, chunk, ...args as []) as boolean
  } as typeof process.stderr.write

  try {
    return await action()
  } finally {
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
  }
}
