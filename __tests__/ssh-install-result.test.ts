import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createProgress } from '../src/progress.ts'

import {
  formatRemoteAccessCancellation,
  formatRemoteAccessInstallReport,
  remoteAccessExitCode,
  writeRemoteAccessInstallReport,
  type RemoteAccessInstallReport
} from '../src/ssh-install-result.ts'

function successfulCursorReport (): RemoteAccessInstallReport {
  return {
    ssh: {
      kind: 'ssh', disposition: 'installed', summary: 'SSH alias configured', alias: 'demo-devcontainer',
      configPath: '/Users/demo/.ssh/config', identityPath: '/Users/demo/.local/share/boxdown/id_ed25519',
      validationCommand: "ssh demo-devcontainer 'whoami && pwd'",
      details: [
        { label: 'SSH alias', value: 'demo-devcontainer' },
        { label: 'SSH config', value: '/Users/demo/.ssh/config' },
        { label: 'Identity file', value: '/Users/demo/.local/share/boxdown/id_ed25519' }
      ]
    },
    apps: [{
      kind: 'app', target: 'cursor', appLabel: 'Cursor', disposition: 'installed', summary: 'Cursor configured', warnings: [],
      action: {
        label: 'Open this project in Cursor:',
        command: "cursor --folder-uri 'vscode-remote://ssh-remote+demo-devcontainer/workspaces/demo'",
        displayLines: ['cursor --folder-uri \\', "  'vscode-remote://ssh-remote+demo-devcontainer/workspaces/demo'"]
      },
      details: [
        { label: 'Cursor settings', value: '/Users/demo/Library/Application Support/Cursor/User/settings.json' },
        { label: 'Cursor remote folder URI', value: 'vscode-remote://ssh-remote+demo-devcontainer/workspaces/demo' }
      ]
    }],
    failures: [], skipped: [], notices: []
  }
}

