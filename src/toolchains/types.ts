export const TOOLCHAIN_IDS = ['node', 'python', 'go', 'rust'] as const

export type ToolchainId = typeof TOOLCHAIN_IDS[number]
export type ToolchainSelectionSource = 'interactive' | 'cli' | 'persisted'
export type ToolchainResolutionSource = 'override' | 'project' | 'boxdown-default'
export type ToolchainSyncState = 'pending' | 'succeeded' | 'failed' | 'not-created'

export interface ToolchainEvidence {
  path: string
  source: string
  value: string
  exact: boolean
}

export interface ToolchainDiagnostic {
  path: string
  source: string
  message: string
}

export interface DetectedToolchain {
  id: ToolchainId
  exactVersion?: string
  constraint?: string
  evidence: ToolchainEvidence[]
  diagnostics?: ToolchainDiagnostic[]
}

export interface ResolvedToolchain {
  id: ToolchainId
  version: string
  selectionSource: ToolchainSelectionSource
  resolutionSource: ToolchainResolutionSource
  evidence: ToolchainEvidence[]
  compatibilityNote?: string
}

export interface ToolchainPlan {
  version: 1
  workspaceId: string
  fingerprint: string
  selected: ResolvedToolchain[]
  updatedAt: string
}

export interface ToolchainResult {
  version: 1
  fingerprint: string
  state: ToolchainSyncState
  updatedAt: string
  runtimes: Array<{id: ToolchainId, state: ToolchainSyncState, message?: string}>
}

export type ToolchainSelector =
  | {kind: 'auto'}
  | {kind: 'none'}
  | {kind: 'runtime', id: ToolchainId, version?: string}

export type DetectedVersionResolution =
  | {kind: 'resolved', version: string, source: 'project' | 'boxdown-default'}
  | {kind: 'incompatible-default', defaultVersion: string, constraint: string}
  | {kind: 'unchecked', defaultVersion: string}
