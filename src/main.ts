import { existsSync } from 'node:fs'

import { doctorHasFailures, formatDoctorText, runDoctorChecks } from './doctor.ts'
import { startDevcontainer, printPortHint, openShell, ensureContainerSshRuntime, runSshdProxy, refreshContainerGhAuth, refreshContainerCodingAgentClis, findRunningContainerId, findWorkspaceContainer, stopWorkspaceContainer, removeWorkspaceContainer, listWorkspaceContainers } from './devcontainer.ts'
import { createWorkspaceListEntries, formatWorkspaceListText } from './list.ts'
import { listWorkspaceMetadata, writeWorkspaceMetadata } from './metadata.ts'
import { createWorkspaceContext, defaultDataRoot } from './paths.ts'
import { defaultSshAlias, installSshConfig } from './ssh-config.ts'
import { createStatusInfo, formatStatusText, statusIsHealthy } from './status.ts'

export type BoxdownCommand =
  | 'help'
  | 'start'
  | 'list'
  | 'status'
  | 'stop'
  | 'down'
  | 'doctor'
  | 'ssh-config-install'
  | 'ssh-proxy'
  | 'refresh-gh-token'
  | 'refresh-gh-token-running'

export interface ParsedCli {
  command: BoxdownCommand
  workspace?: string
  alias?: string
  recreate: boolean
  json: boolean
}

export const USAGE = `Usage:
  boxdown start [--workspace <path>] [--recreate]
  boxdown list [--json]
  boxdown status [--workspace <path>] [--alias <name>] [--json]
  boxdown stop [--workspace <path>]
  boxdown down [--workspace <path>]
  boxdown doctor [--workspace <path>]
  boxdown ssh-config install [--workspace <path>] [--alias <name>]
  boxdown ssh-proxy [--workspace <path>] [--alias <name>]
  boxdown refresh-gh-token [--workspace <path>]
  boxdown refresh-gh-token-running [--workspace <path>]

Commands:
  start                     Start or reuse the workspace devcontainer, then open
                            an interactive shell inside it. Alias: shell.
  list                      List Boxdown-known devcontainer workspaces from any
                            directory.
  status                    Show workspace state, generated paths, SSH key paths,
                            and the matching devcontainer state.
  stop                      Stop the workspace devcontainer if it is running.
  down                      Remove the workspace devcontainer. Keeps Boxdown
                            cache, generated config, data, and SSH keys.
  doctor                    Check required host tools and Boxdown assets.
  ssh-config install        Install or update an SSH host alias for the workspace
                            devcontainer.
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
  --json              Print JSON output. Supported by status and list.
  --help, -h          Show help.
`

export function parseCliArgs (argv: string[]): ParsedCli {
  const args = [...argv]
  let workspace: string | undefined
  let alias: string | undefined
  let recreate = false
  let json = false
  const positional: string[] = []

  function parsed (command: BoxdownCommand): ParsedCli {
    if (json && command !== 'status' && command !== 'list') {
      throw new Error('--json is only supported with status and list')
    }

    return { command, workspace, alias, recreate, json }
  }

  while (args.length > 0) {
    const arg = args.shift()

    if (arg === undefined) {
      break
    }

    if (arg === '--help' || arg === '-h') {
      return parsed('help')
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

    if (arg === '--json') {
      json = true
      continue
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }

    positional.push(arg)
  }

  if (positional.length === 0) {
    return parsed('help')
  }

  if (positional[0] === 'start' || positional[0] === 'shell') {
    return parsed('start')
  }

  if (positional[0] === 'list' && positional.length === 1) {
    return parsed('list')
  }

  if (positional[0] === 'status' && positional.length === 1) {
    return parsed('status')
  }

  if (positional[0] === 'stop' && positional.length === 1) {
    return parsed('stop')
  }

  if (positional[0] === 'down' && positional.length === 1) {
    return parsed('down')
  }

  if (positional[0] === 'doctor' && positional.length === 1) {
    return parsed('doctor')
  }

  if (positional[0] === 'ssh-config' && positional[1] === 'install' && positional.length === 2) {
    return parsed('ssh-config-install')
  }

  if (positional[0] === 'ssh-proxy' && positional.length === 1) {
    return parsed('ssh-proxy')
  }

  if (positional[0] === 'refresh-gh-token' && positional.length === 1) {
    return parsed('refresh-gh-token')
  }

  if (positional[0] === 'refresh-gh-token-running' && positional.length === 1) {
    return parsed('refresh-gh-token-running')
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

    if (parsed.command === 'list') {
      const metadata = listWorkspaceMetadata(defaultDataRoot())
      const containers = await listWorkspaceContainers()
      const entries = createWorkspaceListEntries(metadata, containers, existsSync)

      if (parsed.json) {
        process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`)
      } else {
        process.stdout.write(formatWorkspaceListText(entries))
      }

      return 0
    }

    const context = createWorkspaceContext({ workspace: parsed.workspace })
    const alias = parsed.alias ?? defaultSshAlias(context.workspaceBasename)

    if ([
      'start',
      'status',
      'ssh-config-install',
      'ssh-proxy',
      'refresh-gh-token',
      'refresh-gh-token-running'
    ].includes(parsed.command)) {
      writeWorkspaceMetadata(context, alias)
    }

    if (parsed.command === 'ssh-config-install') {
      await installSshConfig(context, alias)
      return 0
    }

    if (parsed.command === 'status') {
      const container = await findWorkspaceContainer(context)
      const status = createStatusInfo(context, alias, container, existsSync)

      if (parsed.json) {
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
      } else {
        process.stdout.write(formatStatusText(status, { color: true }))
      }

      return statusIsHealthy(status) ? 0 : 1
    }

    if (parsed.command === 'stop') {
      await stopWorkspaceContainer(context)
      return 0
    }

    if (parsed.command === 'down') {
      await removeWorkspaceContainer(context)
      return 0
    }

    if (parsed.command === 'doctor') {
      const checks = await runDoctorChecks(context)
      process.stdout.write(formatDoctorText(checks))
      return doctorHasFailures(checks) ? 1 : 0
    }

    if (!existsSync(context.assetsDevcontainerDir)) {
      throw new Error(`Missing Boxdown devcontainer assets: ${context.assetsDevcontainerDir}`)
    }

    if (parsed.command === 'ssh-proxy') {
      await installSshConfig(context, alias, { quiet: true })
      const containerId = await startDevcontainer(context, {
        recreate: parsed.recreate,
        proxyMode: true,
        reuseRunning: true
      })
      await refreshContainerCodingAgentClis(context, true)
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
