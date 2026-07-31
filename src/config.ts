import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, win32 } from 'node:path'

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
  BOXDOWN_CONTAINER_CODEX_DIR,
  BOXDOWN_CONTAINER_DEVCONTAINER_DIR,
  BOXDOWN_CONTAINER_GITCONFIG_PATH,
  BOXDOWN_CONTAINER_HOST_GITCONFIG_DIR,
  BOXDOWN_CONTAINER_SECRET_ENV_BOOTSTRAP,
  BOXDOWN_CONTAINER_SECRET_ENV_DIR,
  BOXDOWN_CONTAINER_SSH_DIR,
  BOXDOWN_CONTAINER_SSH_PUBLIC_KEY_PATH
} from './constants.ts'
import { DEFAULT_AGENT_PROFILE, isAgentProfile, type AgentProfile } from './agent-profile.ts'
import {
  isDevcontainerMount,
  mountConflictsWithDestination,
  mountTargetsDestination,
  type DevcontainerMount
} from './devcontainer-mount.ts'
import { parseJsonc } from './jsonc.ts'
import type { WorkspaceContext } from './paths.ts'
import type { GitSigningPlan } from './git-signing.ts'
import { shellQuote } from './shell.ts'

export interface DevcontainerConfig {
  name?: string
  mounts?: DevcontainerMount[]
  containerEnv?: Record<string, string>
  runArgs?: string[]
  initializeCommand?: string
  postCreateCommand?: string
  postStartCommand?: string
  [key: string]: unknown
}

export function readBaseDevcontainerConfig (assetsDevcontainerDir: string): DevcontainerConfig {
  const configPath = join(assetsDevcontainerDir, 'devcontainer.json')
  return parseJsonc<DevcontainerConfig>(readFileSync(configPath, 'utf8'))
}

