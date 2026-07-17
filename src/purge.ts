import { existsSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'

import { claudeSshConfigEntryForWorkspace, uninstallClaudeSshConfigHost } from './claude-app-config.ts'
import { codexProjectEntryForWorkspace, legacyCodexRemotePathForWorkspace, uninstallCodexAppConfigProject, uninstallCodexGlobalStateProject } from './codex-app-config.ts'
import { findWorkspaceContainer, inspectContainerImage, removeContainerById, removeDockerImage } from './devcontainer.ts'
import type { WorkspaceCommandLogger } from './logging.ts'
import { readWorkspaceMetadata, type WorkspaceMetadata } from './metadata.ts'
import type { WorkspaceContext } from './paths.ts'
import { defaultSshAlias, uninstallSshConfig } from './ssh-config.ts'
import type { ContainerSummary } from './status.ts'

export interface PurgeOptions {
  alias?: string
  logger?: WorkspaceCommandLogger
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function runPurgeStep (label: string, action: () => Promise<void> | void): Promise<boolean> {
  try {
    await action()
    return false
  } catch (error) {
    process.stderr.write(`Failed ${label}: ${errorMessage(error)}\n`)
    return true
  }
}

function uniqueAliases (aliases: Array<string | undefined>): string[] {
  return [...new Set(aliases.filter((alias): alias is string => alias !== undefined))]
}

function pathIsInsideOrSame (parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function assertSafeWorkspaceStateDir (
  context: WorkspaceContext,
  path: string,
  root: string
): void {
  const resolvedPath = resolve(path)
  const resolvedRoot = resolve(root)
  const expectedPath = resolve(join(resolvedRoot, 'workspaces', context.workspaceId))

  if (resolvedPath !== expectedPath) {
    throw new Error(`Refusing to purge unexpected state path: ${path}`)
  }

  if (resolvedRoot === parse(resolvedRoot).root) {
    throw new Error(`Refusing to purge state under filesystem root: ${path}`)
  }

  if (basename(resolvedPath) !== context.workspaceId || basename(dirname(resolvedPath)) !== 'workspaces') {
    throw new Error(`Refusing to purge non-workspace state path: ${path}`)
  }

  if (pathIsInsideOrSame(resolve(context.workspaceFolder), resolvedPath)) {
    throw new Error(`Refusing to purge state inside the workspace repository: ${path}`)
  }

  if (!pathIsInsideOrSame(resolvedRoot, resolvedPath)) {
    throw new Error(`Refusing to purge state outside its root: ${path}`)
  }
}

function removeWorkspaceStateDir (
  context: WorkspaceContext,
  label: string,
  path: string,
  root: string
): void {
  assertSafeWorkspaceStateDir(context, path, root)

  if (!existsSync(path)) {
    process.stdout.write(`${label} absent: ${path}\n`)
    return
  }

  rmSync(path, { recursive: true, force: true })
  process.stdout.write(`Removed ${label}: ${path}\n`)
}

export function removeWorkspaceRuntimeState (context: WorkspaceContext): void {
  removeWorkspaceStateDir(context, 'workspace runtime directory', context.workspaceRuntimeDir, context.runtimeRoot)
}

async function purgeAliasIntegrations (context: WorkspaceContext, alias: string): Promise<boolean> {
  let failed = false

  failed = await runPurgeStep(`SSH alias ${alias}`, () => {
    const changed = uninstallSshConfig(alias, { quiet: true })
    process.stdout.write(changed
      ? `Removed SSH alias: ${alias}\n`
      : `SSH alias absent: ${alias}\n`)
  }) || failed

  const entry = codexProjectEntryForWorkspace(context, alias)
  const legacyRemotePath = legacyCodexRemotePathForWorkspace(context)

  failed = await runPurgeStep(`Codex app config for ${alias}`, () => {
    const result = uninstallCodexAppConfigProject(entry, {
      additionalRemotePaths: [legacyRemotePath]
    })
    process.stdout.write(result.changed
      ? `Removed Codex remote project: ${entry.label} (${alias})\n`
      : `Codex remote project absent: ${entry.label} (${alias})\n`)
  }) || failed

  failed = await runPurgeStep(`Codex app state for ${alias}`, () => {
    const result = uninstallCodexGlobalStateProject(entry, {
      additionalRemotePaths: [legacyRemotePath]
    })
    process.stdout.write(result.changed
      ? `Removed Codex sidebar state: ${entry.label} (${alias})\n`
      : `Codex sidebar state absent: ${entry.label} (${alias})\n`)
  }) || failed

  const claudeEntry = claudeSshConfigEntryForWorkspace(context, alias)

  failed = await runPurgeStep(`Claude SSH config for ${alias}`, () => {
    const result = uninstallClaudeSshConfigHost(claudeEntry)
    process.stdout.write(result.changed
      ? `Removed Claude SSH remote: ${claudeEntry.name} (${alias})\n`
      : `Claude SSH remote absent: ${claudeEntry.name} (${alias})\n`)
  }) || failed

  return failed
}

export async function purgeWorkspace (context: WorkspaceContext, options: PurgeOptions = {}): Promise<number> {
  let failed = false
  let metadata: WorkspaceMetadata | undefined
  let container: ContainerSummary | undefined
  let dockerImageId: string | undefined

  process.stdout.write(`Purging Boxdown workspace: ${context.workspaceFolder}\n`)

  failed = await runPurgeStep('workspace metadata snapshot', () => {
    metadata = readWorkspaceMetadata(context)
    dockerImageId = metadata?.dockerImageId
    process.stdout.write(metadata === undefined
      ? `Workspace metadata absent: ${context.workspaceDataDir}\n`
      : `Snapshot workspace metadata: ${context.workspaceDataDir}\n`)
  }) || failed

  for (const alias of uniqueAliases([
    options.alias,
    metadata?.sshAlias,
    defaultSshAlias(context.workspaceBasename)
  ])) {
    failed = await purgeAliasIntegrations(context, alias) || failed
  }

  failed = await runPurgeStep('workspace devcontainer lookup', async () => {
    container = await findWorkspaceContainer(context, { logger: options.logger })

    if (container === undefined) {
      process.stdout.write(`Devcontainer absent: ${context.workspaceFolder}\n`)
    } else {
      process.stdout.write(`Found devcontainer: ${container.id}\n`)
    }
  }) || failed

  const currentContainer = container

  if (currentContainer !== undefined) {
    failed = await runPurgeStep(`Docker image inspect for ${currentContainer.id}`, async () => {
      const image = await inspectContainerImage(currentContainer.id, { logger: options.logger })

      if (image === undefined) {
        process.stdout.write(`Docker image not recorded by container inspect: ${currentContainer.id}\n`)
        return
      }

      dockerImageId = image.id
      process.stdout.write(image.name === undefined
        ? `Resolved Docker image: ${image.id}\n`
        : `Resolved Docker image: ${image.id} (${image.name})\n`)
    }) || failed

    failed = await runPurgeStep(`devcontainer ${currentContainer.id}`, async () => {
      await removeContainerById(currentContainer.id, { volumes: true, logger: options.logger })
      process.stdout.write(`Removed devcontainer with volumes: ${currentContainer.id}\n`)
    }) || failed
  }

  if (dockerImageId === undefined) {
    process.stdout.write('Docker image absent: no inspected or recorded image ID\n')
  } else {
    const removedImageId = dockerImageId
    failed = await runPurgeStep(`Docker image ${removedImageId}`, async () => {
      await removeDockerImage(removedImageId, { logger: options.logger })
    }) || failed
  }

  failed = await runPurgeStep('workspace runtime directory', () => {
    removeWorkspaceRuntimeState(context)
  }) || failed

  failed = await runPurgeStep('workspace cache directory', () => {
    removeWorkspaceStateDir(context, 'workspace cache', context.workspaceCacheDir, context.cacheRoot)
  }) || failed

  failed = await runPurgeStep('workspace data directory', () => {
    options.logger?.boxdown(`Removing workspace data: ${context.workspaceDataDir}\n`)
    options.logger?.disable()
    removeWorkspaceStateDir(context, 'workspace data', context.workspaceDataDir, context.dataRoot)
  }) || failed

  return failed ? 1 : 0
}
