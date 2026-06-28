export function shellQuote (value: string): string {
  if (value.length === 0) {
    return "''"
  }

  return `'${value.replaceAll("'", "'\\''")}'`
}

export function sshConfigQuote (value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export const DEFAULT_TTY_MAX_COLUMNS = 120

export function interactiveShellEnvArgs (env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    `TERM=${env.TERM ?? 'xterm-256color'}`,
    'COLORTERM=truecolor',
    `BOXDOWN_TTY_NORMALIZE=${env.BOXDOWN_TTY_NORMALIZE ?? '1'}`,
    `BOXDOWN_TTY_MAX_COLUMNS=${env.BOXDOWN_TTY_MAX_COLUMNS ?? String(DEFAULT_TTY_MAX_COLUMNS)}`
  ]
}

function interactiveTtySetupScript (): string {
  return [
    'if [ -t 0 ]; then',
    '  case "${BOXDOWN_TTY_NORMALIZE:-1}" in',
    '    0|false|FALSE|no|NO|off|OFF) ;;',
    '    *)',
    '      max_columns="${BOXDOWN_TTY_MAX_COLUMNS:-120}"',
    '      if [ "$max_columns" -gt 0 ] 2>/dev/null; then',
    '        set -- $(stty size 2>/dev/null || true)',
    '        rows="${1:-}"',
    '        columns="${2:-}"',
    '        if [ -n "$columns" ] && [ "$columns" -gt "$max_columns" ] 2>/dev/null; then',
    '          stty cols "$max_columns" 2>/dev/null || true',
    '          export COLUMNS="$max_columns"',
    '          if [ -n "$rows" ]; then export LINES="$rows"; fi',
    '          printf "Boxdown: terminal width clamped to %s columns (was %s). Set BOXDOWN_TTY_NORMALIZE=0 to disable.\\n" "$max_columns" "$columns" >&2',
    '        fi',
    '      fi',
    '      ;;',
    '  esac',
    'fi',
  ].join('\n')
}

function interactiveTermSetupScript (): string {
  return [
    'if ! infocmp "${TERM:-xterm-256color}" >/dev/null 2>&1; then',
    '  export TERM=xterm-256color',
    'fi',
    'export COLORTERM="${COLORTERM:-truecolor}"'
  ].join('\n')
}

export function interactiveShellScript (): string {
  return [
    interactiveTermSetupScript(),
    interactiveTtySetupScript(),
    'exec bash -i'
  ].join('\n')
}

export function interactiveCommandScript (): string {
  return [
    interactiveTermSetupScript(),
    interactiveTtySetupScript(),
    'exec "$@"'
  ].join('\n')
}
