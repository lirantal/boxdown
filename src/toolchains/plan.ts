import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { TOOLCHAIN_DEFAULTS } from './defaults.ts'
import { detectedConstraintAcceptsVersion, resolveDetectedVersion } from './detect.ts'
import { TOOLCHAIN_IDS, type DetectedToolchain, type ResolvedToolchain, type ToolchainId, type ToolchainPlan, type ToolchainResult, type ToolchainSelector, type ToolchainSelectionSource, type ToolchainSyncState } from './types.ts'
import { recordToolchainPlanUpdatedAt } from '../metadata.ts'
import type { WorkspaceContext } from '../paths.ts'

const toolchainIds = new Set<string>(TOOLCHAIN_IDS)
const selectionSources = new Set<string>(['interactive', 'cli', 'persisted'])
const resolutionSources = new Set<string>(['override', 'project', 'boxdown-default'])
const syncStates = new Set<string>(['pending', 'succeeded', 'failed', 'not-created'])

export function parseToolchainSelector (value: string): ToolchainSelector {
  if (value === 'auto') return {kind: 'auto'}
  if (value === 'none') return {kind: 'none'}

  // eslint-disable-next-line security/detect-unsafe-regex -- Anchored selector grammar has a bounded literal prefix and a single linear version suffix.
  const match = /^(node|python|go|rust)(?:@([0-9][0-9A-Za-z.+-]*))?$/u.exec(value)
  if (match === null) throw new Error(`Unsupported toolchain selector: ${value}`)

  return {
    kind: 'runtime',
    id: match[1] as ToolchainId,
    ...(match[2] === undefined ? {} : {version: match[2]})
  }
}

function comparisonOrder (left: ToolchainId, right: ToolchainId): number {
  return TOOLCHAIN_IDS.indexOf(left) - TOOLCHAIN_IDS.indexOf(right)
}

function compatibilityNote (id: ToolchainId, version: string, detection: DetectedToolchain | undefined): string | undefined {
  if (detection !== undefined && resolveDetectedVersion(detection).kind === 'unchecked') {
    const diagnostic = detection.diagnostics?.[0]
    const evidence = diagnostic === undefined
      ? detection.evidence[0]
      : detection.evidence.find((item) => item.path === diagnostic.path && item.source === diagnostic.source)
    const source = evidence === undefined
      ? diagnostic === undefined ? `${TOOLCHAIN_DEFAULTS[id].label} project evidence` : `${diagnostic.path} ${diagnostic.source}`
      : `${evidence.path} ${evidence.source} ${evidence.value}`
    const reason = diagnostic?.message ?? 'Project evidence needs review'

    return `Explicit ${TOOLCHAIN_DEFAULTS[id].label} ${version} override compatibility could not be verified against ${source}: ${reason}.`
  }

  const exactEvidence = detection?.evidence.find((item) => item.exact && item.value !== version)

  if (exactEvidence !== undefined) {
    return `Explicit ${TOOLCHAIN_DEFAULTS[id].label} ${version} override differs from ${exactEvidence.path} ${exactEvidence.source} ${exactEvidence.value}.`
  }

  if (detection === undefined || detectedConstraintAcceptsVersion(detection, version) !== false) {
    return undefined
  }

  const constraintEvidence = detection.evidence.find((item) => !item.exact)
  if (constraintEvidence === undefined) return undefined

  return `Explicit ${TOOLCHAIN_DEFAULTS[id].label} ${version} override conflicts with ${constraintEvidence.path} ${constraintEvidence.source} ${constraintEvidence.value}.`
}

function dedupeRuntimeSelectors (selectors: readonly ToolchainSelector[]): Map<ToolchainId, string | undefined> {
  const runtimeSelectors = new Map<ToolchainId, string | undefined>()

  for (const selector of selectors) {
    if (selector.kind !== 'runtime') continue

    const previous = runtimeSelectors.get(selector.id)
    if (previous !== undefined && selector.version !== undefined && previous !== selector.version) {
      throw new Error(`Conflicting explicit versions for ${TOOLCHAIN_DEFAULTS[selector.id].label}: ${previous} and ${selector.version}`)
    }

    if (selector.version !== undefined || !runtimeSelectors.has(selector.id)) {
      runtimeSelectors.set(selector.id, selector.version)
    }
  }

  return runtimeSelectors
}

