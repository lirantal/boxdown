export const ansi = {
  bold: '\u001B[1m',
  cyan: '\u001B[36m',
  dim: '\u001B[2m',
  green: '\u001B[32m',
  red: '\u001B[31m',
  yellow: '\u001B[33m',
  reset: '\u001B[0m'
} as const

export type CliColor = keyof typeof ansi

export function color (value: string, colorName: CliColor): string {
  return `${ansi[colorName]}${value}${ansi.reset}`
}

export function maybeColor (value: string, colorName: CliColor, enabled: boolean): string {
  return enabled ? color(value, colorName) : value
}

export function selectedMark (enabled = true): string {
  return maybeColor('■', 'green', enabled)
}

export function emptyMark (isFocused: boolean): string {
  return color('□', isFocused ? 'cyan' : 'dim')
}

export function promptRail (enabled = true): string {
  return maybeColor('│', 'cyan', enabled)
}

export function formatPromptTitle (title: string, enabled = true): string {
  return `${maybeColor('◆', 'cyan', enabled)}  ${maybeColor(title, 'bold', enabled)}`
}

export function formatPromptEnd (enabled = true): string {
  return maybeColor('└', 'cyan', enabled)
}

export function formatPromptLabel (label: string, isFocused: boolean): string {
  return color(label, isFocused ? 'bold' : 'dim')
}

export function formatPromptDetailLine (detail: string): string {
  return `${promptRail()}  ${color(detail, 'dim')}`
}
