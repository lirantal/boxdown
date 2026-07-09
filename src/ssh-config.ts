import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
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

interface SshConfigMarkerSet {
  begin: string
  end: string
}

function managedSshConfigMarkerSets (alias: string): SshConfigMarkerSet[] {
  return [
    {
      begin: `# BEGIN ${alias} boxdown devcontainer ssh`,
      end: `# END ${alias} boxdown devcontainer ssh`
    },
    {
      begin: `# BEGIN ${alias} devcontainer ssh`,
      end: `# END ${alias} devcontainer ssh`
    }
  ]
}

function malformedSshConfigBlockError (alias: string, markers: SshConfigMarkerSet): Error {
  return new Error(`Refusing to update SSH config for ${alias}: found "${markers.begin}" without matching "${markers.end}". Repair the config manually before running Boxdown again.`)
}

function stripManagedSshConfigBlocks (existingConfig: string, alias: string): { lines: string[], removed: boolean } {
  const markerSets = managedSshConfigMarkerSets(alias)
  const lines = existingConfig.split(/\r?\n/)
  const nextLines: string[] = []
  let removed = false

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const markers = markerSets.find((candidate) => candidate.begin === line)

    if (markers === undefined) {
      nextLines.push(line ?? '')
      continue
    }

    const endIndex = lines.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate === markers.end)

    if (endIndex === -1) {
      throw malformedSshConfigBlockError(alias, markers)
    }

    removed = true
    index = endIndex
  }

  return { lines: nextLines, removed }
}

function trimTrailingBlankLines (lines: string[]): void {
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
}

function writeFileAtomic (path: string, contents: string, mode: number): void {
  const destinationPath = existsSync(path) ? realpathSync(path) : path
  const tmpPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`

  writeFileSync(tmpPath, contents, { mode })
  chmodSync(tmpPath, mode)
  renameSync(tmpPath, destinationPath)
}

export function replaceSshConfigBlock (existingConfig: string, alias: string, block: string): string {
  const { lines: nextLines } = stripManagedSshConfigBlocks(existingConfig, alias)

  trimTrailingBlankLines(nextLines)

  return `${nextLines.join('\n')}${nextLines.length > 0 ? '\n\n' : ''}${block}`
}

export function removeSshConfigBlock (existingConfig: string, alias: string): string {
  const { lines: nextLines, removed } = stripManagedSshConfigBlocks(existingConfig, alias)

  if (!removed) {
    return existingConfig
  }

  trimTrailingBlankLines(nextLines)

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
    writeFileAtomic(sshConfigPath, nextConfig, 0o600)
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
    writeFileAtomic(sshConfigPath, nextConfig, 0o600)
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