function resolvedFromRuntimeSelector (
  id: ToolchainId,
  requestedVersion: string | undefined,
  detection: DetectedToolchain | undefined,
  selectionSource: ToolchainSelectionSource
): ResolvedToolchain {
  if (requestedVersion !== undefined) {
    const note = compatibilityNote(id, requestedVersion, detection)
    return {
      id,
      version: requestedVersion,
      selectionSource,
      resolutionSource: 'override',
      evidence: detection?.evidence ?? [],
      ...(note === undefined ? {} : {compatibilityNote: note})
    }
  }

  const detected = detection === undefined ? undefined : resolveDetectedVersion(detection)
  if (detected?.kind === 'resolved') {
    return {
      id,
      version: detected.version,
      selectionSource,
      resolutionSource: detected.source,
      evidence: detection?.evidence ?? []
    }
  }

  if (detected?.kind === 'incompatible-default') {
    throw new Error(
      `Cannot automatically resolve ${TOOLCHAIN_DEFAULTS[id].label}: Boxdown default ${detected.defaultVersion} is incompatible with project constraint ${detected.constraint}. Pass --toolchain ${id}@<version>.`
    )
  }

  if (detected?.kind === 'unchecked') {
    throw new Error(
      `Cannot automatically resolve ${TOOLCHAIN_DEFAULTS[id].label} because its project declaration needs review. Pass --toolchain ${id}@<version>.`
    )
  }

  return {
    id,
    version: TOOLCHAIN_DEFAULTS[id].version,
    selectionSource,
    resolutionSource: 'boxdown-default',
    evidence: detection?.evidence ?? []
  }
}

function fingerprintFor (workspaceId: string, selected: readonly ResolvedToolchain[]): string {
  const stableSelected = [...selected]
    .sort((left, right) => comparisonOrder(left.id, right.id))
    .map(({id, version, resolutionSource, evidence}) => ({id, version, resolutionSource, evidence}))
  return createHash('sha256').update(JSON.stringify({workspaceId, selected: stableSelected})).digest('hex')
}

export function resolveToolchainPlan (options: {
  workspaceId: string
  detections: readonly DetectedToolchain[]
  selectors: readonly ToolchainSelector[]
  selectionSource: ToolchainSelectionSource
  now?: Date
}): ToolchainPlan {
  const hasNone = options.selectors.some((selector) => selector.kind === 'none')
  if (hasNone && options.selectors.some((selector) => selector.kind !== 'none')) {
    throw new Error('--toolchain none cannot be combined with another selector')
  }

  const detections = new Map(options.detections.map((detection) => [detection.id, detection]))
  const runtimeSelectors = dedupeRuntimeSelectors(options.selectors)
  const selected: ResolvedToolchain[] = []

  if (!hasNone) {
    if (options.selectors.some((selector) => selector.kind === 'auto')) {
      for (const id of TOOLCHAIN_IDS) {
        if (runtimeSelectors.has(id)) continue
        const detection = detections.get(id)
        if (detection === undefined) continue

        const resolution = resolveDetectedVersion(detection)
        if (resolution.kind !== 'resolved') continue

        selected.push({
          id,
          version: resolution.version,
          selectionSource: options.selectionSource,
          resolutionSource: resolution.source,
          evidence: detection.evidence
        })
      }
    }

    for (const id of TOOLCHAIN_IDS) {
      if (!runtimeSelectors.has(id)) continue
      selected.push(resolvedFromRuntimeSelector(id, runtimeSelectors.get(id), detections.get(id), options.selectionSource))
    }
  }

  selected.sort((left, right) => comparisonOrder(left.id, right.id))
  return {
    version: 1,
    workspaceId: options.workspaceId,
    fingerprint: fingerprintFor(options.workspaceId, selected),
    selected,
    updatedAt: (options.now ?? new Date()).toISOString()
  }
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isToolchainId (value: unknown): value is ToolchainId {
  return typeof value === 'string' && toolchainIds.has(value)
}

function isSyncState (value: unknown): value is ToolchainSyncState {
  return typeof value === 'string' && syncStates.has(value)
}

function isToolchainEvidence (value: unknown): boolean {
  return isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.source === 'string' &&
    typeof value.value === 'string' &&
    typeof value.exact === 'boolean'
}

function isResolvedToolchain (value: unknown): boolean {
  return isRecord(value) &&
    isToolchainId(value.id) &&
    typeof value.version === 'string' &&
    selectionSources.has(value.selectionSource as string) &&
    resolutionSources.has(value.resolutionSource as string) &&
    Array.isArray(value.evidence) && value.evidence.every(isToolchainEvidence) &&
    (value.compatibilityNote === undefined || typeof value.compatibilityNote === 'string')
}

function isToolchainPlan (value: unknown, workspaceId: string): value is ToolchainPlan {
  return isRecord(value) &&
    value.version === 1 &&
    value.workspaceId === workspaceId &&
    typeof value.fingerprint === 'string' &&
    Array.isArray(value.selected) && value.selected.every(isResolvedToolchain) &&
    typeof value.updatedAt === 'string'
}

function isToolchainResult (value: unknown): value is ToolchainResult {
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.fingerprint === 'string' &&
    isSyncState(value.state) &&
    typeof value.updatedAt === 'string' &&
    Array.isArray(value.runtimes) && value.runtimes.every((runtime) =>
      isRecord(runtime) && isToolchainId(runtime.id) && (runtime.version === undefined || typeof runtime.version === 'string') && isSyncState(runtime.state) &&
      (runtime.message === undefined || typeof runtime.message === 'string')
    )
}

function errorReason (error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') return error.code
  return error instanceof Error ? error.message : String(error)
}

function readJsonFile (path: string, label: string): unknown {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`Unable to read Boxdown toolchain ${label}: ${path} (${errorReason(error)})`, {cause: error})
  }

  try {
    return JSON.parse(contents) as unknown
  } catch {
    throw new Error(`Invalid Boxdown toolchain ${label}: ${path}`)
  }
}

