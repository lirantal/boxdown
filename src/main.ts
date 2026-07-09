import { existsSync } from 'node:fs'

import { claudeSshConfigEntryForWorkspace, uninstallClaudeSshConfigHost } from './claude-app-config.ts'
import { codexProjectEntryForWorkspace, legacyCodexRemotePathForWorkspace, uninstallCodexAppConfigProject, uninstallCodexGlobalStateProject } from './codex-app-config.ts'
import { codingAgentBinary, codingAgentFromCommand, type CodingAgentCli } from './coding-agents.ts'
import { buildGeneratedDevcontainerConfig, publishContainerPortFromConfig } from './config.ts'
import { doctorHasFailures, formatDoctorText, runDoctorChecks } from './doctor.ts'
import { startDevcontainer, printPortHint, openShell, openCodingAgentCli, ensureContainerSshRuntime, runSshdProxy, refreshContainerGhAuth, refreshContainerCodingAgentClis, ensureContainerCodingAgentCli, findRunningContainerId, findWorkspaceContainer, stopWorkspaceContainer, removeWorkspaceContainer, listWorkspaceContainers, openSshTunnel, type TunnelPortForward } from './devcontainer.ts'
import { canPromptInteractively, promptConfirm, promptMultiSelect, promptText, type PromptInput, type PromptOutput } from './interactive-prompts.ts'
import { createWorkspaceListEntries, formatWorkspaceListText } from './list.ts'
import { createWorkspaceCommandLogger, withLoggedProcessOutput, type WorkspaceCommandLogger } from './logging.ts'
import { listWorkspaceMetadata, readWorkspaceMetadata, writeWorkspaceMetadata } from './metadata.ts'
import { createWorkspaceContext, defaultDataRoot, type WorkspaceContext } from './paths.ts'
import { createProgress, resolveProgressMode, type ProgressReporter, type ProgressOutputTarget, type ProgressStepDefinition } from './progress.ts'
import { purgeWorkspace } from './purge.ts'
import { defaultSshAlias, installSshConfig, uninstallSshConfig } from './ssh-config.ts'
import { dedupeSshInstallTargets, installSshInstallTarget, isSshConfigInstallTarget, SSH_INSTALL_TARGETS, sshInstallTargetFlagHintsText, supportedSshInstallTargetsText, type SshConfigInstallTarget } from './ssh-install-targets.ts'
import { createStatusInfo, formatStatusText, statusIsHealthy } from './status.ts'

export type BoxdownCommand =
  | 'help'
  | 'setup'
  | 'start'
  | 'list'
  | 'status'
  | 'stop'
  | 'down'
  | 'purge'
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
  verbose: boolean
}

export interface RunCliOptions {
  promptInput?: PromptInput
  promptOutput?: PromptOutput
  env?: NodeJS.ProcessEnv
}

export const USAGE = `Usage:
  boxdown setup [--workspace <path>] [--alias <name>] [--recreate] [--target <name>]...
  boxdown start [--workspace <path>] [--recreate]
  boxdown codex [--workspace <path>] [--recreate] [-- <codex args...>]
  boxdown claude [--workspace <path>] [--recreate] [-- <claude args...>]
  boxdown opencode [--workspace <path>] [--recreate] [-- <opencode args...>]
  boxdown antigravity [--workspace <path>] [--recreate] [-- <agy args...>]
  boxdown list [--json]
  boxdown status [--workspace <path>] [--alias <name>] [--json]
  boxdown stop [--workspace <path>]
  boxdown down [--workspace <path>]...
  boxdown purge [--workspace <path>] [--alias <name>]
  boxdown doctor [--workspace <path>]
  boxdown ssh install [--workspace <path>] [--alias <name>] [--target <name>]...
  boxdown ssh uninstall [--workspace <path>] [--alias <name>]
  boxdown ssh-proxy [--workspace <path>] [--alias <name>]
  boxdown tunnel [--port <port>] [--port <local:remote>] [--workspace <path>] [--alias <name>]
  boxdown refresh-gh-token [--workspace <path>]
  boxdown refresh-gh-token-running [--workspace <path>]

Commands:
  setup                     Prepare the workspace devcontainer and SSH/app
                            integration without opening a shell.
  start, shell              Start or reuse the workspace devcontainer, then open
                            an interactive shell inside it.
  codex                     Start or reuse the devcontainer, then launch Codex.
  claude, cc                Start or reuse the devcontainer, then launch Claude
                            Code.
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
  purge                     Remove the workspace devcontainer, exact Docker
                            image, managed SSH/app config, and Boxdown
                            cache/data for this workspace.
  doctor                    Check required host tools and Boxdown assets.
  ssh install               Install or update an SSH host alias for the workspace
                            devcontainer.
  ssh uninstall             Remove Boxdown's managed SSH host alias block and
                            matching Codex/Claude app entries.
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
  --target <name>     Optional SSH install target. Repeatable. Supported by
                      setup and ssh install: codex, claude.
  --port <port>       Tunnel a local port to the same remote port, or use
                      <local:remote>. Repeatable. Supported by tunnel.
  --recreate          Remove the existing devcontainer before starting.
  --json              Print JSON output. Supported by status and list.
  --verbose           Stream raw Docker, devcontainer, and hook command output.
                      Lifecycle commands append the same managed output to the
                      per-workspace command log either way.
  --help, -h          Show help.
`

