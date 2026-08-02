import { readFileSync, statSync } from 'node:fs'
import { relative, win32 } from 'node:path'

import {
  BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_AGENTS_DIR,
  BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CLAUDE_CONFIG_PATH,
  BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CLAUDE_CREDENTIALS_PATH,
  BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CLAUDE_DIR,
  BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CODEX_AUTH_PATH,
  BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CODEX_DIR,
  BOXDOWN_CONTAINER_AGENTS_DIR,
  BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH,
  BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH,
  BOXDOWN_CONTAINER_CLAUDE_DIR,
  BOXDOWN_CONTAINER_CODEX_AUTH_PATH,
  BOXDOWN_CONTAINER_CODEX_DIR
} from './constants.ts'
import { agentProfileAccessText, isAgentProfile, resolveAgentProfile, type AgentProfile, type AgentProfileSelection, type AgentProfileSelectionSource, type ContainerAgentProfile } from './agent-profile.ts'
import {
  classifyPosixPath,
  inspectDevcontainerMount,
  posixPathsConflict
} from './devcontainer-mount.ts'
import { parseJsonc } from './jsonc.ts'
import type { ClaudeCredentialsSupport, WorkspaceContext } from './paths.ts'
import { buildSshConfigBlock, defaultSshConfigPath } from './ssh-config.ts'
import { readGeneratedToolchainPlanMount, readGeneratedToolchainResultMount } from './config.ts'
import { readToolchainPlan, readToolchainResult } from './toolchains/plan.ts'
import { TOOLCHAIN_DEFAULTS } from './toolchains/defaults.ts'
import { TOOLCHAIN_IDS, type ResolvedToolchain, type ToolchainPlan, type ToolchainResult } from './toolchains/types.ts'

export type SshAliasSource = 'default' | 'provided'
export type SshManagedBlockState = 'missing' | 'installed' | 'outdated'
export type AgentProfileSourceState = 'available' | 'missing' | 'unsupported' | 'custom' | 'not-selected'
export type ContainerProfileState = 'active' | 'recreate-required' | 'not-created' | 'unknown'

export interface AgentProfileStatus {
  selected: AgentProfile
  selectionSource: AgentProfileSelectionSource
  access: string
  generated?: AgentProfile
  container?: AgentProfile
  containerState: ContainerProfileState
  sources: {
    codexAuthentication: AgentProfileSourceState
    claudeAuthentication: AgentProfileSourceState
    agents: AgentProfileSourceState
    codexHome: AgentProfileSourceState
    claudeHome: AgentProfileSourceState
    claudeConfig: AgentProfileSourceState
  }
  customDestinations: string[]
}

export interface ContainerSummary {
  id: string
  name?: string
  state?: string
  status?: string
  localFolder?: string
}

export interface ToolchainStatus {
  plan?: ToolchainPlan
  result?: ToolchainResult
  containerState: 'active' | 'disabled' | 'recreate-required' | 'not-selected'
}

export interface StatusInfo {
  workspace: {
    folder: string
    basename: string
    id: string
  }
  ssh: {
    alias: string
    aliasSource: SshAliasSource
    configPath: string
    configExists: boolean
    managedBlockState: SshManagedBlockState
    keyPath: string
    keyExists: boolean
    publicKeyPath: string
    publicKeyExists: boolean
    publicKeyRuntimePath: string
    publicKeyRuntimeExists: boolean
  }
  paths: {
    cacheRoot: string
    dataRoot: string
    workspaceCacheDir: string
    workspaceDataDir: string
    generatedConfigPath: string
    generatedConfigExists: boolean
    logPath: string
    logExists: boolean
    assetsDevcontainerDir: string
    assetsDevcontainerExists: boolean
  }
  agentProfile: AgentProfileStatus
  toolchains: ToolchainStatus
  container: {
    found: boolean
    running: boolean
    id?: string
    name?: string
    state?: string
    status?: string
  }
}

const statusClaudeCredentialsSupport = new WeakMap<StatusInfo, ClaudeCredentialsSupport>()

export interface SshConfigStatus {
  configPath: string
  configExists: boolean
  managedBlockState: SshManagedBlockState
}

interface DockerPsJson {
  ID?: unknown
  Names?: unknown
  State?: unknown
  Status?: unknown
  Labels?: unknown
}

function dockerLabelsFromString (labels: string): Record<string, string> {
  return Object.fromEntries(labels
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0)
    .map((label) => {
      const separator = label.indexOf('=')
      return separator === -1 ? [label, ''] : [label.slice(0, separator), label.slice(separator + 1)]
    }))
}

