import { existsSync } from 'node:fs'

import { startDevcontainer, printPortHint, openShell, ensureContainerSshRuntime, runSshdProxy, refreshContainerGhAuth, findRunningContainerId } from './devcontainer.ts'
import { createWorkspaceContext } from './paths.ts'
import { defaultSshAlias, installSshConfig } from './ssh-config.ts'

export type BoxdownCommand =
  | 'help'
  | 'start'
  | 'ssh-config-install'
  | 'ssh-proxy'
  | 'refresh-gh-token'
  | 'refresh-gh-token-running'

export interface ParsedCli {
  command: BoxdownCommand
  workspace?: string
  alias?: string
  recreate: boolean
}

export const USAGE = `Usage:
  boxdown start [--workspace <path>] [--recreate]
  boxdown shell [--workspace <path>] [--recreate]
  boxdown ssh-config install [--workspace <path>] [--alias <name>]
  boxdown install-ssh-config [--workspace <path>] [--alias <name>]
  boxdown ssh-proxy [--workspace <path>] [--alias <name>]
  boxdown refresh-gh-token [--workspace <path>]
  boxdown refresh-gh-token-running [--workspace <path>]

Commands:
  start                     Start or reuse the workspace devcontainer, then open
                            an interactive shell inside it.
  shell                     Alias for start.
  ssh-config install        Install or update an SSH host alias for the workspace
                            devcontainer.
  install-ssh-config        Alias for ssh-config install.
  ssh-proxy                 Internal command used by the generated SSH
                            ProxyCommand. Starts or reuses the devcontainer and
                            bridges SSH over docker exec.
  refresh-gh-token          Start or reuse the devcontainer, then copy host
                            GitHub CLI auth into the container when available.
  refresh-gh-token-running  Refresh GitHub CLI auth only if the workspace
                            devcontainer is already running.

Options:
  --workspace <path>  Target project directory. Defaults to the current directory.
  --alias <name>      SSH host alias. Defaults to <repo-name>-devcontainer.
  --recreate          Remove the existing devcontainer before starting.
  --help, -h          Show help.
`

export function parseCliArgs (argv: string[]): ParsedCli {
  const args = [...argv]
  let workspace: string | undefined
  let alias: string | undefined
  let recreate = false
  const positional: string[] = []

  while (args.length > 0) {
    const arg = args.shift()

    if (arg === undefined) {
      break
    }

    if (arg === '--help' || arg === '-h') {
      return { command: 'help', workspace, alias, recreate }
    }

    if (arg === '--workspace') {
      const value = args.shift()
      if (value === undefined) {
        throw new Error('--workspace requires a value')
      }
      workspace = value
      continue
    }

    if (arg === '--alias') {
      const value = args.shift()
      if (value === undefined) {
        throw new Error('--alias requires a value')
      }
      alias = value
      continue
    }

    if (arg === '--recreate') {
      recreate = true
      continue
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }

    positional.push(arg)
  }

  if (positional.length === 0) {
    return { command: 'help', workspace, alias, recreate }
  }

  if (positional[0] === 'start' || positional[0] === 'shell') {
    return { command: 'start', workspace, alias, recreate }
  }

  if (positional[0] === 'ssh-config' && positional[1] === 'install' && positional.length === 2) {
    return { command: 'ssh-config-install', workspace, alias, recreate }
  }

  if (positional[0] === 'install-ssh-config' && positional.length === 1) {
    return { command: 'ssh-config-install', workspace, alias, recreate }
  }

  if (positional[0] === 'ssh-proxy' && positional.length === 1) {
    return { command: 'ssh-proxy', workspace, alias, recreate }
  }

  if (positional[0] === 'refresh-gh-token' && positional.length === 1) {
    return { command: 'refresh-gh-token', workspace, alias, recreate }
  }

  if (positional[0] === 'refresh-gh-token-running' && positional.length === 1) {
    return { command: 'refresh-gh-token-running', workspace, alias, recreate }
  }

  throw new Error(`Unknown command: ${positional.join(' ')}`)
}

export async function runCli (argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseCliArgs(argv)

    if (parsed.command === 'help') {
      process.stdout.write(USAGE)
      return 0
    }

    const context = createWorkspaceContext({ workspace: parsed.workspace })
    const alias = parsed.alias ?? defaultSshAlias(context.workspaceBasename)

    if (!existsSync(context.assetsDevcontainerDir)) {
      throw new Error(`Missing Boxdown devcontainer assets: ${context.assetsDevcontainerDir}`)
    }

    if (parsed.command === 'ssh-config-install') {
      await installSshConfig(context, alias)
      return 0
    }

    if (parsed.command === 'ssh-proxy') {
      await installSshConfig(context, alias, { quiet: true })
      const containerId = await startDevcontainer(context, {
        recreate: parsed.recreate,
        proxyMode: true,
        reuseRunning: true
      })
      await ensureContainerSshRuntime(context)
      return runSshdProxy(containerId)
    }

    if (parsed.command === 'refresh-gh-token-running') {
      const containerId = await findRunningContainerId(context)
      if (containerId === undefined) {
        throw new Error(`No running devcontainer found for: ${context.workspaceFolder}`)
      }
      await refreshContainerGhAuth(context)
      return 0
    }

    if (parsed.command === 'refresh-gh-token') {
      await startDevcontainer(context)
      await refreshContainerGhAuth(context)
      return 0
    }

    const containerId = await startDevcontainer(context, { recreate: parsed.recreate })
    await printPortHint(context, containerId)
    return openShell(context)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
