import { existsSync } from 'node:fs'

import { resolveDevcontainerCli } from './devcontainer-cli.ts'
import type { WorkspaceContext } from './paths.ts'
import { runBuffered } from './process.ts'

export type DoctorLevel = 'ok' | 'fail' | 'warn'

export interface DoctorCheck {
  name: string
  level: DoctorLevel
  message: string
}

function nodeVersionPasses (version: string): boolean {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isInteger(major) && major >= 24
}

function check (name: string, pass: boolean, okMessage: string, failMessage: string): DoctorCheck {
  return {
    name,
    level: pass ? 'ok' : 'fail',
    message: pass ? okMessage : failMessage
  }
}

async function commandWorks (command: string, args: string[]): Promise<boolean> {
  const result = await runBuffered(command, args, {
    mirrorStdout: false,
    mirrorStderr: false
  })

  return result.code === 0
}

async function commandExists (command: string, args: string[]): Promise<boolean> {
  const result = await runBuffered(command, args, {
    mirrorStdout: false,
    mirrorStderr: false
  })

  return result.code !== 127
}

export async function runDoctorChecks (context: WorkspaceContext): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const nodeVersion = process.versions.node

  checks.push(check(
    'node',
    nodeVersionPasses(nodeVersion),
    `Node ${nodeVersion}`,
    `Node ${nodeVersion}; expected >=24.0.0`
  ))

  checks.push(check(
    'devcontainers-cli',
    await packagedDevcontainerCliWorks(context),
    'Packaged @devcontainers/cli is available',
    'Packaged @devcontainers/cli is required but was not available'
  ))

  checks.push(check(
    'docker-cli',
    await commandWorks('docker', ['--version']),
    'Docker CLI is available',
    'Docker CLI is required but was not available'
  ))

  checks.push(check(
    'docker-daemon',
    await commandWorks('docker', ['info']),
    'Docker daemon is reachable',
    'Docker daemon is required but was not reachable'
  ))

  checks.push(check(
    'ssh',
    await commandExists('ssh', ['-V']),
    'ssh is available',
    'ssh is required but was not available'
  ))

  checks.push(check(
    'ssh-keygen',
    await commandExists('ssh-keygen', ['-?']),
    'ssh-keygen is available',
    'ssh-keygen is required but was not available'
  ))

  checks.push(check(
    'assets',
    existsSync(context.assetsDevcontainerDir),
    `Devcontainer assets found at ${context.assetsDevcontainerDir}`,
    `Missing Boxdown devcontainer assets: ${context.assetsDevcontainerDir}`
  ))

  if (await commandWorks('gh', ['--version'])) {
    const ghAuth = await commandWorks('gh', ['auth', 'status', '--hostname', 'github.com'])
    checks.push({
      name: 'gh-auth',
      level: ghAuth ? 'ok' : 'warn',
      message: ghAuth ? 'GitHub CLI auth is available' : 'GitHub CLI is available but not authenticated'
    })
  } else {
    checks.push({
      name: 'gh',
      level: 'warn',
      message: 'GitHub CLI is optional and was not available'
    })
  }

  return checks
}

async function packagedDevcontainerCliWorks (context: WorkspaceContext): Promise<boolean> {
  try {
    const cli = resolveDevcontainerCli(context)
    return await commandWorks(cli.command, [...cli.argsPrefix, '--version'])
  } catch {
    return false
  }
}

export function doctorHasFailures (checks: DoctorCheck[]): boolean {
  return checks.some((item) => item.level === 'fail')
}

export function formatDoctorText (checks: DoctorCheck[]): string {
  const lines = ['Boxdown doctor', '']

  for (const item of checks) {
    lines.push(`[${item.level}] ${item.name}: ${item.message}`)
  }

  lines.push('', doctorHasFailures(checks) ? 'Result: failed' : 'Result: ok')
  return `${lines.join('\n')}\n`
}
