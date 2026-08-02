import type { ToolchainId } from './types.ts'

export const TOOLCHAIN_DEFAULTS: Record<ToolchainId, {version: string, label: string}> = {
  node: {version: '24.17.0', label: 'Node.js'},
  python: {version: '3.14.6', label: 'Python'},
  go: {version: '1.26.5', label: 'Go'},
  rust: {version: '1.97.1', label: 'Rust'}
}
