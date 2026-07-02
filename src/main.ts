import { existsSync } from 'node:fs'

import { codexProjectEntryForWorkspace, uninstallCodexAppConfigProject, uninstallCodexGlobalStateProject } from './codex-app-config.ts'
import { codingAgentFromCommand, type CodingAgentCli } from './coding-agents.ts'
import { doctorHasFailures, formatDoctorText, runDoctorChecks } from './doctor.ts'
import { startDevcontainer, printPortHint, openShell, openCodingAgentCli, ensureContainerSshRuntime, runSshdProxy, refreshContainerGhAuth, refreshContainerCodingAgentClis, ensureContainerCodingAgentCli, findRunningContainerId, findWorkspaceContainer, stopWorkspaceContainer, removeWorkspaceContainer, listWorkspaceContainers, openSshTunnel, type TunnelPortForward } from './devcontainer.ts'
import { promptMultiSelect, type PromptInput, type PromptOutput } from './interactive-select.ts'
import { createWorkspaceListEntries, formatWorkspaceListText } from './list.ts'
import { listWorkspaceMetadata, writeWorkspaceMetadata } from './metadata.ts'
import { createWorkspaceContext, defaultDataRoot } from './paths.ts'
import { defaultSshAlias, installSshConfig, uninstallSshConfig } from './ssh-config.ts'
import { dedupeSshInstallTargets, installSshInstallTarget, isSshConfigInstallTarget, SSH_INSTALL_TARGETS, sshInstallTargetFlagHintsText, supportedSshInstallTargetsText, type SshConfigInstallTarget } from './ssh-install-targets.ts'
import { createStatusInfo, formatStatusText, statusIsHealthy } from './status.ts'

export type BoxdownCommand =
  | 'help'
  | 'start'
  | 'list'
  | 'status'
  | 'stop'
  | 'down'
  | 'doctor'
  | 'ssh-install'
  | 'ssh-uninstall'
  | 'ssh-proxy'
  | 'tunnel'
  | 'refresh-gh-token'
  | 'refresh-gh-token-running'
  | 'coding-agent'

export interface ParsedCli {
  command: BoxdownCommand
  agent?: CodingAgentCli
  agentArgs?: string[]
  workspace?: string
  workspaces?: string[]
  alias?: string
  targets?: SshConfigInstallTarget[]
  tunnelPorts?: TunnelPortForward[]
  recreate: boolean
  json: boolean
}

