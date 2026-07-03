import { spawn } from 'node:child_process'
import { delimiter } from 'node:path'

export interface BufferedCommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  mirrorStdout?: 'stdout' | 'stderr' | false
  mirrorStderr?: 'stdout' | 'stderr' | false
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
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: mergedEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
      writeChunk(options.mirrorStdout ?? 'stdout', chunk)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
      writeChunk(options.mirrorStderr ?? 'stderr', chunk)
    })

    child.on('error', (error) => {
      resolve({
        code: 127,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `${Buffer.concat(stderrChunks).toString('utf8')}${error.message}\n`
      })
    })

    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      })
    })

    if (options.input !== undefined) {
      child.stdin.end(options.input)
    } else {
      child.stdin.end()
    }
  })
}

export function runInteractive (command: string, args: string[], options: Pick<BufferedCommandOptions, 'cwd' | 'env'> = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: mergedEnv(options.env),
      stdio: 'inherit'
    })

    child.on('error', (error) => {
      process.stderr.write(`${error.message}\n`)
      resolve(127)
    })

    child.on('close', (code) => {
      resolve(code ?? 1)
    })
  })
}