export function commandWritesWorkspaceMetadata (command: BoxdownCommand): boolean {
  return [
    'setup',
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
  let verbose = false
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

    if (targets.length > 0 && command !== 'setup' && command !== 'ssh-install') {
      throw new Error('--target is only supported with setup and ssh install')
    }

    if (tunnelPorts.length > 0 && command !== 'tunnel') {
      throw new Error('--port is only supported with tunnel')
    }

    if (recreate && command === 'purge') {
      throw new Error('--recreate is not supported with purge')
    }

    const parsedTargets = dedupeSshInstallTargets(targets)

    return {
      command,
      ...workspaceFields(command),
      alias,
      ...(parsedTargets.length === 0 ? {} : { targets: parsedTargets }),
      ...(tunnelPorts.length === 0 ? {} : { tunnelPorts }),
      recreate,
      json,
      verbose
    }
  }

  function parsedCodingAgent (agent: CodingAgentCli): ParsedCli {
    if (json) {
      throw new Error('--json is only supported with status and list')
    }

    if (targets.length > 0) {
      throw new Error('--target is only supported with setup and ssh install')
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
      json,
      verbose
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

    if (arg === '--verbose') {
      verbose = true
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

  if (positional[0] === 'setup' && positional.length === 1) {
    return parsed('setup')
  }

  if (positional[0] === 'codex' && positional[1] === 'repair') {
    throw new Error(`Unknown command: ${positional.join(' ')}`)
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

  if (positional[0] === 'purge' && positional.length === 1) {
    return parsed('purge')
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

export function parseTunnelPortList (value: string): TunnelPortForward[] {
  const tokens = value.split(/[,\s]+/u).filter((token) => token.length > 0)

  if (tokens.length === 0) {
    throw new Error('tunnel requires at least one --port value')
  }

  return tokens.map((token) => parseTunnelPort(token))
}

interface ResolvedDownWorkspaces {
  workspaces: string[] | undefined
  cancelled: boolean
}

function createLifecycleLogger (context: WorkspaceContext, command: string, argv: string[]): WorkspaceCommandLogger {
  const logger = createWorkspaceCommandLogger(context)
  logger.section(`boxdown ${command}`, {
    argv: JSON.stringify(argv),
    cwd: process.cwd()
  })
  return logger
}

async function runLoggedLifecycle<T> (
  context: WorkspaceContext,
  command: string,
  argv: string[],
  action: (logger: WorkspaceCommandLogger) => Promise<T>
): Promise<T> {
  const logger = createLifecycleLogger(context, command, argv)

  try {
    return await withLoggedProcessOutput(logger, async () => action(logger))
  } catch (error) {
    logger.boxdown(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    throw error
  }
}

async function resolveDownWorkspaces (
  workspaces: string[] | undefined,
  options: RunCliOptions
): Promise<ResolvedDownWorkspaces> {
  if (workspaces !== undefined && workspaces.length > 0) {
    return { workspaces, cancelled: false }
  }

  const context = createWorkspaceContext()
  const metadata = readWorkspaceMetadata(context)

  if (metadata?.workspaceFolder === context.workspaceFolder) {
    return { workspaces: undefined, cancelled: false }
  }

  const input = options.promptInput ?? process.stdin
  const output = options.promptOutput ?? process.stdout
  const env = options.env ?? process.env

  if (!canPromptInteractively(input, output, env)) {
    return { workspaces: undefined, cancelled: false }
  }

  const entries = createWorkspaceListEntries(
    listWorkspaceMetadata(defaultDataRoot()),
    await listWorkspaceContainers(),
    existsSync
  ).filter((entry) => entry.repoExists)

  if (entries.length === 0) {
    return { workspaces: undefined, cancelled: false }
  }

  const result = await promptMultiSelect<string>({
    title: 'Remove Boxdown devcontainers?',
    choices: entries.map((entry) => ({
      value: entry.workspaceFolder,
      label: entry.workspaceBasename,
      description: `${entry.state} - ${entry.workspaceFolder}`
    })),
    skipLabel: 'Cancel',
    summaryLabel: 'Down workspaces',
    input,
    output,
    env
  })

  if (result.status === 'selected') {
    return { workspaces: result.values, cancelled: false }
  }

  if (result.status === 'non-interactive') {
    return { workspaces: undefined, cancelled: false }
  }

  return { workspaces: undefined, cancelled: true }
}

async function runDownCommand (workspaces: string[] | undefined, options: RunCliOptions): Promise<number> {
  const resolved = await resolveDownWorkspaces(workspaces, options)

  if (resolved.cancelled) {
    process.stderr.write('Canceled down.\n')
    return 1
  }

  const targetWorkspaces = resolved.workspaces === undefined || resolved.workspaces.length === 0 ? [undefined] : resolved.workspaces
  let failed = false

  for (const workspace of targetWorkspaces) {
    try {
      const context = createWorkspaceContext({ workspace })
      await runLoggedLifecycle(context, 'down', ['down', ...(workspace === undefined ? [] : ['--workspace', workspace])], async (logger) => {
        await removeWorkspaceContainer(context, { logger })
      })
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

interface ResolvedTunnelPorts {
  tunnelPorts: TunnelPortForward[]
  cancelled: boolean
}

async function resolveTunnelPorts (
  parsed: ParsedCli,
  context: ReturnType<typeof createWorkspaceContext>,
  options: RunCliOptions
): Promise<ResolvedTunnelPorts> {
  if (parsed.tunnelPorts !== undefined && parsed.tunnelPorts.length > 0) {
    return {
      tunnelPorts: parsed.tunnelPorts,
      cancelled: false
    }
  }

  const input = options.promptInput ?? process.stdin
  const output = options.promptOutput ?? process.stdout
  const env = options.env ?? process.env

  if (!canPromptInteractively(input, output, env)) {
    return {
      tunnelPorts: [],
      cancelled: false
    }
  }

  const defaultPort = publishContainerPortFromConfig(buildGeneratedDevcontainerConfig(context))
  const result = await promptText({
    title: 'Tunnel port(s) to forward?',
    details: ['Use a port like 3030, or a mapping like 8080:3031.'],
    defaultValue: defaultPort,
    summaryLabel: 'Tunnel ports',
    validate: (value) => {
      try {
        parseTunnelPortList(value)
        return undefined
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    input,
    output,
    env
  })

  if (result.status === 'submitted') {
    return {
      tunnelPorts: parseTunnelPortList(result.value),
      cancelled: false
    }
  }

  return {
    tunnelPorts: [],
    cancelled: result.status === 'cancelled'
  }
}

async function confirmPurgeWorkspace (
  context: ReturnType<typeof createWorkspaceContext>,
  parsed: ParsedCli,
  options: RunCliOptions
): Promise<boolean> {
  const result = await promptConfirm({
    title: 'Purge Boxdown workspace?',
    details: [
      `Workspace: ${context.workspaceFolder}`,
      'Removes devcontainer, recorded image, SSH/Codex entries, cache, and data.',
      parsed.alias === undefined ? 'Alias: default and recorded aliases' : `Alias: ${parsed.alias}, default, and recorded aliases`
    ],
    confirmLabel: 'Purge',
    cancelLabel: 'Cancel',
    summaryLabel: 'Purge',
    input: options.promptInput,
    output: options.promptOutput,
    env: options.env
  })

  return result.status === 'confirmed' || result.status === 'non-interactive'
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
    summaryLabel: 'Optional SSH targets',
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

function printSkippedSshInstallTargets (command: 'setup' | 'ssh install'): void {
  process.stdout.write(`\nNo optional SSH install targets selected. Run boxdown ${command} ${sshInstallTargetFlagHintsText()} to install optional targets explicitly. Supported targets: ${supportedSshInstallTargetsText()}.\n`)
}

interface SetupWorkspaceOptions {
  recreate?: boolean
  targets?: SshConfigInstallTarget[]
  progress?: ProgressReporter
  logger?: WorkspaceCommandLogger
  start?: typeof startDevcontainer
  installSsh?: typeof installSshConfig
  installTarget?: typeof installSshInstallTarget
}

export async function setupWorkspace (
  context: WorkspaceContext,
  alias: string,
  options: SetupWorkspaceOptions = {}
): Promise<void> {
  await (options.start ?? startDevcontainer)(context, {
    recreate: options.recreate,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.progress === undefined ? {} : { progress: options.progress })
  })

  const hasSshAliasStep = options.progress?.hasStep('ssh-alias') === true

  if (options.progress?.mode === 'interactive') {
    if (hasSshAliasStep) {
      options.progress.startStep('ssh-alias')
    } else {
      options.progress.item('Installing SSH alias')
      options.progress.detail(alias)
    }

    try {
      await (options.installSsh ?? installSshConfig)(context, alias, { quiet: true })
      if (hasSshAliasStep) {
        options.progress.completeStep('ssh-alias')
      }
    } catch (error) {
      if (hasSshAliasStep) {
        options.progress.failStep('ssh-alias')
      }
      throw error
    }
  } else {
    await (options.installSsh ?? installSshConfig)(context, alias)
  }

  const installTarget = options.installTarget ?? installSshInstallTarget
  for (const target of options.targets ?? []) {
    const stepId = `ssh-target:${target}`
    const hasTargetStep = options.progress?.hasStep(stepId) === true

    if (hasTargetStep) {
      options.progress?.startStep(stepId)
    } else if (options.progress?.mode === 'interactive') {
      options.progress.item(`Installing ${target} SSH target`)
    }

    try {
      await installTarget(context, alias, target, {
        quiet: options.progress?.mode === 'interactive'
      })
      if (hasTargetStep) {
        options.progress?.completeStep(stepId)
      }
    } catch (error) {
      if (hasTargetStep) {
        options.progress?.failStep(stepId)
      }
      throw error
    }
  }
}

function createCliProgress (
  parsed: ParsedCli,
  target: ProgressOutputTarget = 'stdout',
  options: { env?: NodeJS.ProcessEnv } = {}
): ProgressReporter {
  return createProgress({
    mode: resolveProgressMode({
      verbose: parsed.verbose,
      json: parsed.json,
      target,
      env: options.env
    }),
    target
  })
}

function startProgressSteps (): ProgressStepDefinition[] {
  return [
    { id: 'ssh-identity', label: 'Preparing SSH identity' },
    { id: 'devcontainer-config', label: 'Writing generated devcontainer config' },
    { id: 'devcontainer-start', label: 'Starting devcontainer' }
  ]
}

function sshTargetProgressLabel (target: SshConfigInstallTarget): string {
  const label = SSH_INSTALL_TARGETS.find((candidate) => candidate.value === target)?.label ?? target
  return `Installing ${label} SSH target`
}

function setupProgressSteps (targets: readonly SshConfigInstallTarget[]): ProgressStepDefinition[] {
  return [
    ...startProgressSteps(),
    { id: 'ssh-alias', label: 'Installing SSH alias' },
    ...targets.map((target) => ({
      id: `ssh-target:${target}`,
      label: sshTargetProgressLabel(target)
    }))
  ]
}

function sshAliasProgressStep (label: string): ProgressStepDefinition {
  return { id: 'ssh-alias', label }
}

function tunnelProgressSteps (): ProgressStepDefinition[] {
  return [
    sshAliasProgressStep('Updating SSH alias'),
    ...startProgressSteps()
  ]
}

function sshProxyProgressSteps (): ProgressStepDefinition[] {
  return [
    sshAliasProgressStep('Updating SSH alias'),
    ...startProgressSteps(),
    { id: 'coding-agent-refresh', label: 'Refreshing default coding-agent CLIs' },
    { id: 'ssh-runtime', label: 'Preparing container SSH runtime' }
  ]
}

function codingAgentProgressSteps (agent: CodingAgentCli): ProgressStepDefinition[] {
  return [
    ...startProgressSteps(),
    { id: 'agent-cli', label: `Preparing ${codingAgentBinary(agent)} inside the devcontainer` }
  ]
}

function ghAuthProgressSteps (includeStart: boolean): ProgressStepDefinition[] {
  return [
    ...(includeStart ? startProgressSteps() : [{ id: 'devcontainer-running', label: 'Using running devcontainer' }]),
    { id: 'gh-auth-config', label: 'Preparing generated config for GitHub auth refresh' },
    { id: 'gh-token-read', label: 'Reading host GitHub CLI token' },
    { id: 'gh-auth-refresh', label: 'Refreshing GitHub CLI auth inside the devcontainer' },
    { id: 'gh-git-auth', label: 'Configuring workspace GitHub Git auth' },
    { id: 'gh-auth-verify', label: 'Verifying GitHub CLI auth inside the devcontainer' }
  ]
}

async function withProgressSection<T> (
  progress: ProgressReporter,
  title: string,
  details: readonly string[],
  run: () => Promise<T>
): Promise<T> {
  progress.section(title)
  for (const detail of details) {
    progress.detail(detail)
  }

  try {
    return await run()
  } finally {
    progress.end()
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
      return runDownCommand(parsed.workspaces, options)
    }

    const context = createWorkspaceContext({ workspace: parsed.workspace })
    const alias = parsed.alias ?? defaultSshAlias(context.workspaceBasename)
    const aliasSource = parsed.alias === undefined ? 'default' : 'provided'

    if (parsed.command !== 'ssh-install' && parsed.command !== 'setup' && parsed.command !== 'tunnel' && commandWritesWorkspaceMetadata(parsed.command)) {
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
        printSkippedSshInstallTargets('ssh install')
      }

      for (const target of resolvedTargets.targets) {
        await installSshInstallTarget(context, alias, target)
      }

      return 0
    }

    if (parsed.command === 'ssh-uninstall') {
      uninstallSshConfig(alias)
      const entry = codexProjectEntryForWorkspace(context, alias)
      const legacyRemotePath = legacyCodexRemotePathForWorkspace(context)
      const result = uninstallCodexAppConfigProject(entry, {
        additionalRemotePaths: [legacyRemotePath]
      })

      process.stdout.write(`\nCodex app config: ${result.configPath}\n`)
      process.stdout.write(result.changed
        ? `Removed Codex remote project: ${entry.label} (${entry.remotePath})\n`
        : `Codex remote project not installed: ${entry.label} (${entry.remotePath})\n`)

      if (result.backupPath !== undefined) {
        process.stdout.write(`Codex app config backup: ${result.backupPath}\n`)
      }

      const stateResult = uninstallCodexGlobalStateProject(entry, {
        additionalRemotePaths: [legacyRemotePath]
      })

      process.stdout.write(`\nCodex app state: ${stateResult.statePath}\n`)
      process.stdout.write(stateResult.changed
        ? `Removed Codex sidebar state: ${entry.label} (${entry.remotePath})\n`
        : `Codex sidebar state not installed: ${entry.label} (${entry.remotePath})\n`)

      if (stateResult.backupPath !== undefined) {
        process.stdout.write(`Codex app state backup: ${stateResult.backupPath}\n`)
      }

      const claudeEntry = claudeSshConfigEntryForWorkspace(context, alias)
      const claudeResult = uninstallClaudeSshConfigHost(claudeEntry)

      process.stdout.write(`\nClaude SSH config: ${claudeResult.configPath}\n`)
      process.stdout.write(claudeResult.changed
        ? `Removed Claude SSH remote: ${claudeEntry.name} (${claudeEntry.sshHost})\n`
        : `Claude SSH remote not installed: ${claudeEntry.name} (${claudeEntry.sshHost})\n`)

      if (claudeResult.backupPath !== undefined) {
        process.stdout.write(`Claude SSH config backup: ${claudeResult.backupPath}\n`)
      }

      process.stdout.write('Restart Codex and Claude to apply the remote project removal.\n')
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
      return runLoggedLifecycle(context, 'stop', argv, async (logger) => {
        await stopWorkspaceContainer(context, { logger })
        return 0
      })
    }

    if (parsed.command === 'purge') {
      if (!await confirmPurgeWorkspace(context, parsed, options)) {
        process.stderr.write('Canceled purge.\n')
        return 1
      }

      return runLoggedLifecycle(context, 'purge', argv, async (logger) => purgeWorkspace(context, {
        alias: parsed.alias,
        logger
      }))
    }

    if (parsed.command === 'doctor') {
      const checks = await runDoctorChecks(context)
      process.stdout.write(formatDoctorText(checks))
      return doctorHasFailures(checks) ? 1 : 0
    }

    if (!existsSync(context.assetsDevcontainerDir)) {
      throw new Error(`Missing Boxdown devcontainer assets: ${context.assetsDevcontainerDir}`)
    }

    if (parsed.command === 'setup') {
      const resolvedTargets = await resolveSshInstallTargets(parsed, options)

      if (resolvedTargets.cancelled) {
        process.stderr.write('Canceled setup.\n')
        return 1
      }

      writeWorkspaceMetadata(context, alias)
      const progress = createCliProgress(parsed, 'stdout', { env: options.env })
      await runLoggedLifecycle(context, 'setup', argv, async (logger) => {
        await withProgressSection(progress, 'Boxdown setup', [
          `Workspace: ${context.workspaceFolder}`,
          `SSH alias: ${alias}`
        ], async () => {
          progress.setSteps(setupProgressSteps(resolvedTargets.targets))
          await setupWorkspace(context, alias, {
            recreate: parsed.recreate,
            targets: resolvedTargets.targets,
            progress,
            logger
          })
        })
      })

      if (resolvedTargets.skippedNonInteractive) {
        printSkippedSshInstallTargets('setup')
      }

      return 0
    }

    if (parsed.command === 'ssh-proxy') {
      return runLoggedLifecycle(context, 'ssh-proxy', argv, async (logger) => {
        const progress = createCliProgress(parsed, 'stderr', { env: options.env })
        const containerId = await withProgressSection(progress, 'Boxdown SSH proxy', [
          `Workspace: ${context.workspaceFolder}`,
          `SSH alias: ${alias}`
        ], async () => {
          progress.setSteps(sshProxyProgressSteps())
          progress.startStep('ssh-alias')
          try {
            await installSshConfig(context, alias, { quiet: true })
            progress.completeStep('ssh-alias')
          } catch (error) {
            progress.failStep('ssh-alias')
            throw error
          }
          const startedContainerId = await startDevcontainer(context, {
            recreate: parsed.recreate,
            proxyMode: true,
            progress,
            logger,
            reuseRunning: true
          })
          await refreshContainerCodingAgentClis(context, true, [], { progress, logger })
          await ensureContainerSshRuntime(context, { progress, logger })
          return startedContainerId
        })
        return runSshdProxy(containerId, { logger })
      })
    }

    if (parsed.command === 'tunnel') {
      const resolvedTunnelPorts = await resolveTunnelPorts(parsed, context, options)

      if (resolvedTunnelPorts.cancelled) {
        process.stderr.write('Canceled tunnel.\n')
        return 1
      }

      const tunnelPorts = resolvedTunnelPorts.tunnelPorts
      if (tunnelPorts.length === 0) {
        throw new Error('tunnel requires at least one --port value')
      }

      writeWorkspaceMetadata(context, alias)
      return runLoggedLifecycle(context, 'tunnel', argv, async (logger) => {
        const progress = createCliProgress(parsed, 'stdout', { env: options.env })
        await withProgressSection(progress, 'Boxdown tunnel', [
          `Workspace: ${context.workspaceFolder}`,
          `SSH alias: ${alias}`
        ], async () => {
          progress.setSteps(tunnelProgressSteps())
          progress.startStep('ssh-alias')
          try {
            await installSshConfig(context, alias, { quiet: true })
            progress.completeStep('ssh-alias')
          } catch (error) {
            progress.failStep('ssh-alias')
            throw error
          }
          await startDevcontainer(context, {
            recreate: parsed.recreate,
            progress,
            logger,
            reuseRunning: true
          })
        })

        const forwards = tunnelPorts
          .map((port) => `127.0.0.1:${port.localPort} -> localhost:${port.remotePort}`)
          .join(', ')

        process.stdout.write(`Forwarding ${forwards}\n`)
        process.stdout.write('Press Ctrl-C to stop the tunnel.\n')

        return openSshTunnel(alias, tunnelPorts, { logger })
      })
    }

    if (parsed.command === 'refresh-gh-token-running') {
      return runLoggedLifecycle(context, 'refresh-gh-token-running', argv, async (logger) => {
        const containerId = await findRunningContainerId(context, { logger })
        if (containerId === undefined) {
          throw new Error(`No running devcontainer found for: ${context.workspaceFolder}`)
        }
        const progress = createCliProgress(parsed, 'stdout', { env: options.env })
        await withProgressSection(progress, 'Boxdown GitHub auth refresh', [
          `Workspace: ${context.workspaceFolder}`
        ], async () => {
          progress.setSteps(ghAuthProgressSteps(false))
          progress.startStep('devcontainer-running')
          progress.completeStep('devcontainer-running')
          await refreshContainerGhAuth(context, { progress, logger })
        })
        return 0
      })
    }

    if (parsed.command === 'refresh-gh-token') {
      return runLoggedLifecycle(context, 'refresh-gh-token', argv, async (logger) => {
        const progress = createCliProgress(parsed, 'stdout', { env: options.env })
        await withProgressSection(progress, 'Boxdown GitHub auth refresh', [
          `Workspace: ${context.workspaceFolder}`
        ], async () => {
          progress.setSteps(ghAuthProgressSteps(true))
          await startDevcontainer(context, { progress, logger })
          await refreshContainerGhAuth(context, { progress, logger })
        })
        return 0
      })
    }

    if (parsed.command === 'coding-agent') {
      const agent = parsed.agent
      if (agent === undefined) {
        throw new Error('Missing coding-agent command')
      }

      return runLoggedLifecycle(context, agent, argv, async (logger) => {
        const progress = createCliProgress(parsed, 'stdout', { env: options.env })
        await withProgressSection(progress, `Boxdown ${agent}`, [
          `Workspace: ${context.workspaceFolder}`
        ], async () => {
          progress.setSteps(codingAgentProgressSteps(agent))
          await startDevcontainer(context, {
            recreate: parsed.recreate,
            progress,
            logger
          })
          await ensureContainerCodingAgentCli(context, agent, { progress, logger })
        })
        return openCodingAgentCli(context, agent, parsed.agentArgs ?? [], { logger })
      })
    }

    return runLoggedLifecycle(context, 'start', argv, async (logger) => {
      const progress = createCliProgress(parsed, 'stdout', { env: options.env })
      const containerId = await withProgressSection(progress, 'Boxdown start', [
        `Workspace: ${context.workspaceFolder}`
      ], async () => {
        progress.setSteps(startProgressSteps())
        return await startDevcontainer(context, {
          recreate: parsed.recreate,
          progress,
          logger
        })
      })
      await printPortHint(context, containerId, { logger })
      return openShell(context, { logger })
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
