export type CodingAgentCli = 'codex' | 'opencode' | 'claude' | 'antigravity'
export type CodingAgentCommandAlias = CodingAgentCli | 'cc'

const CODING_AGENT_ALIASES: Record<CodingAgentCommandAlias, CodingAgentCli> = {
  codex: 'codex',
  opencode: 'opencode',
  claude: 'claude',
  cc: 'claude',
  antigravity: 'antigravity'
}

export function codingAgentFromCommand (command: string): CodingAgentCli | undefined {
  return CODING_AGENT_ALIASES[command as CodingAgentCommandAlias]
}

export function codingAgentBinary (agent: CodingAgentCli): string {
  if (agent === 'antigravity') {
    return 'agy'
  }

  return agent
}
