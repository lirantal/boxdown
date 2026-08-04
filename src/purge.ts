import { existsSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'

import { findWorkspaceContainer, inspectContainerImage, removeContainerById, removeDockerImage } from './devcontainer.ts'
import type { WorkspaceCommandLogger } from './logging.ts'
import { readWorkspaceMetadata, type WorkspaceMetadata } from './metadata.ts'
import type { WorkspaceContext } from './paths.ts'
import { defaultSshAlias, uninstallSshConfig } from './ssh-config.ts'
import { SSH_INSTALL_TARGETS, uninstallWorkspaceSshInstallTarget } from './ssh-install-targets.ts'
import type { ContainerSummary } from './status.ts'

export interface PurgeOptions {
  alias?: string
  logger?: WorkspaceCommandLogger
}

export interface PurgePlan {
  workspaceFolder: string
  removals: string[]
  kept: string[]
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

function planStatePath (label: string, path: string, description: string): string {
  return existsSync(path)
    ? `${label}: ${path} (${description})`
    : `${label} absent: ${path}`
}

function formatPurgePlanImage (id: string, name?: string): string {
  return name === undefined ? id : `${name} (${id})`
}

export async function createPurgePlan (
  context: WorkspaceContext,
  options: Pick<PurgeOptions, 'alias'> = {}
): Promise<PurgePlan> {
  const removals: string[] = []
  let metadata: WorkspaceMetadata | undefined

  try {
    metadata = readWorkspaceMetadata(context)
  } catch {
    removals.push('Boxdown workspace metadata could not be read; purge will retry during removal')
  }

  const aliases = uniqueAliases([
    options.alias,
    metadata?.sshAlias,
    defaultSshAlias(context.workspaceBasename)
  ])
  let inspectedImageId: string | undefined

  try {
    const container = await findWorkspaceContainer(context)

    if (container === undefined) {
      removals.push('No Boxdown Docker container currently exists')
    } else {
      removals.push(`Docker container: ${container.name ?? container.id} (${container.state ?? 'unknown'})`)
      removals.push('Docker volumes attached only to that container')

      try {
        const image = await inspectContainerImage(container.id)

        if (image === undefined) {
          removals.push('Docker image used by this workspace could not be inspected')
        } else {
          inspectedImageId = image.id
          removals.push(`Docker image used by this workspace: ${formatPurgePlanImage(image.id, image.name)}`)
        }
      } catch {
        removals.push('Docker image used by this workspace could not be inspected; purge will retry during removal')
      }
    }
  } catch {
    removals.push('Docker container state could not be inspected; purge will retry during removal')
  }

  if (metadata?.dockerImageId !== undefined && inspectedImageId === undefined) {
    removals.push(`Recorded Docker image used by this workspace: ${formatPurgePlanImage(metadata.dockerImageId, metadata.dockerImageName)}`)
  }

  removals.push(`SSH connection: ${aliases.join(', ')}`)
  removals.push('Codex, Claude, and Cursor integrations for those SSH connections, when installed')
  removals.push(planStatePath('Generated Boxdown configuration', context.workspaceCacheDir, 'generated configuration and cache'))
  removals.push(planStatePath('Boxdown workspace data', context.workspaceDataDir, 'workspace SSH key, command log, metadata, and Git-config snapshot'))
  removals.push(planStatePath('Temporary runtime state', context.workspaceRuntimeDir, 'runtime-only secret files'))

  return {
    workspaceFolder: context.workspaceFolder,
    removals,
    kept: [
      `Your repository and files: ${context.workspaceFolder}`,
      'Your Git history and original host Git configuration',
      'Other Docker containers, images, volumes, and Boxdown workspaces'
    ]
  }
}

export function formatPurgePlanDetails (plan: PurgePlan): string[] {
  return [
    `Workspace: ${plan.workspaceFolder}`,
    'This will remove:',
    ...plan.removals.map((item) => `• ${item}`),
    'This will keep:',
    ...plan.kept.map((item) => `• ${item}`)
  ]
}

export function formatPurgePlanText (plan: PurgePlan): string {
  return [
    `Purge plan: ${plan.workspaceFolder}`,
    'This will remove:',
    ...plan.removals.map((item) => `- ${item}`),
    'This will keep:',
    ...plan.kept.map((item) => `- ${item}`)
  ].join('\n')
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

async function purgeSshAlias (alias: string): Promise<boolean> {
  return await runPurgeStep(`SSH alias ${alias}`, () => {
    const changed = uninstallSshConfig(alias, { quiet: true })
    process.stdout.write(changed
      ? `Removed SSH alias: ${alias}\n`
      : `SSH alias absent: ${alias}\n`)
  })
}

export async function purgeWorkspace (context: WorkspaceContext, options: PurgeOptions = {}): Promise<number> {
  let failed = false
  let integrationCleanupFailed = false
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

  const aliases = uniqueAliases([
    options.alias,
    metadata?.sshAlias,
    defaultSshAlias(context.workspaceBasename)
  ])

  for (const alias of aliases) {
    failed = await purgeSshAlias(alias) || failed
  }

  for (const target of SSH_INSTALL_TARGETS) {
    const targetFailed = await runPurgeStep(`${target.label} workspace integration cleanup`, async () => {
      await uninstallWorkspaceSshInstallTarget(context, aliases, target.value, { quiet: true })
      process.stdout.write(`Cleaned ${target.label} workspace integrations.\n`)
    })
    integrationCleanupFailed = integrationCleanupFailed || targetFailed
    failed = targetFailed || failed
  }

  failed = await runPurgeStep('workspace Docker container lookup', async () => {
    container = await findWorkspaceContainer(context, { logger: options.logger, resourceName: 'Docker container' })

    if (container === undefined) {
      process.stdout.write(`Docker container absent: ${context.workspaceFolder}\n`)
    } else {
      process.stdout.write(`Found Docker container: ${container.id}\n`)
    }
  }) || failed

  const currentContainer = container

  if (currentContainer !== undefined) {
    failed = await runPurgeStep(`Docker image inspect for ${currentContainer.id}`, async () => {
      const image = await inspectContainerImage(currentContainer.id, { logger: options.logger, resourceName: 'Docker container' })

      if (image === undefined) {
        process.stdout.write(`Docker image not recorded by container inspect: ${currentContainer.id}\n`)
        return
      }

      dockerImageId = image.id
      process.stdout.write(image.name === undefined
        ? `Resolved Docker image: ${image.id}\n`
        : `Resolved Docker image: ${image.id} (${image.name})\n`)
    }) || failed

    failed = await runPurgeStep(`Docker container ${currentContainer.id}`, async () => {
      await removeContainerById(currentContainer.id, { volumes: true, logger: options.logger, resourceName: 'Docker container' })
      process.stdout.write(`Removed Docker container with volumes: ${currentContainer.id}\n`)
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

  if (integrationCleanupFailed) {
    process.stderr.write(`Retained workspace data after integration cleanup failure: ${context.workspaceDataDir}\n`)
  } else {
    failed = await runPurgeStep('workspace data directory', () => {
      options.logger?.boxdown(`Removing workspace data: ${context.workspaceDataDir}\n`)
      options.logger?.disable()
      removeWorkspaceStateDir(context, 'workspace data', context.workspaceDataDir, context.dataRoot)
    }) || failed
  }

  return failed ? 1 : 0
}
