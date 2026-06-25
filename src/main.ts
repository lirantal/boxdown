import { existsSync } from 'node:fs'

import { codexProjectEntryForWorkspace, installCodexAppConfigProject, uninstallCodexAppConfigProject } from './codex-app-config.ts'
import { codingAgentFromCommand, type CodingAgentCli } from './coding-agents.ts'
import { doctorHasFailures, formatDoctorText, runDoctorChecks } from './doctor.ts'
import { startDevcontainer, printPortHint, openShell, openCodingAgentCli, ensureContainerSshRuntime, runSshdProxy, refreshContainerGhAuth, refreshContainerCodingAgentClis, findRunningContainerId, findWorkspaceContainer, stopWorkspaceContainer, removeWorkspaceContainer, listWorkspaceContainers } from './devcontainer.ts'
import { createWorkspaceListEntries, formatWorkspaceListText } from './list.ts'
import { listWorkspaceMetadata, writeWorkspaceMetadata } from './metadata.ts'
import { createWorkspaceContext, defaultDataRoot } from './paths.ts'
import { defaultSshAlias, installSshConfig, uninstallSshConfig } from './ssh-config.ts'
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
  | 'ssh-config-uninstall'
  | 'ssh-proxy'
  | 'refresh-gh-token'
  | 'refresh-gh-token-running'
  | 'coding-agent'

export type SshConfigInstallTarget = 'codex'

export interface ParsedCli {
  command: BoxdownCommand
  agent?: CodingAgentCli
  agentArgs?: string[]
  workspace?: string
  alias?: string
  target?: SshConfigInstallTarget
  recreate: boolean
  json: boolean
}

export const USAGE = `Usage:
  boxdown start [--workspace <path>] [--recreate]
  boxdown codex [--workspace <path>] [--recreate] [-- <codex args...>]
  boxdown claude [--workspace <path>] [--recreate] [-- <claude args...>]
  boxdown cc [--workspace <path>] [--recreate] [-- <claude args...>]
  boxdown opencode [--workspace <path>] [--recreate] [-- <opencode args...>]
  boxdown antigravity [--workspace <path>] [--recreate] [-- <agy args...>]
  boxdown list [--json]
  boxdown status [--workspace <path>] [--alias <name>] [--json]
  boxdown stop [--workspace <path>]
  boxdown down [--workspace <path>]
  boxdown doctor [--workspace <path>]
  boxdown ssh-config install [--workspace <path>] [--alias <name>] [--target codex]
  boxdown ssh-config uninstall [--workspace <path>] [--alias <name>]
  boxdown ssh-proxy [--workspace <path>] [--alias <name>]
  boxdown refresh-gh-token [--workspace <path>]
  boxdown refresh-gh-token-running [--workspace <path>]

Commands:
  start                     Start or reuse the workspace devcontainer, then open
                            an interactive shell inside it. Alias: shell.
  codex                     Start or reuse the devcontainer, then launch Codex.
  claude                    Start or reuse the devcontainer, then launch Claude
                            Code. Alias: cc.
  opencode                  Start or reuse the devcontainer, then launch
                            OpenCode.
  antigravity               Start or reuse the devcontainer, then launch
                            Antigravity CLI (agy).
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
  ssh-config uninstall      Remove Boxdown's managed SSH host alias block and
                            matching Codex app project entry.
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
  --target codex      Also register the SSH alias as a Codex app remote project.
  --recreate          Remove the existing devcontainer before starting.
  --json              Print JSON output. Supported by status and list.
  --help, -h          Show help.
`

export function commandWritesWorkspaceMetadata (command: BoxdownCommand): boolean {
  return [
    'start',
    'ssh-config-install',
    'ssh-proxy',
    'refresh-gh-token',
    'refresh-gh-token-running',
    'coding-agent'
  ].includes(command)
}