function directoryExists (path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function fileExists (path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function hasMountConflict (mounts: DevcontainerMount[], destination: string): boolean {
  return mounts.some(mount => mountConflictsWithDestination(mount, destination))
}

export function sourcePathIsInside (path: string, directory: string): boolean {
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

interface AgentProfileSource {
  availability: string
  source: string
  stagingTarget: string
  canonicalDestination: string
  exists: () => boolean
}

function agentProfileSources (context: WorkspaceContext, profile: AgentProfile): AgentProfileSource[] {
  if (profile === 'none') return []

  const sources: AgentProfileSource[] = [
    {
      availability: 'agents',
      source: context.hostAgentsDir,
      stagingTarget: BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_AGENTS_DIR,
      canonicalDestination: BOXDOWN_CONTAINER_AGENTS_DIR,
      exists: () => directoryExists(context.hostAgentsDir)
    }
  ]

  if (profile === 'auth') {
    sources.push(
      {
        availability: 'codex-auth',
        source: context.hostCodexAuthPath,
        stagingTarget: BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CODEX_AUTH_PATH,
        canonicalDestination: BOXDOWN_CONTAINER_CODEX_AUTH_PATH,
        exists: () => fileExists(context.hostCodexAuthPath)
      },
      {
        availability: 'claude-auth',
        source: context.hostClaudeCredentialsPath ?? '',
        stagingTarget: BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CLAUDE_CREDENTIALS_PATH,
        canonicalDestination: BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH,
        exists: () => context.hostClaudeCredentialsPath !== undefined && fileExists(context.hostClaudeCredentialsPath)
      }
    )
  } else {
    sources.push(
      {
        availability: 'codex-home',
        source: context.hostCodexDir,
        stagingTarget: BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CODEX_DIR,
        canonicalDestination: BOXDOWN_CONTAINER_CODEX_DIR,
        exists: () => directoryExists(context.hostCodexDir)
      },
      {
        availability: 'claude-home',
        source: context.hostClaudeDir,
        stagingTarget: BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CLAUDE_DIR,
        canonicalDestination: BOXDOWN_CONTAINER_CLAUDE_DIR,
        exists: () => directoryExists(context.hostClaudeDir)
      },
      {
        availability: 'claude-config',
        source: context.hostClaudeConfigPath,
        stagingTarget: BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CLAUDE_CONFIG_PATH,
        canonicalDestination: BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH,
        exists: () => !sourcePathIsInside(context.hostClaudeConfigPath, context.hostClaudeDir) && fileExists(context.hostClaudeConfigPath)
      }
    )
  }

  return sources
}

export function buildGeneratedDevcontainerConfig (context: WorkspaceContext, signing?: GitSigningPlan, agentProfile: AgentProfile = DEFAULT_AGENT_PROFILE): DevcontainerConfig {
  const baseConfig = readBaseDevcontainerConfig(context.assetsDevcontainerDir)
  const mounts = Array.isArray(baseConfig.mounts)
    ? baseConfig.mounts
      .filter(isDevcontainerMount)
      .filter((mount) => !mountTargetsDestination(mount, BOXDOWN_CONTAINER_GITCONFIG_PATH))
    : []

  const boxdownMounts = [
    `type=bind,source=${context.assetsDevcontainerDir},target=${BOXDOWN_CONTAINER_DEVCONTAINER_DIR},readonly`,
    `type=bind,source=${context.sshPublicKeyRuntimeDir},target=${BOXDOWN_CONTAINER_SSH_DIR},readonly`,
    `type=bind,source=${context.hostGitconfigSnapshotDir},target=${BOXDOWN_CONTAINER_HOST_GITCONFIG_DIR},readonly`,
    `type=bind,source=${context.workspaceSecretEnvDir},target=${BOXDOWN_CONTAINER_SECRET_ENV_DIR},readonly`
  ]

  if (signing?.enabled === true && signing.agentSocketSource !== undefined) {
    boxdownMounts.push(`type=bind,source=${signing.agentSocketSource},target=/run/boxdown/ssh-agent.sock`)
    boxdownMounts.push(`type=bind,source=${context.gitSigningStateDir},target=/opt/boxdown/state/git-signing,readonly`)
  }

  const availableAgentProfileSources = agentProfileSources(context, agentProfile)
  const managedAgentProfileSources: string[] = []
  for (const source of availableAgentProfileSources) {
    if (!source.exists() || hasMountConflict(mounts, source.canonicalDestination)) continue

    const destination = agentProfile === 'full'
      ? source.canonicalDestination
      : source.stagingTarget
    const readOnly = agentProfile !== 'full' ? ',readonly' : ''
    boxdownMounts.push(
      `type=bind,source=${source.source},target=${destination}${readOnly}`
    )
    if (agentProfile === 'full') managedAgentProfileSources.push(source.availability)
  }

  return {
    ...baseConfig,
    name: `Boxdown: ${context.workspaceBasename}`,
    mounts: [...mounts, ...boxdownMounts],
    initializeCommand: [
      `BOXDOWN_WORKSPACE_FOLDER=${shellQuote(context.workspaceFolder)}`,
      `BOXDOWN_HOST_GITCONFIG_PATH=${shellQuote(context.hostGitconfigPath)}`,
      `BOXDOWN_HOST_GITCONFIG_SNAPSHOT_PATH=${shellQuote(context.hostGitconfigSnapshotPath)}`,
      `BOXDOWN_SECRET_ENV_DIR=${shellQuote(context.workspaceSecretEnvDir)}`,
      `BOXDOWN_AGENT_PROFILE=${shellQuote(agentProfile)}`,
      `BOXDOWN_PROGRESS=${shellQuote('${localEnv:BOXDOWN_PROGRESS}')}`,
      `BOXDOWN_VERBOSE=${shellQuote('${localEnv:BOXDOWN_VERBOSE}')}`,
      'bash',
      shellQuote(join(context.assetsDevcontainerDir, 'hooks', 'initialize.sh'))
    ].join(' '),
    postCreateCommand: [
      `BOXDOWN_PROGRESS=${shellQuote('${localEnv:BOXDOWN_PROGRESS}')}`,
      `BOXDOWN_VERBOSE=${shellQuote('${localEnv:BOXDOWN_VERBOSE}')}`,
      'bash',
      shellQuote(`${BOXDOWN_CONTAINER_DEVCONTAINER_DIR}/hooks/post-create.sh`)
    ].join(' '),
    postStartCommand: [
      `BOXDOWN_PROGRESS=${shellQuote('${localEnv:BOXDOWN_PROGRESS}')}`,
      `BOXDOWN_VERBOSE=${shellQuote('${localEnv:BOXDOWN_VERBOSE}')}`,
      'bash',
      shellQuote(`${BOXDOWN_CONTAINER_DEVCONTAINER_DIR}/hooks/post-start.sh`)
    ].join(' '),
    containerEnv: {
      ...(baseConfig.containerEnv ?? {}),
      BOXDOWN_CONTAINER_WORKSPACE_FOLDER: '/workspaces/${localWorkspaceFolderBasename}',
      BOXDOWN_WORKSPACE_BASENAME: '${localWorkspaceFolderBasename}',
      BOXDOWN_SECRET_ENV_DIR: BOXDOWN_CONTAINER_SECRET_ENV_DIR,
      BASH_ENV: BOXDOWN_CONTAINER_SECRET_ENV_BOOTSTRAP,
      DEVCONTAINER_SSH_PUBLIC_KEY_FILE: BOXDOWN_CONTAINER_SSH_PUBLIC_KEY_PATH,
      BOXDOWN_GIT_SIGNING_ENABLED: signing?.enabled === true ? '1' : '0',
      BOXDOWN_GIT_SIGNING_KEY_PATH: '/opt/boxdown/state/git-signing/signing-key.pub',
      BOXDOWN_AGENT_PROFILE: agentProfile,
      BOXDOWN_AGENT_PROFILE_SOURCES: availableAgentProfileSources
        .filter(source => source.exists())
        .map(source => source.availability)
        .sort()
        .join(','),
      BOXDOWN_AGENT_PROFILE_MANAGED_SOURCES: managedAgentProfileSources
        .sort()
        .join(','),
      ...(signing?.enabled === false && signing.reason !== undefined ? { BOXDOWN_GIT_SIGNING_REASON: signing.reason } : {}),
      ...(signing?.enabled === true
        ? {
            BOXDOWN_GIT_SIGNING_SOURCE_SOCKET: '/run/boxdown/ssh-agent.sock',
            SSH_AUTH_SOCK: '/run/boxdown/ssh-agent-node.sock'
          }
        : {})
    }
  }
}

export function writeGeneratedDevcontainerConfig (context: WorkspaceContext, signing?: GitSigningPlan, agentProfile?: AgentProfile): DevcontainerConfig {
  const config = buildGeneratedDevcontainerConfig(context, signing, agentProfile)
  mkdirSync(context.workspaceCacheDir, { recursive: true })
  writeFileSync(context.generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`)
  return config
}

export function agentProfileFromDevcontainerConfig (config: unknown): AgentProfile | undefined {
  if (typeof config !== 'object' || config === null) return undefined
  const containerEnv = (config as { containerEnv?: unknown }).containerEnv
  if (typeof containerEnv !== 'object' || containerEnv === null) return undefined
  const agentProfile = (containerEnv as { BOXDOWN_AGENT_PROFILE?: unknown }).BOXDOWN_AGENT_PROFILE
  return typeof agentProfile === 'string' && isAgentProfile(agentProfile) ? agentProfile : undefined
}

export function readGeneratedAgentProfile (context: WorkspaceContext): AgentProfile | undefined {
  try {
    return agentProfileFromDevcontainerConfig(parseJsonc<unknown>(readFileSync(context.generatedConfigPath, 'utf8')))
  } catch {
    return undefined
  }
}

export function publishContainerPortFromConfig (config: DevcontainerConfig): string | undefined {
  return config.runArgs?.find((arg) => /^[0-9.]+::[0-9]+$/.test(arg))?.split('::')[1]
}
