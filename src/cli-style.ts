import { wrapWithPrefixes } from './terminal-layout.ts'

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

export function emptyMark (isFocused: boolean, enabled = true): string {
  return maybeColor('□', isFocused ? 'cyan' : 'dim', enabled)
}

export function promptRail (enabled = true): string {
  return maybeColor('│', 'cyan', enabled)
}

export function formatPromptTitle (title: string, enabled = true): string {
  return `${maybeColor('◆', 'cyan', enabled)}  ${maybeColor(title, 'bold', enabled)}`
}

export function formatPromptTitleLines (
  title: string,
  columns: number,
  enabled = true
): string[] {
  const firstPrefix = `${maybeColor('◆', 'cyan', enabled)}  `
  const continuationPrefix = `${promptRail(enabled)}  `

  return wrapWithPrefixes(title, firstPrefix, continuationPrefix, columns)
    .map((line, index) => {
      const prefix = index === 0 ? firstPrefix : continuationPrefix
      return `${prefix}${maybeColor(line.slice(prefix.length), 'bold', enabled)}`
    })
}

export function formatPromptEnd (enabled = true): string {
  return maybeColor('└', 'cyan', enabled)
}

export function formatPromptLabel (label: string, isFocused: boolean, enabled = true): string {
  return maybeColor(label, isFocused ? 'bold' : 'dim', enabled)
}

export function formatPromptDetailLine (detail: string, enabled = true): string {
  return `${promptRail(enabled)}  ${maybeColor(detail, 'dim', enabled)}`
}

export function formatPromptDetailLines (
  detail: string,
  columns: number,
  enabled = true
): string[] {
  const prefix = `${promptRail(enabled)}  `

  return wrapWithPrefixes(detail, prefix, prefix, columns)
    .map((line) => `${prefix}${maybeColor(line.slice(prefix.length), 'dim', enabled)}`)
}