export function parseCliArgs (argv: string[]): ParsedCli {
  const args = [...argv]
  let workspace: string | undefined
  let alias: string | undefined
  let target: SshConfigInstallTarget | undefined
  let recreate = false
  let json = false
  let passthroughArgs: string[] | undefined
  const positional: string[] = []

  function parsed (command: BoxdownCommand): ParsedCli {
    if (json && command !== 'status' && command !== 'list') {
      throw new Error('--json is only supported with status and list')
    }

    if (passthroughArgs !== undefined) {
      throw new Error('-- passthrough is only supported with coding-agent commands')
    }

    if (target !== undefined && command !== 'ssh-config-install') {
      throw new Error('--target is only supported with ssh-config install')
    }

    return {
      command,
      workspace,
      alias,
      ...(target === undefined ? {} : { target }),
      recreate,
      json
    }
  }

  function parsedCodingAgent (agent: CodingAgentCli): ParsedCli {
    if (json) {
      throw new Error('--json is only supported with status and list')
    }

    if (target !== undefined) {
      throw new Error('--target is only supported with ssh-config install')
    }

    return {
      command: 'coding-agent',
      agent,
      agentArgs: passthroughArgs ?? [],
      workspace,
      alias,
      recreate,
      json
    }
  }

  while (args.length > 0) {
    const arg = args.shift()

    if (arg === undefined) {
      break
    }

    if (arg === '--') {
      passthroughArgs = args.splice(0)
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

    if (arg === '--target') {
      const value = args.shift()
      if (value === undefined) {
        throw new Error('--target requires a value')
      }

      if (value !== 'codex') {
        throw new Error(`Unsupported ssh-config install target: ${value}`)
      }

      target = value
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

  const codingAgent = codingAgentFromCommand(positional[0] ?? '')
  if (codingAgent !== undefined) {
    if (positional.length > 1) {
      throw new Error('Coding-agent CLI arguments must come after --')
    }

    return parsedCodingAgent(codingAgent)
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

  if (positional[0] === 'ssh-config') {
    if (positional.length === 1 || (positional[1] === 'install' && positional.length === 2)) {
      return parsed('ssh-config-install')
    }

    if (positional[1] === 'uninstall' && positional.length === 2) {
      return parsed('ssh-config-uninstall')
    }

    throw new Error(`Unknown ssh-config command: ${positional.slice(1).join(' ')}. Usage: boxdown ssh-config [install|uninstall] [--workspace <path>] [--alias <name>] [--target codex]`)
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
    const aliasSource = parsed.alias === undefined ? 'default' : 'provided'

    if (commandWritesWorkspaceMetadata(parsed.command)) {
      writeWorkspaceMetadata(context, alias)
    }

    if (parsed.command === 'ssh-config-install') {
      await installSshConfig(context, alias)

      if (parsed.target === 'codex') {
        const entry = codexProjectEntryForWorkspace(context, alias)
        const result = installCodexAppConfigProject(entry)

        process.stdout.write(`\nCodex app config: ${result.configPath}\n`)
        process.stdout.write(result.changed
          ? `Installed Codex remote project: ${entry.label} (${entry.remotePath})\n`
          : `Codex remote project already up to date: ${entry.label} (${entry.remotePath})\n`)

        if (result.backupPath !== undefined) {
          process.stdout.write(`Codex app config backup: ${result.backupPath}\n`)
        }

        process.stdout.write('Restart Codex to apply the remote project entry.\n')
      }

      return 0
    }

    if (parsed.command === 'ssh-config-uninstall') {
      uninstallSshConfig(alias)
      const entry = codexProjectEntryForWorkspace(context, alias)
      const result = uninstallCodexAppConfigProject(entry)

      process.stdout.write(`\nCodex app config: ${result.configPath}\n`)
      process.stdout.write(result.changed
        ? `Removed Codex remote project: ${entry.label} (${entry.remotePath})\n`
        : `Codex remote project not installed: ${entry.label} (${entry.remotePath})\n`)

      if (result.backupPath !== undefined) {
        process.stdout.write(`Codex app config backup: ${result.backupPath}\n`)
      }

      process.stdout.write('Restart Codex to apply the remote project removal.\n')
      return 0
    }

    if (parsed.command === 'status') {
      const container = await findWorkspaceContainer(context)
      const status = createStatusInfo(context, alias, container, existsSync, { aliasSource })

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

    if (parsed.command === 'coding-agent') {
      const agent = parsed.agent
      if (agent === undefined) {
        throw new Error('Missing coding-agent command')
      }

      await startDevcontainer(context, { recreate: parsed.recreate })
      await refreshContainerCodingAgentClis(context, false, [agent])
      return openCodingAgentCli(context, agent, parsed.agentArgs ?? [])
    }

    const containerId = await startDevcontainer(context, { recreate: parsed.recreate })
    await printPortHint(context, containerId)
    return openShell(context)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
