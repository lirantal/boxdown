import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BOXDOWN_CONTAINER_AGENTS_DIR,
  BOXDOWN_CONTAINER_CODEX_AUTH_PATH,
  BOXDOWN_CONTAINER_CODEX_DIR,
  BOXDOWN_CONTAINER_DEVCONTAINER_DIR,
  BOXDOWN_CONTAINER_GITCONFIG_PATH,
  BOXDOWN_CONTAINER_HOST_GITCONFIG_DIR,
  BOXDOWN_CONTAINER_SSH_DIR,
  BOXDOWN_CONTAINER_SSH_PUBLIC_KEY_PATH
} from './constants.ts'
import { parseJsonc } from './jsonc.ts'
import type { WorkspaceContext } from './paths.ts'
import type { GitSigningPlan } from './git-signing.ts'
import { shellQuote } from './shell.ts'

export interface DevcontainerConfig {
  name?: string
  mounts?: string[]
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

function mountHasTarget (mount: string, target: string): boolean {
  return mount.split(',').some((part) => part.trim() === `target=${target}`)
}

function hasMountTarget (mounts: string[], target: string): boolean {
  return mounts.some((mount) => mountHasTarget(mount, target))
}

export function buildGeneratedDevcontainerConfig (context: WorkspaceContext, signing?: GitSigningPlan): DevcontainerConfig {
  const baseConfig = readBaseDevcontainerConfig(context.assetsDevcontainerDir)
  const mounts = Array.isArray(baseConfig.mounts)
    ? baseConfig.mounts
      .filter((mount): mount is string => typeof mount === 'string')
      .filter((mount) => !mountHasTarget(mount, BOXDOWN_CONTAINER_GITCONFIG_PATH))
    : []

  const boxdownMounts = [
    `type=bind,source=${context.assetsDevcontainerDir},target=${BOXDOWN_CONTAINER_DEVCONTAINER_DIR},readonly`,
    `type=bind,source=${context.sshPublicKeyRuntimeDir},target=${BOXDOWN_CONTAINER_SSH_DIR},readonly`,
    `type=bind,source=${context.hostGitconfigSnapshotDir},target=${BOXDOWN_CONTAINER_HOST_GITCONFIG_DIR},readonly`
  ]

  if (
    directoryExists(context.hostAgentsDir) &&
    !hasMountTarget(mounts, BOXDOWN_CONTAINER_AGENTS_DIR)
  ) {
    boxdownMounts.push(`type=bind,source=${context.hostAgentsDir},target=${BOXDOWN_CONTAINER_AGENTS_DIR},readonly`)
  }

  if (signing?.enabled === true && signing.agentSocketSource !== undefined) {
    boxdownMounts.push(`type=bind,source=${signing.agentSocketSource},target=/run/boxdown/ssh-agent.sock`)
    boxdownMounts.push(`type=bind,source=${context.gitSigningStateDir},target=/opt/boxdown/state/git-signing,readonly`)
  }

  if (
    fileExists(context.hostCodexAuthPath) &&
    !hasMountTarget(mounts, BOXDOWN_CONTAINER_CODEX_DIR) &&
    !hasMountTarget(mounts, BOXDOWN_CONTAINER_CODEX_AUTH_PATH)
  ) {
    boxdownMounts.push(`type=bind,source=${context.hostCodexAuthPath},target=${BOXDOWN_CONTAINER_CODEX_AUTH_PATH},readonly`)
  }

  return {
    ...baseConfig,
    name: `Boxdown: ${context.workspaceBasename}`,
    mounts: [...mounts, ...boxdownMounts],
    initializeCommand: [
      `BOXDOWN_WORKSPACE_FOLDER=${shellQuote(context.workspaceFolder)}`,
      `BOXDOWN_HOST_GITCONFIG_PATH=${shellQuote(context.hostGitconfigPath)}`,
      `BOXDOWN_HOST_GITCONFIG_SNAPSHOT_PATH=${shellQuote(context.hostGitconfigSnapshotPath)}`,
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
      DEVCONTAINER_SSH_PUBLIC_KEY_FILE: BOXDOWN_CONTAINER_SSH_PUBLIC_KEY_PATH,
      BOXDOWN_GIT_SIGNING_ENABLED: signing?.enabled === true ? '1' : '0',
      BOXDOWN_GIT_SIGNING_KEY_PATH: '/opt/boxdown/state/git-signing/signing-key.pub',
      ...(signing?.enabled === false && signing.reason !== undefined ? { BOXDOWN_GIT_SIGNING_REASON: signing.reason } : {}),
      ...(signing?.enabled === true ? { SSH_AUTH_SOCK: '/run/boxdown/ssh-agent.sock' } : {})
    }
  }
}

export function writeGeneratedDevcontainerConfig (context: WorkspaceContext, signing?: GitSigningPlan): DevcontainerConfig {
  const config = buildGeneratedDevcontainerConfig(context, signing)
  mkdirSync(context.workspaceCacheDir, { recursive: true })
  writeFileSync(context.generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`)
  return config
}

export function publishContainerPortFromConfig (config: DevcontainerConfig): string | undefined {
  return config.runArgs?.find((arg) => /^[0-9.]+::[0-9]+$/.test(arg))?.split('::')[1]
}
