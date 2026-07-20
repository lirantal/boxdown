import { spawn } from 'node:child_process'
import { delimiter } from 'node:path'

import type { WorkspaceCommandLogger } from './logging.ts'

export interface BufferedCommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  mirrorStdout?: 'stdout' | 'stderr' | false
  mirrorStderr?: 'stdout' | 'stderr' | false
  logger?: WorkspaceCommandLogger
  onStdout?: (chunk: Buffer) => void
  onStderr?: (chunk: Buffer) => void
  timeoutMs?: number
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

function mergedEnv (env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const baseEnv = {
    ...process.env,
    ...(env ?? {})
  }

  return {
    ...baseEnv,
    PATH: buildHostToolPath(baseEnv)
  }
}

function uniquePathEntries (entries: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const entry of entries) {
    if (entry.length === 0 || seen.has(entry)) {
      continue
    }

    seen.add(entry)
    result.push(entry)
  }

  return result
}

export function buildHostToolPath (env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME
  const existingPath = env.PATH ?? ''
  const configuredPrefix = env.BOXDOWN_HOST_PATH_PREFIX?.split(delimiter) ?? []
  const guiFriendlyPrefix = [
    ...(home === undefined ? [] : [
      `${home}/.local/bin`,
      `${home}/.docker/bin`
    ]),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/Applications/Docker.app/Contents/Resources/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]

  return uniquePathEntries([
    ...configuredPrefix,
    ...existingPath.split(delimiter),
    ...guiFriendlyPrefix
  ]).join(delimiter)
}

function writeChunk (target: 'stdout' | 'stderr' | false, chunk: Buffer): void {
  if (target === 'stdout') {
    process.stdout.write(chunk)
  } else if (target === 'stderr') {
    process.stderr.write(chunk)
  }
}

export function runBuffered (command: string, args: string[], options: BufferedCommandOptions = {}): Promise<CommandResult> {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
    throw new Error('timeoutMs must be a finite non-negative number')
  }

  return new Promise((resolve) => {
    const loggedCommand = options.logger?.startCommand(command, args, { cwd: options.cwd })
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: mergedEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      stdoutChunks.push(chunk)
      loggedCommand?.stream('stdout', chunk)
      options.onStdout?.(chunk)
      writeChunk(options.mirrorStdout ?? 'stdout', chunk)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return
      stderrChunks.push(chunk)
      loggedCommand?.stream('stderr', chunk)
      options.onStderr?.(chunk)
      writeChunk(options.mirrorStderr ?? 'stderr', chunk)
    })

    child.on('error', (error) => {
      if (settled) return

      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      loggedCommand?.error(error)
      loggedCommand?.finish(127)
      resolve({
        code: 127,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `${Buffer.concat(stderrChunks).toString('utf8')}${error.message}\n`
      })
    })

    child.on('close', (code) => {
      if (settled) return

      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      loggedCommand?.finish(code ?? 1)
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      })
    })

    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        if (settled) return

        settled = true
        const message = `Command timed out after ${options.timeoutMs as number} milliseconds.`
        const stdout = Buffer.concat(stdoutChunks).toString('utf8')
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
        loggedCommand?.error(new Error(message))
        loggedCommand?.finish(124)
        child.kill('SIGKILL')
        resolve({
          code: 124,
          stdout,
          stderr: `${stderr}${stderr.length > 0 && !stderr.endsWith('\n') ? '\n' : ''}${message}\n`
        })
      }, options.timeoutMs)
    }

    if (options.input !== undefined) {
      child.stdin.end(options.input)
    } else {
      child.stdin.end()
    }
  })
}

export function runInteractive (command: string, args: string[], options: Pick<BufferedCommandOptions, 'cwd' | 'env' | 'logger'> = {}): Promise<number> {
  return new Promise((resolve) => {
    const loggedCommand = options.logger?.startCommand(command, args, { cwd: options.cwd })
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: mergedEnv(options.env),
      stdio: 'inherit'
    })

    child.on('error', (error) => {
      loggedCommand?.error(error)
      loggedCommand?.finish(127)
      process.stderr.write(`${error.message}\n`)
      resolve(127)
    })

    child.on('close', (code) => {
      loggedCommand?.finish(code ?? 1)
      resolve(code ?? 1)
    })
  })
}
