import { resolveAgentProfile, type AgentProfile } from './agent-profile.ts'
import {
  promptSelect,
  type PromptInput,
  type PromptOutput,
  type SelectPromptChoice
} from './interactive-prompts.ts'
import type { SshConfigInstallTarget } from './ssh-install-targets.ts'

const setupAgentProfileChoices: readonly SelectPromptChoice<AgentProfile>[] = [
  {
    value: 'none',
    label: 'No agent profile',
    description: 'Copy no host user-scoped agent data.'
  },
  {
    value: 'auth',
    label: 'Authentication and ~/.agents',
    description: 'Copy agent authentication and ~/.agents; Boxdown default.'
  },
  {
    value: 'full',
    label: 'Full agent profiles',
    description: 'Mount live read-write Codex, Claude, and ~/.agents host profiles.'
  }
]

export type SetupAgentProfileResult =
  | { cancelled: false, profile: AgentProfile }
  | { cancelled: true }

export interface ResolveSetupAgentProfileOptions {
  explicitProfile?: AgentProfile
  recordedProfile?: AgentProfile
  targets: readonly SshConfigInstallTarget[]
  input?: PromptInput
  output?: PromptOutput
  env?: NodeJS.ProcessEnv
}

export async function resolveSetupAgentProfile (
  options: ResolveSetupAgentProfileOptions
): Promise<SetupAgentProfileResult> {
  const current = resolveAgentProfile(
    options.explicitProfile,
    options.recordedProfile
  ).value

  if (options.explicitProfile !== undefined || options.targets.length === 0) {
    return { cancelled: false, profile: current }
  }

  const result = await promptSelect({
    title: 'How much host agent data should Boxdown use in the container?',
    choices: setupAgentProfileChoices,
    defaultValue: current,
    summaryLabel: 'Agent profile',
    input: options.input,
    output: options.output,
    env: options.env
  })

  if (result.status === 'cancelled') return { cancelled: true }
  if (result.status === 'non-interactive') {
    return { cancelled: false, profile: current }
  }

  return { cancelled: false, profile: result.value }
}
