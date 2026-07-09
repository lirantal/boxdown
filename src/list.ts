import type { WorkspaceMetadata } from './metadata.ts'
import type { ContainerSummary } from './status.ts'

export interface WorkspaceListEntry extends WorkspaceMetadata {
  repoExists: boolean
  state: string
  container: {
    found: boolean
    running: boolean
    id?: string
    name?: string
    state?: string
    status?: string
  }
}

function containerState (container: ContainerSummary | undefined, dockerAvailable: boolean): string {
  if (!dockerAvailable) {
    return 'unknown'
  }

  return container?.state?.toLowerCase() ?? 'absent'
}

function displayState (repoExists: boolean, container: ContainerSummary | undefined, dockerAvailable: boolean): string {
  if (!repoExists) {
    return 'missing'
  }

  return containerState(container, dockerAvailable)
}

export function createWorkspaceListEntries (
  metadata: WorkspaceMetadata[],
  containers: ContainerSummary[] | undefined,
  exists: (path: string) => boolean
): WorkspaceListEntry[] {
  const dockerAvailable = containers !== undefined
  const containersByWorkspace = new Map(
    (containers ?? [])
      .filter((container) => container.localFolder !== undefined)
      .map((container) => [container.localFolder as string, container])
  )

  return metadata
    .map((item) => {
      const container = containersByWorkspace.get(item.workspaceFolder)
      const repoExists = exists(item.workspaceFolder)
      const state = displayState(repoExists, container, dockerAvailable)

      return {
        ...item,
        repoExists,
        state,
        container: {
          found: container !== undefined,
          running: container?.state?.toLowerCase() === 'running',
          id: container?.id,
          name: container?.name,
          state: container?.state ?? (dockerAvailable ? undefined : 'unknown'),
          status: container?.status
        }
      }
    })
    .sort((a, b) => a.workspaceBasename.localeCompare(b.workspaceBasename) || a.workspaceFolder.localeCompare(b.workspaceFolder))
}

function pad (value: string, width: number): string {
  return value.padEnd(width, ' ')
}

function containerLabel (entry: WorkspaceListEntry): string {
  if (!entry.container.found) {
    return '-'
  }

  return entry.container.name ?? entry.container.id ?? '-'
}

export function formatWorkspaceListText (entries: WorkspaceListEntry[]): string {
  if (entries.length === 0) {
    return 'Boxdown list\n\nNo Boxdown workspaces found.\n'
  }

  const rows = entries.map((entry) => [
    entry.state,
    entry.workspaceBasename,
    entry.workspaceFolder,
    containerLabel(entry)
  ])
  const headers = ['STATE', 'REPO', 'PATH', 'CONTAINER']
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)))
  const lines = [
    'Boxdown list',
    '',
    headers.map((header, index) => pad(header, widths[index] ?? header.length)).join('  '),
    rows.map((row) => row.map((value, index) => pad(value, widths[index] ?? value.length)).join('  ')).join('\n')
  ]

  return `${lines.join('\n')}\n`
}

export function formatWorkspaceListDetailsText (entries: WorkspaceListEntry[]): string {
  if (entries.length === 0) {
    return 'Boxdown list\n\nNo Boxdown workspaces found.\n'
  }

  const details = entries.map((entry) => [
    `${entry.state}  ${entry.workspaceBasename}`,
    `  ${pad('path', 9)}: ${entry.workspaceFolder}`,
    `  ${pad('ssh alias', 9)}: ${entry.sshAlias}`,
    `  ${pad('container', 9)}: ${containerLabel(entry)}`
  ].join('\n')).join('\n\n')

  return `Boxdown list\n\n${details}\n`
}