export interface RunCliOptions {
  promptInput?: PromptInput
  promptOutput?: PromptOutput
  env?: NodeJS.ProcessEnv
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
  boxdown down [--workspace <path>]...
  boxdown doctor [--workspace <path>]
  boxdown ssh install [--workspace <path>] [--alias <name>] [--target <name>]...
  boxdown ssh uninstall [--workspace <path>] [--alias <name>]
  boxdown ssh-proxy [--workspace <path>] [--alias <name>]
  boxdown tunnel --port <port> [--port <local:remote>] [--workspace <path>] [--alias <name>]
  boxdown refresh-gh-token [--workspace <path>]
  boxdown refresh-gh-token-running [--workspace <path>]

Commands:
  start                     Start or reuse the workspace devcontainer, then open
                            an interactive shell inside it. Alias: shell.
  codex                     Start or reuse the devcontainer, then launch Codex.
  claude                    Start or reuse the devcontainer, then launch Claude
                            Code. Alias: cc.
  opencode                  Start or reuse the devcontainer, then launch
                            OpenCode, installing it first when needed.
  antigravity               Start or reuse the devcontainer, then launch
                            Antigravity CLI (agy), installing it first when
                            needed.
  list                      List Boxdown-known devcontainer workspaces from any
                            directory.
  status                    Show workspace state, generated paths, SSH key paths,
                            and the matching devcontainer state.
  stop                      Stop the workspace devcontainer if it is running.
  down                      Remove the workspace devcontainer. Keeps Boxdown
                            cache, generated config, data, and SSH keys.
  doctor                    Check required host tools and Boxdown assets.
  ssh install               Install or update an SSH host alias for the workspace
                            devcontainer.
  ssh uninstall             Remove Boxdown's managed SSH host alias block and
                            matching Codex app project entry.
  ssh-proxy                 Internal command used by the generated SSH
                            ProxyCommand. Starts or reuses the devcontainer and
                            bridges SSH over docker exec.
  tunnel                    Start or reuse the devcontainer, then keep an SSH
                            local port tunnel open for host/browser access.
  refresh-gh-token          Start or reuse the devcontainer, then copy host
                            GitHub CLI auth into the container when available.
  refresh-gh-token-running  Refresh GitHub CLI auth only if the workspace
                            devcontainer is already running.

Options:
  --workspace <path>  Target project directory. Defaults to the current directory.
                      Repeatable with down.
  --alias <name>      SSH host alias. Defaults to <repo-name>-devcontainer.
  --target <name>     Optional SSH install target. Repeatable. Supported: codex.
  --port <port>       Tunnel a local port to the same remote port, or use
                      <local:remote>. Repeatable. Supported by tunnel.
  --recreate          Remove the existing devcontainer before starting.
  --json              Print JSON output. Supported by status and list.
  --help, -h          Show help.
`

export function commandWritesWorkspaceMetadata (command: BoxdownCommand): boolean {
  return [
    'start',
    'ssh-install',
    'ssh-proxy',
    'tunnel',
    'refresh-gh-token',
    'refresh-gh-token-running',
    'coding-agent'
  ].includes(command)
}

export function parseCliArgs (argv: string[]): ParsedCli {
  const args = [...argv]
  const workspaces: string[] = []
  let alias: string | undefined
  const targets: SshConfigInstallTarget[] = []
  const tunnelPorts: TunnelPortForward[] = []
  let recreate = false
  let json = false
  let passthroughArgs: string[] | undefined
  const positional: string[] = []

  function workspaceFields (command: BoxdownCommand): Pick<ParsedCli, 'workspace' | 'workspaces'> {
    if (workspaces.length > 1 && command !== 'down') {
      throw new Error('--workspace can only be repeated with down')
    }

    return {
      workspace: workspaces[0],
      ...(command === 'down' && workspaces.length > 0 ? { workspaces: [...workspaces] } : {})
    }
  }

  function parsed (command: BoxdownCommand): ParsedCli {
    if (json && command !== 'status' && command !== 'list') {
      throw new Error('--json is only supported with status and list')
    }

    if (passthroughArgs !== undefined) {
      throw new Error('-- passthrough is only supported with coding-agent commands')
    }

    if (targets.length > 0 && command !== 'ssh-install') {
      throw new Error('--target is only supported with ssh install')
    }

    if (tunnelPorts.length > 0 && command !== 'tunnel') {
      throw new Error('--port is only supported with tunnel')
    }

    const parsedTargets = dedupeSshInstallTargets(targets)

    return {
      command,
      ...workspaceFields(command),
      alias,
      ...(parsedTargets.length === 0 ? {} : { targets: parsedTargets }),
      ...(tunnelPorts.length === 0 ? {} : { tunnelPorts }),
      recreate,
      json
    }
  }

  function parsedCodingAgent (agent: CodingAgentCli): ParsedCli {
    if (json) {
      throw new Error('--json is only supported with status and list')
    }

    if (targets.length > 0) {
      throw new Error('--target is only supported with ssh install')
    }

    if (tunnelPorts.length > 0) {
      throw new Error('--port is only supported with tunnel')
    }

    return {
      command: 'coding-agent',
      agent,
      agentArgs: passthroughArgs ?? [],
      ...workspaceFields('coding-agent'),
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
      workspaces.push(value)
      continue
    }

    if (arg === '--target') {
      const value = args.shift()
      if (value === undefined) {
        throw new Error('--target requires a value')
      }

      if (!isSshConfigInstallTarget(value)) {
        throw new Error(`Unsupported ssh install target: ${value}`)
      }

      targets.push(value)
      continue
    }

    if (arg === '--port') {
      const value = args.shift()
      if (value === undefined) {
        throw new Error('--port requires a value')
      }
      tunnelPorts.push(parseTunnelPort(value))
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

  if (positional[0] === 'ssh') {
    if (positional.length === 1 || (positional[1] === 'install' && positional.length === 2)) {
      return parsed('ssh-install')
    }

    if (positional[1] === 'uninstall' && positional.length === 2) {
      return parsed('ssh-uninstall')
    }

    throw new Error(`Unknown ssh command: ${positional.slice(1).join(' ')}. Usage: boxdown ssh [install|uninstall] [--workspace <path>] [--alias <name>] [--target <name>]...`)
  }

  if (positional[0] === 'ssh-proxy' && positional.length === 1) {
    return parsed('ssh-proxy')
  }

  if (positional[0] === 'tunnel' && positional.length === 1) {
    return parsed('tunnel')
  }

  if (positional[0] === 'refresh-gh-token' && positional.length === 1) {
    return parsed('refresh-gh-token')
  }

  if (positional[0] === 'refresh-gh-token-running' && positional.length === 1) {
    return parsed('refresh-gh-token-running')
  }

  throw new Error(`Unknown command: ${positional.join(' ')}`)
}

function parsePortNumber (value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`Invalid tunnel port: ${value}`)
  }

  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid tunnel port: ${value}`)
  }

  return port
}

