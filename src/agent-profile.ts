export const AGENT_PROFILES = ['none', 'auth', 'full'] as const

export type AgentProfile = typeof AGENT_PROFILES[number]

export const DEFAULT_AGENT_PROFILE: AgentProfile = 'auth'

export type AgentProfileSelectionSource = 'explicit' | 'metadata' | 'default'

export interface AgentProfileSelection {
  value: AgentProfile
  source: AgentProfileSelectionSource
}

export function isAgentProfile (value: string): value is AgentProfile {
  return AGENT_PROFILES.includes(value as AgentProfile)
}

export function resolveAgentProfile (
  explicit: AgentProfile | undefined,
  recorded: AgentProfile | undefined
): AgentProfileSelection {
  const value = explicit ?? recorded ?? DEFAULT_AGENT_PROFILE
  const source: AgentProfileSelectionSource = explicit !== undefined
    ? 'explicit'
    : recorded !== undefined
      ? 'metadata'
      : 'default'

  return { value, source }
}