export function parseDockerPsJsonLines (output: string): ContainerSummary[] {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0)

  return lines.map((line) => {
    let parsed: DockerPsJson

    try {
      parsed = JSON.parse(line) as DockerPsJson
    } catch {
      throw new Error(`Could not parse docker ps output: ${line}`)
    }

    if (typeof parsed.ID !== 'string' || parsed.ID.length === 0) {
      throw new Error(`Docker ps output is missing container ID: ${line}`)
    }

    return {
      id: parsed.ID,
      name: typeof parsed.Names === 'string' && parsed.Names.length > 0 ? parsed.Names : undefined,
      state: typeof parsed.State === 'string' && parsed.State.length > 0 ? parsed.State : undefined,
      status: typeof parsed.Status === 'string' && parsed.Status.length > 0 ? parsed.Status : undefined,
      localFolder: typeof parsed.Labels === 'string' ? dockerLabelsFromString(parsed.Labels)['devcontainer.local_folder'] : undefined
    }
  })
}

function readFileUtf8 (path: string): string {
  return readFileSync(path, 'utf8')
}

function isRegularFile (path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory (path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const agentProfileSourceNames = [
  'agents',
  'codex-auth',
  'claude-auth',
  'codex-home',
  'claude-home',
  'claude-config'
] as const

type AgentProfileSourceName = typeof agentProfileSourceNames[number]

const canonicalAgentProfileDestinations = [
  BOXDOWN_CONTAINER_AGENTS_DIR,
  BOXDOWN_CONTAINER_CODEX_DIR,
  BOXDOWN_CONTAINER_CODEX_AUTH_PATH,
  BOXDOWN_CONTAINER_CLAUDE_DIR,
  BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH,
  BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH
] as const

const canonicalTopLevelAgentProfileDestinations = [
  BOXDOWN_CONTAINER_AGENTS_DIR,
  BOXDOWN_CONTAINER_CODEX_DIR,
  BOXDOWN_CONTAINER_CLAUDE_DIR,
  BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH
] as const

interface GeneratedAgentProfileInfo {
  profile?: AgentProfile
  sources: Set<AgentProfileSourceName>
  managedSources: Set<AgentProfileSourceName>
  stagingTargets: Set<string>
  mountTargets: Set<string>
  mountDestinationIndeterminate: boolean
  customDestinations: string[]
}

function mountFieldValue (mount: unknown, aliases: readonly string[]): string | undefined {
  let fields: Array<[string, unknown]>

  if (typeof mount === 'string') {
    if (/["\r\n\0]/.test(mount) || mount.includes('${')) return undefined
    fields = mount.split(',').flatMap((field) => {
      const separator = field.indexOf('=')
      return separator === -1
        ? []
        : [[field.slice(0, separator).trim().toLowerCase(), field.slice(separator + 1)]]
    })
  } else if (typeof mount === 'object' && mount !== null && !Array.isArray(mount)) {
    fields = Object.entries(mount).map(([key, value]) => [key.toLowerCase(), value])
  } else {
    return undefined
  }

  const values = fields
    .filter(([key]) => aliases.includes(key))
    .map(([, value]) => value)
  if (values.length !== 1 || typeof values[0] !== 'string') return undefined

  const value = values[0].trim()
  return value.length > 0 && !/[\r\n\0]/.test(value) && !value.includes('${')
    ? value
    : undefined
}

function mountIsReadWrite (mount: unknown): boolean {
  const readOnlyAliases = new Set(['readonly', 'ro'])
  const readWriteAliases = new Set(['rw'])
  const parseBoolean = (value: unknown): boolean | undefined => {
    if (value === true || value === 'true' || value === '1') return true
    if (value === false || value === 'false' || value === '0') return false
    return undefined
  }
  const modes: Array<{ key: string, value: unknown }> = []

  if (typeof mount === 'string') {
    if (/["\r\n\0]/.test(mount) || mount.includes('${')) return false

    for (const field of mount.split(',')) {
      const separator = field.indexOf('=')
      if (separator === -1) {
        modes.push({ key: field.trim().toLowerCase(), value: true })
      } else {
        modes.push({
          key: field.slice(0, separator).trim().toLowerCase(),
          value: field.slice(separator + 1).trim().toLowerCase()
        })
      }
    }
  } else if (typeof mount === 'object' && mount !== null && !Array.isArray(mount)) {
    modes.push(...Object.entries(mount).map(([key, value]) => ({ key: key.toLowerCase(), value })))
  } else {
    return false
  }

  for (const { key, value } of modes) {
    if (!readOnlyAliases.has(key) && !readWriteAliases.has(key)) continue

    const enabled = parseBoolean(value)
    if (enabled === undefined || (readOnlyAliases.has(key) ? enabled : !enabled)) return false
  }

  return true
}

function managedFullMountDestination (
  context: WorkspaceContext,
  profile: AgentProfile | undefined,
  managedSources: Set<AgentProfileSourceName>,
  mount: unknown,
  destinations: string[],
  destinationIndeterminate: boolean
): string | undefined {
  if (
    profile !== 'full' ||
    destinationIndeterminate ||
    destinations.length !== 1 ||
    mountFieldValue(mount, ['type'])?.toLowerCase() !== 'bind' ||
    !mountIsReadWrite(mount)
  ) {
    return undefined
  }

  const destination = destinations[0]
  if (destination === undefined) return undefined
  const source = mountFieldValue(mount, ['source', 'src'])
  const managedMounts = new Map<string, { name: AgentProfileSourceName, source: string }>([
    [BOXDOWN_CONTAINER_AGENTS_DIR, { name: 'agents', source: context.hostAgentsDir }],
    [BOXDOWN_CONTAINER_CODEX_DIR, { name: 'codex-home', source: context.hostCodexDir }],
    [BOXDOWN_CONTAINER_CLAUDE_DIR, { name: 'claude-home', source: context.hostClaudeDir }],
    [BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH, { name: 'claude-config', source: context.hostClaudeConfigPath }]
  ])
  const managedMount = managedMounts.get(destination)

  return managedMount !== undefined &&
    managedSources.has(managedMount.name) &&
    source === managedMount.source
    ? destination
    : undefined
}

function parseAgentProfileSourceNames (value: unknown): Set<AgentProfileSourceName> {
  const sources = new Set<AgentProfileSourceName>()

  if (typeof value !== 'string') return sources

  for (const source of value.split(',').map(value => value.trim())) {
    if (agentProfileSourceNames.includes(source as AgentProfileSourceName)) {
      sources.add(source as AgentProfileSourceName)
    }
  }

  return sources
}

function normalizedCustomDestinations (targets: string[]): string[] {
  const destinations = new Set<string>()

  for (const target of targets) {
    const exactDestination = canonicalAgentProfileDestinations
      .find(destination => classifyPosixPath(target, destination) === 'exact')
    if (exactDestination !== undefined) {
      destinations.add(exactDestination)
      continue
    }

    const containingDestinations = canonicalAgentProfileDestinations
      .filter(destination => classifyPosixPath(target, destination) === 'descendant')
      .sort((left, right) => right.length - left.length)

    if (containingDestinations[0] !== undefined) {
      destinations.add(containingDestinations[0])
      continue
    }

    const containedDestinations = canonicalAgentProfileDestinations
      .filter(destination => classifyPosixPath(target, destination) === 'ancestor')
      .filter(destination => !canonicalAgentProfileDestinations.some(parent =>
        parent !== destination &&
        classifyPosixPath(destination, parent) === 'descendant' &&
        classifyPosixPath(target, parent) === 'ancestor'
      ))

    for (const destination of containedDestinations) {
      destinations.add(destination)
    }
  }

  return [...destinations].sort()
}

function inspectGeneratedAgentProfile (
  context: WorkspaceContext,
  path: string,
  readFile: (path: string) => string
): GeneratedAgentProfileInfo {
  const empty: GeneratedAgentProfileInfo = {
    sources: new Set(),
    managedSources: new Set(),
    stagingTargets: new Set(),
    mountTargets: new Set(),
    mountDestinationIndeterminate: false,
    customDestinations: []
  }

  let parsed: unknown

  try {
    parsed = parseJsonc<unknown>(readFile(path))
  } catch {
    return empty
  }

  if (typeof parsed !== 'object' || parsed === null) return empty

  const config = parsed as { containerEnv?: unknown, mounts?: unknown }
  const containerEnv = typeof config.containerEnv === 'object' && config.containerEnv !== null
    ? config.containerEnv as Record<string, unknown>
    : {}
  const profileValue = containerEnv.BOXDOWN_AGENT_PROFILE
  const profile = typeof profileValue === 'string' && isAgentProfile(profileValue) ? profileValue : undefined
  const sources = parseAgentProfileSourceNames(containerEnv.BOXDOWN_AGENT_PROFILE_SOURCES)
  const managedSources = parseAgentProfileSourceNames(containerEnv.BOXDOWN_AGENT_PROFILE_MANAGED_SOURCES)

  const mountPolicies = Array.isArray(config.mounts)
    ? config.mounts
      .map(mount => ({ mount, policy: inspectDevcontainerMount(mount) }))
    : []
  const targets = mountPolicies.flatMap(({ policy }) => policy.destinations)
  const customTargets = mountPolicies.flatMap(({ mount, policy }) =>
    managedFullMountDestination(
      context,
      profile,
      managedSources,
      mount,
      policy.destinations,
      policy.destinationIndeterminate
    ) === undefined
      ? policy.destinations
      : []
  )
  const mountDestinationIndeterminate = mountPolicies
    .some(({ policy }) => policy.destinationIndeterminate)

  return {
    profile,
    sources,
    managedSources,
    stagingTargets: new Set(targets),
    mountTargets: new Set(customTargets),
    mountDestinationIndeterminate,
    customDestinations: mountDestinationIndeterminate
      ? [...canonicalTopLevelAgentProfileDestinations].sort()
      : normalizedCustomDestinations(customTargets)
  }
}

function sourceIsCustom (generated: GeneratedAgentProfileInfo, destination: string): boolean {
  return generated.mountDestinationIndeterminate ||
    [...generated.mountTargets].some(target => posixPathsConflict(target, destination))
}

function generatedSourceState (
  generated: GeneratedAgentProfileInfo,
  source: AgentProfileSourceName,
  stagingTarget: string,
  destination: string
): AgentProfileSourceState {
  if (sourceIsCustom(generated, destination)) return 'custom'
  const expectedTarget = generated.profile === 'full' ? destination : stagingTarget
  return generated.sources.has(source) && generated.stagingTargets.has(expectedTarget)
    ? 'available'
    : 'missing'
}

function pathIsInside (path: string, directory: string): boolean {
  const pathApi = path.includes('\\') || directory.includes('\\')
    ? win32
    : { relative, isAbsolute: (candidate: string) => candidate.startsWith('/'), sep: '/' }
  const pathRelative = pathApi.relative(directory, path)

  return pathRelative === '' || (
    pathRelative !== '..' &&
    !pathRelative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(pathRelative)
  )
}

function notSelectedSources (): AgentProfileStatus['sources'] {
  return {
    codexAuthentication: 'not-selected',
    claudeAuthentication: 'not-selected',
    agents: 'not-selected',
    codexHome: 'not-selected',
    claudeHome: 'not-selected',
    claudeConfig: 'not-selected'
  }
}

function inspectGeneratedSources (
  context: WorkspaceContext,
  selected: AgentProfile,
  generated: GeneratedAgentProfileInfo
): AgentProfileStatus['sources'] {
  const sources = notSelectedSources()
  if (selected === 'none') return sources

  sources.agents = generatedSourceState(
    generated,
    'agents',
    BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_AGENTS_DIR,
    BOXDOWN_CONTAINER_AGENTS_DIR
  )

  if (selected === 'auth') {
    sources.codexAuthentication = generatedSourceState(
      generated,
      'codex-auth',
      BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CODEX_AUTH_PATH,
      BOXDOWN_CONTAINER_CODEX_AUTH_PATH
    )
    sources.claudeAuthentication = sourceIsCustom(generated, BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH)
      ? 'custom'
      : context.claudeCredentialsSupport === 'file'
        ? generatedSourceState(
          generated,
          'claude-auth',
          BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CLAUDE_CREDENTIALS_PATH,
          BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH
        )
        : 'unsupported'
    return sources
  }

  sources.codexHome = generatedSourceState(
    generated,
    'codex-home',
    BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CODEX_DIR,
    BOXDOWN_CONTAINER_CODEX_DIR
  )
  sources.claudeHome = generatedSourceState(
    generated,
    'claude-home',
    BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CLAUDE_DIR,
    BOXDOWN_CONTAINER_CLAUDE_DIR
  )
  sources.claudeConfig = pathIsInside(context.hostClaudeConfigPath, context.hostClaudeDir)
    ? sources.claudeHome
    : sourceIsCustom(generated, BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH)
      ? 'custom'
      : generatedSourceState(
        generated,
        'claude-config',
        BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CLAUDE_CONFIG_PATH,
        BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH
      )
  sources.codexAuthentication = sources.codexHome
  sources.claudeAuthentication = sourceIsCustom(generated, BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH)
    ? 'custom'
    : context.claudeCredentialsSupport === 'file'
      ? sources.claudeHome
      : 'unsupported'

  return sources
}

function inspectCurrentSources (
  context: WorkspaceContext,
  selected: AgentProfile,
  generated: GeneratedAgentProfileInfo,
  isFile: (path: string) => boolean,
  isDirectoryPath: (path: string) => boolean
): AgentProfileStatus['sources'] {
  const sources = notSelectedSources()
  if (selected === 'none') return sources

  sources.codexAuthentication = sourceIsCustom(generated, BOXDOWN_CONTAINER_CODEX_AUTH_PATH)
    ? 'custom'
    : isFile(context.hostCodexAuthPath) ? 'available' : 'missing'
  sources.claudeAuthentication = sourceIsCustom(generated, BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH)
    ? 'custom'
    : context.claudeCredentialsSupport !== 'file'
      ? 'unsupported'
      : context.hostClaudeCredentialsPath !== undefined && isFile(context.hostClaudeCredentialsPath)
        ? 'available'
        : 'missing'
  sources.agents = sourceIsCustom(generated, BOXDOWN_CONTAINER_AGENTS_DIR)
    ? 'custom'
    : isDirectoryPath(context.hostAgentsDir) ? 'available' : 'missing'

  if (selected === 'auth') return sources

  sources.codexHome = sourceIsCustom(generated, BOXDOWN_CONTAINER_CODEX_DIR)
    ? 'custom'
    : isDirectoryPath(context.hostCodexDir) ? 'available' : 'missing'
  sources.claudeHome = sourceIsCustom(generated, BOXDOWN_CONTAINER_CLAUDE_DIR)
    ? 'custom'
    : isDirectoryPath(context.hostClaudeDir) ? 'available' : 'missing'
  sources.claudeConfig = pathIsInside(context.hostClaudeConfigPath, context.hostClaudeDir)
    ? sources.claudeHome
    : sourceIsCustom(generated, BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH)
      ? 'custom'
      : isFile(context.hostClaudeConfigPath) ? 'available' : 'missing'

  return sources
}

export function containerProfileMatches (
  inspected: ContainerAgentProfile | undefined,
  selected: AgentProfile
): boolean {
  const expectedMode = selected === 'full' ? 'live' : 'copy'
  return inspected?.profile === selected && inspected.mode === expectedMode
}

function containerProfileState (
  selected: AgentProfile,
  generated: AgentProfile | undefined,
  container: ContainerSummary | undefined,
  containerAgentProfile: ContainerAgentProfile | undefined
): ContainerProfileState {
  if (container === undefined) return 'not-created'

  if (
    (generated !== undefined && generated !== selected) ||
    (containerAgentProfile !== undefined && !containerProfileMatches(containerAgentProfile, selected))
  ) {
    return 'recreate-required'
  }

  return container.state?.toLowerCase() === 'running' &&
    generated === selected &&
    containerProfileMatches(containerAgentProfile, selected)
    ? 'active'
    : 'unknown'
}

function readStatusToolchains (context: WorkspaceContext): {plan?: ToolchainPlan, result?: ToolchainResult} {
  let plan: ToolchainPlan | undefined
  let result: ToolchainResult | undefined

  try {
    plan = readToolchainPlan(context)
  } catch {
    // Status must remain available when Boxdown-owned state is malformed or unreadable.
  }

  try {
    result = readToolchainResult(context)
  } catch {
    // Status must remain available when Boxdown-owned state is malformed or unreadable.
  }

  return {plan, result}
}

function toolchainContainerState (
  context: WorkspaceContext,
  plan: ToolchainPlan | undefined,
  result: ToolchainResult | undefined,
  container: ContainerSummary | undefined
): ToolchainStatus['containerState'] {
  if (plan === undefined) return 'not-selected'
  if (plan.selected.length === 0) return 'disabled'

  if (container !== undefined && (
    !readGeneratedToolchainPlanMount(context) ||
    !readGeneratedToolchainResultMount(context) ||
    result?.fingerprint !== plan.fingerprint
  )) {
    return 'recreate-required'
  }

  return 'active'
}

function managedSshBlockMarkers (alias: string): { begin: string, end: string } {
  return {
    begin: `# BEGIN ${alias} boxdown devcontainer ssh`,
    end: `# END ${alias} boxdown devcontainer ssh`
  }
}

function findManagedSshConfigBlock (config: string, alias: string): string | undefined {
  const { begin, end } = managedSshBlockMarkers(alias)
  const beginIndex = config.indexOf(begin)

  if (beginIndex === -1) {
    return undefined
  }

  const endIndex = config.indexOf(end, beginIndex)

  if (endIndex === -1) {
    return ''
  }

  const afterEndMarkerIndex = endIndex + end.length
  const afterEndLineIndex = config[afterEndMarkerIndex] === '\n' ? afterEndMarkerIndex + 1 : afterEndMarkerIndex

  return config.slice(beginIndex, afterEndLineIndex)
}

export function inspectSshConfigStatus (
  context: WorkspaceContext,
  alias: string,
  configPath: string,
  exists: (path: string) => boolean,
  readFile: (path: string) => string = readFileUtf8
): SshConfigStatus {
  const configExists = exists(configPath)

  if (!configExists) {
    return {
      configPath,
      configExists,
      managedBlockState: 'missing'
    }
  }

  const config = readFile(configPath)
  const managedBlock = findManagedSshConfigBlock(config, alias)

  if (managedBlock === undefined) {
    return {
      configPath,
      configExists,
      managedBlockState: 'missing'
    }
  }

  return {
    configPath,
    configExists,
    managedBlockState: managedBlock === buildSshConfigBlock(context, alias) ? 'installed' : 'outdated'
  }
}

export function createStatusInfo (
  context: WorkspaceContext,
  alias: string,
  container: ContainerSummary | undefined,
  exists: (path: string) => boolean,
  options: {
    aliasSource?: SshAliasSource
    sshConfigPath?: string
    readFile?: (path: string) => string
    isFile?: (path: string) => boolean
    isDirectory?: (path: string) => boolean
    agentProfileSelection?: AgentProfileSelection
    containerAgentProfile?: ContainerAgentProfile
  } = {}
): StatusInfo {
  const state = container?.state?.toLowerCase()
  const readFile = options.readFile ?? readFileUtf8
  const sshConfig = inspectSshConfigStatus(
    context,
    alias,
    options.sshConfigPath ?? defaultSshConfigPath(),
    exists,
    readFile
  )
  const selection = options.agentProfileSelection ?? resolveAgentProfile(undefined, undefined)
  const generatedInfo = inspectGeneratedAgentProfile(context, context.generatedConfigPath, readFile)
  const generatedMatchesSelection = generatedInfo.profile === selection.value
  const sources = generatedMatchesSelection
    ? inspectGeneratedSources(context, selection.value, generatedInfo)
    : inspectCurrentSources(
      context,
      selection.value,
      generatedInfo,
      options.isFile ?? isRegularFile,
      options.isDirectory ?? isDirectory
    )
  const profileState = containerProfileState(
    selection.value,
    generatedInfo.profile,
    container,
    options.containerAgentProfile
  )
  const toolchainRecords = readStatusToolchains(context)
  const toolchainState = toolchainContainerState(
    context,
    toolchainRecords.plan,
    toolchainRecords.result,
    container
  )

  const status: StatusInfo = {
    workspace: {
      folder: context.workspaceFolder,
      basename: context.workspaceBasename,
      id: context.workspaceId
    },
    ssh: {
      alias,
      aliasSource: options.aliasSource ?? 'provided',
      configPath: sshConfig.configPath,
      configExists: sshConfig.configExists,
      managedBlockState: sshConfig.managedBlockState,
      keyPath: context.sshKeyPath,
      keyExists: exists(context.sshKeyPath),
      publicKeyPath: context.sshPublicKeyPath,
      publicKeyExists: exists(context.sshPublicKeyPath),
      publicKeyRuntimePath: context.sshPublicKeyRuntimePath,
      publicKeyRuntimeExists: exists(context.sshPublicKeyRuntimePath)
    },
    paths: {
      cacheRoot: context.cacheRoot,
      dataRoot: context.dataRoot,
      workspaceCacheDir: context.workspaceCacheDir,
      workspaceDataDir: context.workspaceDataDir,
      generatedConfigPath: context.generatedConfigPath,
      generatedConfigExists: exists(context.generatedConfigPath),
      logPath: context.workspaceLogPath,
      logExists: exists(context.workspaceLogPath),
      assetsDevcontainerDir: context.assetsDevcontainerDir,
      assetsDevcontainerExists: exists(context.assetsDevcontainerDir)
    },
    agentProfile: {
      selected: selection.value,
      selectionSource: selection.source,
      access: agentProfileAccessText(selection.value),
      ...(generatedInfo.profile === undefined ? {} : { generated: generatedInfo.profile }),
      ...(options.containerAgentProfile === undefined ? {} : { container: options.containerAgentProfile.profile }),
      containerState: profileState,
      sources,
      customDestinations: generatedInfo.customDestinations
    },
    toolchains: {
      ...(toolchainRecords.plan === undefined ? {} : {plan: toolchainRecords.plan}),
      ...(toolchainRecords.result === undefined ? {} : {result: toolchainRecords.result}),
      containerState: toolchainState
    },
    container: {
      found: container !== undefined,
      running: state === 'running',
      id: container?.id,
      name: container?.name,
      state: container?.state,
      status: container?.status
    }
  }

  statusClaudeCredentialsSupport.set(status, context.claudeCredentialsSupport)
  return status
}

export function statusIsHealthy (status: StatusInfo): boolean {
  return status.paths.generatedConfigExists &&
    status.paths.assetsDevcontainerExists &&
    status.ssh.keyExists &&
    status.ssh.publicKeyExists &&
    status.ssh.publicKeyRuntimeExists &&
    status.container.found &&
    status.container.running &&
    status.agentProfile.containerState !== 'recreate-required' &&
    status.toolchains.containerState !== 'recreate-required'
}

const color = {
  green: '\u001B[32m',
  red: '\u001B[31m',
  reset: '\u001B[0m'
}

function colorize (value: string, colorName: 'green' | 'red', enabled: boolean): string {
  if (!enabled) {
    return value
  }

  return `${color[colorName]}${value}${color.reset}`
}

function existenceText (value: boolean, colorEnabled: boolean): string {
  return colorize(value ? 'exists' : 'missing', value ? 'green' : 'red', colorEnabled)
}

function runningText (value: boolean, colorEnabled: boolean): string {
  return colorize(value ? 'yes' : 'no', value ? 'green' : 'red', colorEnabled)
}

function managedBlockText (state: SshManagedBlockState, colorEnabled: boolean): string {
  return colorize(state, state === 'installed' ? 'green' : 'red', colorEnabled)
}

function aliasSourceText (source: SshAliasSource): string {
  return source === 'default' ? 'computed default' : 'provided'
}

function installedText (state: SshManagedBlockState): string {
  return state === 'installed' ? 'installed' : 'not installed'
}

function stateText (state: string, healthy: boolean, colorEnabled: boolean): string {
  return colorize(state, healthy ? 'green' : 'red', colorEnabled)
}

function profileSelectionSourceText (source: AgentProfileSelectionSource): string {
  if (source === 'metadata') return 'workspace metadata'
  return source
}

function agentProfileSourceText (
  state: AgentProfileSourceState,
  claudeCredentialsSupport?: ClaudeCredentialsSupport
): string {
  if (state === 'unsupported') {
    return claudeCredentialsSupport === 'macos-keychain'
      ? 'unavailable (macOS Keychain is not copied)'
      : 'unavailable (this host platform does not have a supported file-backed credential path)'
  }
  if (state === 'not-selected') return 'not selected'
  return state
}

function containerProfileText (state: ContainerProfileState): string {
  if (state === 'recreate-required') return 'recreate required'
  if (state === 'not-created') return 'not created'
  return state
}

function toolchainSourceText (toolchain: ResolvedToolchain): string {
  const selectionSource = toolchain.selectionSource === 'cli'
    ? 'CLI'
    : toolchain.selectionSource === 'interactive'
      ? 'interactive'
      : 'persisted'

  if (toolchain.resolutionSource === 'override') return `${selectionSource} override`
  if (toolchain.resolutionSource === 'project') return `${selectionSource} project`
  return `${selectionSource} Boxdown default`
}

function toolchainStatusLines (status: ToolchainStatus): string[] {
  if (status.plan === undefined) {
    return [
      'Toolchains: not selected',
      ...(status.result === undefined ? [] : [`  Last sync: ${status.result.state}`]),
      `  Container state: ${status.containerState}`
    ]
  }

  if (status.plan.selected.length === 0) {
    return [
      'Toolchains: disabled',
      ...(status.result === undefined ? [] : [`  Last sync: ${status.result.state}`]),
      `  Container state: ${status.containerState}`
    ]
  }

  const selected = [...status.plan.selected]
    .sort((left, right) => TOOLCHAIN_IDS.indexOf(left.id) - TOOLCHAIN_IDS.indexOf(right.id))
  const lines = selected.flatMap((toolchain, index) => [
    `${index === 0 ? 'Toolchains: ' : '  '}${TOOLCHAIN_DEFAULTS[toolchain.id].label} ${toolchain.version} (${toolchainSourceText(toolchain)})`,
    ...(toolchain.compatibilityNote === undefined
      ? []
      : [`${index === 0 ? '  ' : '    '}${toolchain.compatibilityNote}`])
  ])

  lines.push(
    `  Last sync: ${status.result?.state ?? 'not recorded'}`,
    `  Container state: ${status.containerState}`
  )

  if (status.containerState === 'recreate-required') {
    lines.push('  Run `boxdown start --recreate`.')
  }

  return lines
}

export function formatStatusText (status: StatusInfo, options: { color?: boolean } = {}): string {
  const colorEnabled = options.color ?? false
  const containerState = status.container.found ? status.container.state ?? 'unknown' : 'absent'
  const healthy = statusIsHealthy(status)
  const profile = status.agentProfile
  const toolchainLines = toolchainStatusLines(status.toolchains)
  const agentProfileLines = [
    `Agent profile: ${profile.selected} (${profileSelectionSourceText(profile.selectionSource)})`,
    `  Codex authentication: ${agentProfileSourceText(profile.sources.codexAuthentication)}`,
    `  Claude authentication: ${agentProfileSourceText(
      profile.sources.claudeAuthentication,
      statusClaudeCredentialsSupport.get(status)
    )}`,
    `  ~/.agents: ${agentProfileSourceText(profile.sources.agents)}`,
    `  Codex home: ${agentProfileSourceText(profile.sources.codexHome)}`,
    `  Claude home: ${agentProfileSourceText(profile.sources.claudeHome)}`,
    `  ~/.claude.json: ${agentProfileSourceText(profile.sources.claudeConfig)}`,
    `  Profile access: ${profile.access}`,
    `  Container profile: ${containerProfileText(profile.containerState)}`
  ]

  if (profile.customDestinations.length > 0) {
    agentProfileLines.push(`  Custom destinations: ${profile.customDestinations.join(', ')}`)
  }

  if (profile.containerState === 'recreate-required') {
    agentProfileLines.push(`  Run \`boxdown start --recreate --agent-profile ${profile.selected}\`.`)
  }

  const lines = [
    'Boxdown status',
    '',
    'Workspace:',
    `  Path: ${status.workspace.folder}`,
    `  Name: ${status.workspace.basename}`,
    `  ID: ${status.workspace.id}`,
    `  SSH alias: ${status.ssh.alias} (${aliasSourceText(status.ssh.aliasSource)}; ${installedText(status.ssh.managedBlockState)})`,
    '',
    'Paths:',
    `  Cache root: ${status.paths.cacheRoot}`,
    `  Data root: ${status.paths.dataRoot}`,
    `  Workspace cache: ${status.paths.workspaceCacheDir}`,
    `  Workspace data: ${status.paths.workspaceDataDir}`,
    `  Generated config: ${status.paths.generatedConfigPath} (${existenceText(status.paths.generatedConfigExists, colorEnabled)})`,
    `  Command log: ${status.paths.logPath} (${existenceText(status.paths.logExists, colorEnabled)})`,
    `  Devcontainer assets: ${status.paths.assetsDevcontainerDir} (${existenceText(status.paths.assetsDevcontainerExists, colorEnabled)})`,
    '',
    ...agentProfileLines,
    '',
    ...toolchainLines,
    '',
    'SSH:',
    `  SSH config: ${status.ssh.configPath} (${existenceText(status.ssh.configExists, colorEnabled)})`,
    `  Boxdown SSH block: ${managedBlockText(status.ssh.managedBlockState, colorEnabled)}`,
    `  Private key: ${status.ssh.keyPath} (${existenceText(status.ssh.keyExists, colorEnabled)})`,
    `  Public key: ${status.ssh.publicKeyPath} (${existenceText(status.ssh.publicKeyExists, colorEnabled)})`,
    `  Runtime public key: ${status.ssh.publicKeyRuntimePath} (${existenceText(status.ssh.publicKeyRuntimeExists, colorEnabled)})`,
    '',
    'Container:',
    `  State: ${stateText(containerState, healthy, colorEnabled)}`,
    `  Running: ${runningText(status.container.running, colorEnabled)}`
  ]

  if (status.container.id !== undefined) {
    lines.push(`  ID: ${status.container.id}`)
  }

  if (status.container.name !== undefined) {
    lines.push(`  Name: ${status.container.name}`)
  }

  if (status.container.status !== undefined) {
    lines.push(`  Docker status: ${status.container.status}`)
  }

  return `${lines.join('\n')}\n`
}
