import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PACKAGE_NAME } from './constants.ts'

export interface WorkspaceContextOptions {
  workspace?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  packageRoot?: string
  assetsDevcontainerDir?: string
}

export interface WorkspaceContext {
  workspaceFolder: string
  workspaceBasename: string
  workspaceId: string
  packageRoot: string
  assetsDevcontainerDir: string
  cacheRoot: string
  dataRoot: string
  workspaceCacheDir: string
  workspaceDataDir: string
  generatedConfigPath: string
  hostAgentsDir: string
  sshKeyDir: string
  sshKeyPath: string
  sshPublicKeyPath: string
  sshPublicKeyRuntimeDir: string
  sshPublicKeyRuntimePath: string
}

export function packageRootFromImportMeta (importMetaUrl = import.meta.url): string {
  return dirname(dirname(fileURLToPath(importMetaUrl)))
}

export function workspaceIdFor (workspaceFolder: string): string {
  return createHash('sha256').update(workspaceFolder).digest('hex').slice(0, 16)
}

export function resolveWorkspaceFolder (workspace: string | undefined, cwd = process.cwd()): string {
  const candidate = resolve(cwd, workspace ?? '.')

  if (!existsSync(candidate)) {
    throw new Error(`Workspace does not exist: ${candidate}`)
  }

  if (!statSync(candidate).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${candidate}`)
  }

  return realpathSync(candidate)
}

export function defaultCacheRoot (env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOXDOWN_CACHE_HOME) {
    return env.BOXDOWN_CACHE_HOME
  }

  if (env.XDG_CACHE_HOME) {
    return join(env.XDG_CACHE_HOME, PACKAGE_NAME)
  }

  return join(homedir(), '.cache', PACKAGE_NAME)
}

export function defaultDataRoot (env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOXDOWN_DATA_HOME) {
    return env.BOXDOWN_DATA_HOME
  }

  if (env.XDG_DATA_HOME) {
    return join(env.XDG_DATA_HOME, PACKAGE_NAME)
  }

  return join(homedir(), '.local', 'share', PACKAGE_NAME)
}

export function defaultHostAgentsDir (env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), '.agents')
}

export function createWorkspaceContext (options: WorkspaceContextOptions = {}): WorkspaceContext {
  const env = options.env ?? process.env
  const workspaceFolder = resolveWorkspaceFolder(options.workspace, options.cwd)
  const workspaceBasename = basename(workspaceFolder)
  const workspaceId = workspaceIdFor(workspaceFolder)
  const packageRoot = options.packageRoot ?? packageRootFromImportMeta()
  const assetsDevcontainerDir = options.assetsDevcontainerDir ?? env.BOXDOWN_DEVCONTAINER_ASSETS_DIR ?? join(packageRoot, 'assets', 'devcontainer')
  const cacheRoot = defaultCacheRoot(env)
  const dataRoot = defaultDataRoot(env)
  const hostAgentsDir = defaultHostAgentsDir(env)
  const workspaceCacheDir = join(cacheRoot, 'workspaces', workspaceId)
  const workspaceDataDir = join(dataRoot, 'workspaces', workspaceId)

  return {
    workspaceFolder,
    workspaceBasename,
    workspaceId,
    packageRoot,
    assetsDevcontainerDir,
    cacheRoot,
    dataRoot,
    workspaceCacheDir,
    workspaceDataDir,
    generatedConfigPath: join(workspaceCacheDir, 'devcontainer.json'),
    hostAgentsDir,
    sshKeyDir: join(workspaceDataDir, 'ssh'),
    sshKeyPath: join(workspaceDataDir, 'ssh', 'id_ed25519'),
    sshPublicKeyPath: join(workspaceDataDir, 'ssh', 'id_ed25519.pub'),
    sshPublicKeyRuntimeDir: join(workspaceDataDir, 'ssh-public'),
    sshPublicKeyRuntimePath: join(workspaceDataDir, 'ssh-public', 'id_ed25519.pub')
  }
}
