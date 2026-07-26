import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PACKAGE_NAME } from './constants.ts'

export interface WorkspaceContextOptions {
  workspace?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  packageRoot?: string
  assetsDevcontainerDir?: string
}

export type ClaudeCredentialsSupport = 'file' | 'macos-keychain' | 'unsupported-platform'

export interface WorkspaceContext {
  workspaceFolder: string
  workspaceBasename: string
  workspaceId: string
  packageRoot: string
  assetsDevcontainerDir: string
  cacheRoot: string
  dataRoot: string
  runtimeRoot: string
  workspaceCacheDir: string
  workspaceDataDir: string
  workspaceRuntimeDir: string
  workspaceSecretEnvDir: string
  generatedConfigPath: string
  hostAgentsDir: string
  hostCodexAuthPath: string
  claudeCredentialsSupport: ClaudeCredentialsSupport
  hostClaudeCredentialsPath?: string
  hostGitconfigPath: string
  hostGitconfigSnapshotDir: string
  hostGitconfigSnapshotPath: string
  gitSigningStateDir: string
  gitSigningPublicKeyPath: string
  sshKeyDir: string
  sshKeyPath: string
  sshPublicKeyPath: string
  sshPublicKeyRuntimeDir: string
  sshPublicKeyRuntimePath: string
  workspaceLogPath: string
}

export interface WorkspaceContextIdentity {
  workspaceFolder: string
  workspaceBasename: string
  workspaceId: string
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

export function defaultRuntimeRoot (env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOXDOWN_RUNTIME_HOME) {
    return env.BOXDOWN_RUNTIME_HOME
  }

  if (env.XDG_RUNTIME_DIR) {
    return join(env.XDG_RUNTIME_DIR, PACKAGE_NAME)
  }

  return join(tmpdir(), `${PACKAGE_NAME}-${process.getuid?.() ?? 'user'}`)
}

export function defaultHostAgentsDir (env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), '.agents')
}

export function defaultHostCodexAuthPath (env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), '.codex', 'auth.json')
}

export function defaultHostClaudeCredentialsPath (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform !== 'linux' && platform !== 'win32') return undefined

  const pathJoin = platform === 'win32' ? win32.join : join

  if (env.CLAUDE_CONFIG_DIR) {
    return pathJoin(env.CLAUDE_CONFIG_DIR, '.credentials.json')
  }

  const home = platform === 'win32'
    ? env.USERPROFILE ?? env.HOME ?? homedir()
    : env.HOME ?? homedir()

  return platform === 'win32'
    ? pathJoin(home, '.claude.credentials.json')
    : pathJoin(home, '.claude', '.credentials.json')
}

export function claudeCredentialsSupportFor (
  platform: NodeJS.Platform = process.platform
): ClaudeCredentialsSupport {
  if (platform === 'linux' || platform === 'win32') return 'file'
  return platform === 'darwin' ? 'macos-keychain' : 'unsupported-platform'
}

export function defaultHostGitconfigPath (env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), '.gitconfig')
}

export function createWorkspaceContextFromIdentity (
  identity: WorkspaceContextIdentity,
  options: Omit<WorkspaceContextOptions, 'workspace' | 'cwd'> = {}
): WorkspaceContext {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const packageRoot = options.packageRoot ?? packageRootFromImportMeta()
  const assetsDevcontainerDir = options.assetsDevcontainerDir ?? env.BOXDOWN_DEVCONTAINER_ASSETS_DIR ?? join(packageRoot, 'assets', 'devcontainer')
  const cacheRoot = defaultCacheRoot(env)
  const dataRoot = defaultDataRoot(env)
  const runtimeRoot = defaultRuntimeRoot(env)
  const hostAgentsDir = defaultHostAgentsDir(env)
  const hostCodexAuthPath = defaultHostCodexAuthPath(env)
  const hostClaudeCredentialsPath = defaultHostClaudeCredentialsPath(env, platform)
  const workspaceCacheDir = join(cacheRoot, 'workspaces', identity.workspaceId)
  const workspaceDataDir = join(dataRoot, 'workspaces', identity.workspaceId)
  const workspaceRuntimeDir = join(runtimeRoot, 'workspaces', identity.workspaceId)
  const hostGitconfigSnapshotDir = join(workspaceDataDir, 'gitconfig')

  return {
    workspaceFolder: identity.workspaceFolder,
    workspaceBasename: identity.workspaceBasename,
    workspaceId: identity.workspaceId,
    packageRoot,
    assetsDevcontainerDir,
    cacheRoot,
    dataRoot,
    runtimeRoot,
    workspaceCacheDir,
    workspaceDataDir,
    workspaceRuntimeDir,
    workspaceSecretEnvDir: join(workspaceRuntimeDir, 'secrets'),
    generatedConfigPath: join(workspaceCacheDir, 'devcontainer.json'),
    hostAgentsDir,
    hostCodexAuthPath,
    claudeCredentialsSupport: claudeCredentialsSupportFor(platform),
    hostClaudeCredentialsPath,
    hostGitconfigPath: defaultHostGitconfigPath(env),
    hostGitconfigSnapshotDir,
    hostGitconfigSnapshotPath: join(hostGitconfigSnapshotDir, '.gitconfig'),
    gitSigningStateDir: join(workspaceDataDir, 'git-signing'),
    gitSigningPublicKeyPath: join(workspaceDataDir, 'git-signing', 'signing-key.pub'),
    sshKeyDir: join(workspaceDataDir, 'ssh'),
    sshKeyPath: join(workspaceDataDir, 'ssh', 'id_ed25519'),
    sshPublicKeyPath: join(workspaceDataDir, 'ssh', 'id_ed25519.pub'),
    sshPublicKeyRuntimeDir: join(workspaceDataDir, 'ssh-public'),
    sshPublicKeyRuntimePath: join(workspaceDataDir, 'ssh-public', 'id_ed25519.pub'),
    workspaceLogPath: join(workspaceDataDir, 'boxdown.log')
  }
}

export function createWorkspaceContext (options: WorkspaceContextOptions = {}): WorkspaceContext {
  const workspaceFolder = resolveWorkspaceFolder(options.workspace, options.cwd)

  return createWorkspaceContextFromIdentity({
    workspaceFolder,
    workspaceBasename: basename(workspaceFolder),
    workspaceId: workspaceIdFor(workspaceFolder)
  }, options)
}
