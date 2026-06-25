import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { WorkspaceContext } from './paths.ts'
import { shellQuote, sshConfigQuote } from './shell.ts'
import { ensureHostSshKey } from './ssh-key.ts'

export function defaultSshAlias (workspaceBasename: string): string {
  return `${workspaceBasename}-devcontainer`
}

export function validateSshAlias (alias: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(alias)) {
    throw new Error(`SSH alias contains unsupported characters: ${alias}`)
  }
}

export function defaultSshConfigPath (env: NodeJS.ProcessEnv = process.env): string {
  return env.BOXDOWN_SSH_CONFIG ?? env.DEVCONTAINER_SSH_CONFIG ?? join(env.HOME ?? '', '.ssh', 'config')
}

export function buildProxyCommand (context: WorkspaceContext, alias: string): string {
  const cliPath = join(context.packageRoot, 'dist', 'bin', 'cli.cjs')

  return `${shellQuote(process.execPath)} ${shellQuote(cliPath)} ssh-proxy --workspace ${shellQuote(context.workspaceFolder)} --alias ${shellQuote(alias)}`
}

export function buildSshConfigBlock (context: WorkspaceContext, alias: string): string {
  validateSshAlias(alias)

  return [
    `# BEGIN ${alias} boxdown devcontainer ssh`,
    `Host ${alias}`,
    `  HostName ${alias}`,
    '  User node',
    '  IdentityFile none',
    `  IdentityFile ${sshConfigQuote(context.sshKeyPath)}`,
    '  IdentitiesOnly yes',
    `  ProxyCommand ${buildProxyCommand(context, alias)}`,
    '  StrictHostKeyChecking no',
    '  UserKnownHostsFile /dev/null',
    '  LogLevel ERROR',
    `# END ${alias} boxdown devcontainer ssh`,
    ''
  ].join('\n')
}

export function replaceSshConfigBlock (existingConfig: string, alias: string, block: string): string {
  const begin = `# BEGIN ${alias} boxdown devcontainer ssh`
  const end = `# END ${alias} boxdown devcontainer ssh`
  const lines = existingConfig.split(/\r?\n/)
  const nextLines: string[] = []
  let skipping = false

  for (const line of lines) {
    if (line === begin) {
      skipping = true
      continue
    }

    if (line === end) {
      skipping = false
      continue
    }

    if (!skipping) {
      nextLines.push(line)
    }
  }

  while (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') {
    nextLines.pop()
  }

  return `${nextLines.join('\n')}${nextLines.length > 0 ? '\n\n' : ''}${block}`
}

export function removeSshConfigBlock (existingConfig: string, alias: string): string {
  const begin = `# BEGIN ${alias} boxdown devcontainer ssh`
  const end = `# END ${alias} boxdown devcontainer ssh`
  const lines = existingConfig.split(/\r?\n/)
  const nextLines: string[] = []
  let skipping = false
  let removed = false

  for (const line of lines) {
    if (line === begin) {
      skipping = true
      removed = true
      continue
    }

    if (line === end && skipping) {
      skipping = false
      continue
    }

    if (!skipping) {
      nextLines.push(line)
    }
  }

  if (!removed) {
    return existingConfig
  }

  while (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') {
    nextLines.pop()
  }

  return nextLines.length > 0 ? `${nextLines.join('\n')}\n` : ''
}

export async function installSshConfig (context: WorkspaceContext, alias: string, options: { quiet?: boolean, configPath?: string } = {}): Promise<void> {
  validateSshAlias(alias)
  await ensureHostSshKey(context, options.quiet ?? false)

  const sshConfigPath = options.configPath ?? defaultSshConfigPath()
  const sshConfigDir = dirname(sshConfigPath)
  mkdirSync(sshConfigDir, { recursive: true, mode: 0o700 })

  if (!existsSync(sshConfigPath)) {
    writeFileSync(sshConfigPath, '')
  }

  chmodSync(sshConfigDir, 0o700)
  chmodSync(sshConfigPath, 0o600)

  const existingConfig = readFileSync(sshConfigPath, 'utf8')
  const block = buildSshConfigBlock(context, alias)
  const nextConfig = replaceSshConfigBlock(existingConfig, alias, block)

  if (nextConfig !== existingConfig) {
    writeFileSync(sshConfigPath, nextConfig)
    if (!options.quiet) {
      process.stdout.write(`Installed SSH alias: ${alias}\n`)
    }
  } else if (!options.quiet) {
    process.stdout.write(`SSH alias already up to date: ${alias}\n`)
  }

  chmodSync(sshConfigPath, 0o600)

  if (!options.quiet) {
    process.stdout.write(`SSH config: ${sshConfigPath}\n`)
    process.stdout.write(`Identity file: ${context.sshKeyPath}\n\n`)
    process.stdout.write(`Validate with:\n  ssh ${alias} 'whoami && pwd'\n`)
  }
}

export function uninstallSshConfig (alias: string, options: { quiet?: boolean, configPath?: string } = {}): boolean {
  validateSshAlias(alias)

  const sshConfigPath = options.configPath ?? defaultSshConfigPath()

  if (!existsSync(sshConfigPath)) {
    if (!options.quiet) {
      process.stdout.write(`SSH alias not installed: ${alias}\n`)
      process.stdout.write(`SSH config: ${sshConfigPath}\n`)
    }

    return false
  }

  const existingConfig = readFileSync(sshConfigPath, 'utf8')
  const nextConfig = removeSshConfigBlock(existingConfig, alias)
  const changed = nextConfig !== existingConfig

  if (changed) {
    writeFileSync(sshConfigPath, nextConfig)
    chmodSync(sshConfigPath, 0o600)
  }

  if (!options.quiet) {
    process.stdout.write(changed
      ? `Uninstalled SSH alias: ${alias}\n`
      : `SSH alias not installed: ${alias}\n`)
    process.stdout.write(`SSH config: ${sshConfigPath}\n`)
  }

  return changed
}