export function parseTunnelPort (value: string): TunnelPortForward {
  const parts = value.split(':')

  if (parts.length === 1) {
    const port = parsePortNumber(parts[0] ?? '')
    return {
      localPort: port,
      remotePort: port
    }
  }

  if (parts.length === 2) {
    return {
      localPort: parsePortNumber(parts[0] ?? ''),
      remotePort: parsePortNumber(parts[1] ?? '')
    }
  }

  throw new Error(`Invalid tunnel port: ${value}`)
}

async function runDownCommand (workspaces: string[] | undefined): Promise<number> {
  const targetWorkspaces = workspaces === undefined || workspaces.length === 0 ? [undefined] : workspaces
  let failed = false

  for (const workspace of targetWorkspaces) {
    try {
      const context = createWorkspaceContext({ workspace })
      await removeWorkspaceContainer(context)
    } catch (error) {
      failed = true
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  return failed ? 1 : 0
}

interface ResolvedSshInstallTargets {
  targets: SshConfigInstallTarget[]
  cancelled: boolean
  skippedNonInteractive: boolean
}

async function resolveSshInstallTargets (
  parsed: ParsedCli,
  options: RunCliOptions
): Promise<ResolvedSshInstallTargets> {
  if (parsed.targets !== undefined) {
    return {
      targets: parsed.targets,
      cancelled: false,
      skippedNonInteractive: false
    }
  }

  const result = await promptMultiSelect<SshConfigInstallTarget>({
    title: 'Install optional SSH targets?',
    choices: SSH_INSTALL_TARGETS.map((target) => ({
      value: target.value,
      label: target.label,
      description: target.description
    })),
    skipLabel: 'Skip optional targets',
    input: options.promptInput,
    output: options.promptOutput,
    env: options.env
  })

  return {
    targets: result.values,
    cancelled: result.status === 'cancelled',
    skippedNonInteractive: result.status === 'non-interactive'
  }
}

export async function runCli (argv: string[] = process.argv.slice(2), options: RunCliOptions = {}): Promise<number> {
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

    if (parsed.command === 'down') {
      return runDownCommand(parsed.workspaces)
    }

    const context = createWorkspaceContext({ workspace: parsed.workspace })
    const alias = parsed.alias ?? defaultSshAlias(context.workspaceBasename)
    const aliasSource = parsed.alias === undefined ? 'default' : 'provided'

    if (parsed.command !== 'ssh-install' && commandWritesWorkspaceMetadata(parsed.command)) {
      writeWorkspaceMetadata(context, alias)
    }

    if (parsed.command === 'ssh-install') {
      const resolvedTargets = await resolveSshInstallTargets(parsed, options)

      if (resolvedTargets.cancelled) {
        process.stderr.write('Canceled SSH install.\n')
        return 1
      }

      writeWorkspaceMetadata(context, alias)
      await installSshConfig(context, alias)

      if (resolvedTargets.skippedNonInteractive) {
        process.stdout.write(`\nNo optional SSH install targets selected. Run boxdown ssh install ${sshInstallTargetFlagHintsText()} to install optional targets explicitly. Supported targets: ${supportedSshInstallTargetsText()}.\n`)
      }

      for (const target of resolvedTargets.targets) {
        await installSshInstallTarget(context, alias, target)
      }

      return 0
    }

    if (parsed.command === 'ssh-uninstall') {
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

      const stateResult = uninstallCodexGlobalStateProject(entry)

      process.stdout.write(`\nCodex app state: ${stateResult.statePath}\n`)
      process.stdout.write(stateResult.changed
        ? `Removed Codex sidebar state: ${entry.label} (${entry.remotePath})\n`
        : `Codex sidebar state not installed: ${entry.label} (${entry.remotePath})\n`)

      if (stateResult.backupPath !== undefined) {
        process.stdout.write(`Codex app state backup: ${stateResult.backupPath}\n`)
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

    if (parsed.command === 'tunnel') {
      const tunnelPorts = parsed.tunnelPorts ?? []
      if (tunnelPorts.length === 0) {
        throw new Error('tunnel requires at least one --port value')
      }

      await installSshConfig(context, alias, { quiet: true })
      await startDevcontainer(context, {
        recreate: parsed.recreate,
        reuseRunning: true
      })

      const forwards = tunnelPorts
        .map((port) => `127.0.0.1:${port.localPort} -> localhost:${port.remotePort}`)
        .join(', ')

      process.stdout.write(`Forwarding ${forwards}\n`)
      process.stdout.write('Press Ctrl-C to stop the tunnel.\n')

      return openSshTunnel(alias, tunnelPorts)
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
      await ensureContainerCodingAgentCli(context, agent)
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