function fsyncDirectory (path: string): void {
  let descriptor: number | undefined

  try {
    descriptor = openSync(path, 'r')
    fsyncSync(descriptor)
  } catch {
    // Directory fsync is not available on every supported platform.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function writeJsonFileAtomically (path: string, value: unknown): void {
  const directory = dirname(path)
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  let descriptor: number | undefined

  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporaryPath, path)
    fsyncDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The temporary file may have been renamed or never created.
    }
    throw error
  }
}

export function readToolchainPlan (context: WorkspaceContext): ToolchainPlan | undefined {
  if (!existsSync(context.toolchainPlanPath)) return undefined

  const parsed = readJsonFile(context.toolchainPlanPath, 'plan')
  if (!isToolchainPlan(parsed, context.workspaceId)) {
    throw new Error(`Invalid Boxdown toolchain plan: ${context.toolchainPlanPath}`)
  }

  return parsed
}

export function readToolchainResult (context: WorkspaceContext): ToolchainResult | undefined {
  if (!existsSync(context.toolchainResultPath)) return undefined

  const parsed = readJsonFile(context.toolchainResultPath, 'result')
  if (!isToolchainResult(parsed)) {
    throw new Error(`Invalid Boxdown toolchain result: ${context.toolchainResultPath}`)
  }

  return parsed
}

export function writeToolchainPlan (context: WorkspaceContext, plan: ToolchainPlan): void {
  if (!isToolchainPlan(plan, context.workspaceId)) {
    throw new Error(`Invalid Boxdown toolchain plan: ${context.toolchainPlanPath}`)
  }

  mkdirSync(context.toolchainsDir, {recursive: true})
  mkdirSync(context.toolchainResultDir, {recursive: true})
  writeJsonFileAtomically(context.toolchainPlanPath, plan)
  recordToolchainPlanUpdatedAt(context, plan.updatedAt)
}

export function writeToolchainResult (context: WorkspaceContext, result: ToolchainResult): void {
  if (!isToolchainResult(result)) {
    throw new Error(`Invalid Boxdown toolchain result: ${context.toolchainResultPath}`)
  }

  mkdirSync(context.toolchainResultDir, {recursive: true})
  writeJsonFileAtomically(context.toolchainResultPath, result)
}