describe('remote access install result rendering', () => {
  test('renders an action-first success without routine technical details', () => {
    const output = formatRemoteAccessInstallReport(successfulCursorReport(), { outcomeLabel: 'Configuration', interactive: false, columns: 60, verbose: false, color: false })
    assert.match(output, /SSH alias configured/)
    assert.match(output, /Cursor configured/)
    assert.match(output, /Configuration complete/)
    assert.match(output, /Next step/)
    assert.match(output, /Open this project in Cursor:/)
    assert.match(output, /cursor --folder-uri/)
    assert.doesNotMatch(output, /SSH connection not tested/)
    assert.doesNotMatch(output, /SSH config/)
    assert.doesNotMatch(output, /Cursor settings/)
    assert.doesNotMatch(output, /Cursor remote folder URI/)
    assert.doesNotMatch(output, /Identity file/)
  })

  test('renders warning remediation before the app action and keeps exit zero', () => {
    const report = successfulCursorReport()
    report.apps[0]?.warnings.push({ message: 'Cursor Remote SSH extension is not installed', remediation: { label: 'Install Cursor Remote SSH:', command: 'cursor --install-extension anysphere.remote-ssh' } })
    const output = formatRemoteAccessInstallReport(report, { outcomeLabel: 'Configuration', interactive: false, columns: 80, verbose: false, color: false })
    assert.match(output, /Configuration complete with warnings/)
    assert.ok(output.indexOf('cursor --install-extension') < output.indexOf('cursor --folder-uri'))
    assert.strictEqual(remoteAccessExitCode(report), 0)
  })

  test('renders failures, skips failed app actions, and returns exit one', () => {
    const report = successfulCursorReport()
    report.apps = []
    report.failures.push({ scope: 'app', target: 'cursor', label: 'Cursor', message: 'Cursor uses a different SSH config', recovery: { label: 'Update Cursor configuration, then rerun:', command: 'boxdown ssh install --target cursor' } })
    const output = formatRemoteAccessInstallReport(report, { outcomeLabel: 'Configuration', interactive: false, columns: 50, verbose: false, color: false })
    assert.match(output, /Configuration incomplete/)
    assert.match(output, /Cursor configuration failed/)
    assert.match(output, /Cursor uses a different SSH config/)
    assert.match(output, /boxdown ssh install --target cursor/)
    assert.doesNotMatch(output, /cursor --folder-uri/)
    assert.strictEqual(remoteAccessExitCode(report), 1)
  })

  test('shows technical details only when verbose is requested', () => {
    const normal = formatRemoteAccessInstallReport(successfulCursorReport(), { outcomeLabel: 'Configuration', interactive: false, columns: 80, verbose: false, color: false })
    const verbose = formatRemoteAccessInstallReport(successfulCursorReport(), { outcomeLabel: 'Configuration', interactive: false, columns: 80, verbose: true, color: false })
    assert.doesNotMatch(normal, /Identity file/)
    assert.doesNotMatch(normal, /SSH config/)
    assert.doesNotMatch(normal, /Cursor settings/)
    assert.match(verbose, /SSH config/)
    assert.match(verbose, /Identity file/)
    assert.match(verbose, /Cursor settings/)
    assert.match(verbose, /Cursor remote folder URI/)
  })

  test('wraps prose but never truncates a dedicated long value', () => {
    const report = successfulCursorReport()
    report.notices.push({ message: 'No optional app integrations were selected in this non-interactive shell.' })
    const output = formatRemoteAccessInstallReport(report, { outcomeLabel: 'Configuration', interactive: false, columns: 32, verbose: false, color: false })
    assert.match(output, /No optional app integrations\n\s+were selected in this/)
    assert.match(output, /cursor --folder-uri \\/)
    assert.match(output, /vscode-remote:\/\/ssh-remote\+demo-devcontainer\/workspaces\/demo/)
    assert.doesNotMatch(output, /Cursor settings/)
  })

  test('appends the outcome and handoff inside the active progress rail', () => {
    const lines: string[] = []
    const progress = createProgress({ mode: 'interactive', isTTY: false, color: false, write: (_target, message) => lines.push(message) })
    progress.section('Boxdown setup')
    progress.setSteps([{ id: 'cursor', label: 'Configuring Cursor' }])
    progress.startStep('cursor')
    progress.completeStep('cursor')
    writeRemoteAccessInstallReport(successfulCursorReport(), { outcomeLabel: 'Setup', verbose: false, progress, env: { NO_COLOR: '1' } })
    progress.end()
    const plain = lines.join('\n').replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    assert.match(plain, /│ {2}□ Configuring Cursor[\s\S]*│ {2}✔ Setup complete/)
    assert.match(plain, /│ {2}Next step[\s\S]*│ {2}Open this project in Cursor:/)
    assert.match(plain, /│ {4}cursor --folder-uri/)
    assert.ok(plain.trimEnd().endsWith('└'))
    assert.doesNotMatch(lines.join('\n'), /\u001B\[/)
  })

  test('uses color only for interactive output when color is enabled', () => {
    const colored = formatRemoteAccessInstallReport(successfulCursorReport(), { outcomeLabel: 'Configuration', interactive: true, columns: 80, verbose: false, color: true })
    const plain = formatRemoteAccessInstallReport(successfulCursorReport(), { outcomeLabel: 'Configuration', interactive: true, columns: 80, verbose: false, color: false })
    assert.match(colored, /\u001B\[/)
    assert.match(colored, /\u001B\[1mNext step\u001B\[0m/)
    assert.match(colored, /\u001B\[36mcursor --folder-uri/)
    assert.doesNotMatch(plain, /\u001B\[/)
  })

  test('NO_COLOR disables ANSI on an interactive output stream', () => {
    const chunks: string[] = []
    const output = { isTTY: true, columns: 80, write: (chunk: string) => { chunks.push(chunk); return true } } as NodeJS.WritableStream & { isTTY: boolean, columns: number }
    writeRemoteAccessInstallReport(successfulCursorReport(), { outcomeLabel: 'Configuration', verbose: false, output, env: { NO_COLOR: '1' } })
    assert.doesNotMatch(chunks.join(''), /\u001B\[/)
  })

  test('preserves a PowerShell command without POSIX continuation syntax', () => {
    const report = successfulCursorReport()
    const app = report.apps[0]
    assert.notStrictEqual(app, undefined)
    if (app === undefined) return
    app.action = { label: 'Open this project in Cursor:', commandLabel: 'PowerShell', command: 'cursor --folder-uri "vscode-remote://ssh-remote+demo-devcontainer/workspaces/demo"', displayLines: ['cursor --folder-uri "vscode-remote://ssh-remote+demo-devcontainer/workspaces/demo"'] }
    const output = formatRemoteAccessInstallReport(report, { outcomeLabel: 'Configuration', interactive: false, columns: 40, verbose: false, color: false })
    assert.match(output, /PowerShell/)
    assert.match(output, /cursor --folder-uri "vscode-remote:/)
    assert.doesNotMatch(output, /folder-uri \\/)
  })

  test('formats cancellation without implying mutation', () => {
    assert.strictEqual(formatRemoteAccessCancellation('SSH install', { color: false }), 'SSH install canceled. No changes made.\n')
  })
})
