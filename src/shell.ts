export function shellQuote (value: string): string {
  if (value.length === 0) {
    return "''"
  }

  return `'${value.replaceAll("'", "'\\''")}'`
}

export function sshConfigQuote (value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
