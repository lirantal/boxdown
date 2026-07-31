export const AGENT_PROFILES = ['none', 'auth', 'full'] as const

export type AgentProfile = typeof AGENT_PROFILES[number]

export type AgentProfileContainerMode = 'copy' | 'live' | 'legacy'

export interface ContainerAgentProfile {
  profile: AgentProfile
  mode: AgentProfileContainerMode
}

export function agentProfileMarker (profile: AgentProfile): string {
  return profile === 'full' ? 'full:live' : profile
}

export function parseAgentProfileMarker (
  value: string
): ContainerAgentProfile | undefined {
  if (value === 'full:live') return { profile: 'full', mode: 'live' }
  if (value === 'full') return { profile: 'full', mode: 'legacy' }
  if (value === 'none' || value === 'auth') return { profile: value, mode: 'copy' }
  return undefined
}

export function agentProfileAccessText (profile: AgentProfile): string {
  return profile === 'full'
    ? 'live, read-write host mounts'
    : 'container-local copy'
}

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
