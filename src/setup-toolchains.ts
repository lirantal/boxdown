import { canPromptInteractively, promptMultiSelect, type PromptInput, type PromptOutput } from './interactive-prompts.ts'
import { TOOLCHAIN_DEFAULTS } from './toolchains/defaults.ts'
import { detectToolchains, resolveDetectedVersion } from './toolchains/detect.ts'
import { resolveToolchainPlan, writeToolchainPlan } from './toolchains/plan.ts'
import { TOOLCHAIN_IDS, type DetectedToolchain, type ResolvedToolchain, type ToolchainPlan, type ToolchainSelector } from './toolchains/types.ts'
import type { WorkspaceContext } from './paths.ts'

export function formatDetectedToolchainsSummary (detected: readonly DetectedToolchain[]): string {
  const entries = detected.map((detection) => {
    const resolution = resolveDetectedVersion(detection)
    const paths = [...new Set([
      ...detection.evidence.map((item) => item.path),
      ...(detection.diagnostics ?? []).map((item) => item.path)
    ])]
    const source = paths.length === 0 ? 'project evidence' : paths.join(', ')

    if (resolution.kind === 'resolved') {
      return `${TOOLCHAIN_DEFAULTS[detection.id].label} ${resolution.version} (${source})`
    }

    return `${TOOLCHAIN_DEFAULTS[detection.id].label} needs review (${source})`
  })

  return `Detected toolchains: ${entries.length === 0 ? 'none' : entries.join('; ')}\n`
}

function selectedToolchainSource (toolchain: ResolvedToolchain): string {
  const selectionSource = toolchain.selectionSource === 'cli'
    ? 'CLI'
    : toolchain.selectionSource

  if (toolchain.resolutionSource === 'override') return `${selectionSource} override`
  if (toolchain.resolutionSource === 'project') return `${selectionSource} project`
  return `${selectionSource} Boxdown default`
}

export function formatSelectedToolchainsSummary (plan: ToolchainPlan): string {
  if (plan.selected.length === 0) return 'Selected toolchains: none\n'

  const selected = [...plan.selected]
    .sort((left, right) => TOOLCHAIN_IDS.indexOf(left.id) - TOOLCHAIN_IDS.indexOf(right.id))
  const lines = selected.flatMap((toolchain) => [
    `  ${TOOLCHAIN_DEFAULTS[toolchain.id].label} ${toolchain.version} (${selectedToolchainSource(toolchain)})`,
    ...(toolchain.compatibilityNote === undefined ? [] : [`    ${toolchain.compatibilityNote}`])
  ])

  return `Selected toolchains:\n${lines.join('\n')}\n`
}

function descriptionFor (detection: DetectedToolchain): string {
  const resolution = resolveDetectedVersion(detection)
  const evidence = detection.evidence[0]
  const source = evidence === undefined ? 'detected project markers' : `${evidence.path} ${evidence.source} ${evidence.value}`

  if (resolution.kind === 'resolved') {
    return `${source}; ${resolution.source === 'project' ? 'project version' : 'Boxdown default'} ${resolution.version}`
  }

  if (resolution.kind === 'incompatible-default') {
    return `${source}; Boxdown default ${resolution.defaultVersion} is incompatible with ${resolution.constraint}`
  }

  return `${source}; version needs review before automatic selection`
}

export async function resolveSetupToolchains (options: {
  context: WorkspaceContext
  selectors: readonly ToolchainSelector[]
  existingPlan?: ToolchainPlan
  input?: PromptInput
  output?: PromptOutput
  env?: NodeJS.ProcessEnv
}): Promise<{plan?: ToolchainPlan, detected: DetectedToolchain[], skippedNonInteractive?: boolean}> {
  const detected = detectToolchains(options.context.workspaceFolder)

  if (options.selectors.length > 0) {
    const plan = resolveToolchainPlan({
      workspaceId: options.context.workspaceId,
      detections: detected,
      selectors: options.selectors,
      selectionSource: 'cli'
    })
    writeToolchainPlan(options.context, plan)
    return {plan, detected}
  }

  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const env = options.env ?? process.env
  if (!canPromptInteractively(input, output, env)) {
    return {detected, skippedNonInteractive: true}
  }

  const detectionsById = new Map(detected.map((detection) => [detection.id, detection]))
  const prompt = await promptMultiSelect({
    title: 'Select workspace toolchains?',
    choices: TOOLCHAIN_IDS.map((id) => {
      const detection = detectionsById.get(id)

      return {
        value: id,
        label: TOOLCHAIN_DEFAULTS[id].label,
        description: detection === undefined
          ? `No project markers detected; Boxdown default ${TOOLCHAIN_DEFAULTS[id].version}`
          : descriptionFor(detection)
      }
    }),
    initialValues: detected
      .filter((detection) => resolveDetectedVersion(detection).kind === 'resolved')
      .map((detection) => detection.id),
    skipLabel: 'No toolchains',
    summaryLabel: 'Toolchains',
    input,
    output,
    env
  })

  if (prompt.status === 'cancelled' || prompt.status === 'non-interactive') {
    return {detected}
  }

  const plan = resolveToolchainPlan({
    workspaceId: options.context.workspaceId,
    detections: detected,
    selectors: prompt.status === 'skipped'
      ? [{kind: 'none'}]
      : prompt.values.map((id) => ({kind: 'runtime', id})),
    selectionSource: 'interactive'
  })
  writeToolchainPlan(options.context, plan)
  return {plan, detected}
}
