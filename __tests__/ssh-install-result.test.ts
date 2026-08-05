import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkspaceContext } from '../src/paths.ts'
import { createProgress, type ProgressReporter } from '../src/progress.ts'
import { installSshConfig } from '../src/ssh-config.ts'
import { installSshInstallTarget } from '../src/ssh-install-targets.ts'
import { installRemoteAccess, remoteAccessProgressSteps } from '../src/ssh-install.ts'
import type { WorkspaceContext } from '../src/paths.ts'
import type { AppInstallResult, SshAliasInstallResult } from '../src/ssh-install-result.ts'
import type { SshConfigInstallTarget } from '../src/ssh-install-targets.ts'

import {
  formatRemoteAccessCancellation,
  formatRemoteAccessInstallReport,
  remoteAccessExitCode,
  writeRemoteAccessInstallReport,
  type RemoteAccessInstallReport
} from '../src/ssh-install-result.ts'

function tempInstallDir (name: string): string {
  return mkdtempSync(join(tmpdir(), `boxdown-result-${name}-`))
}

function installedCursorCli (): string {
  const binDir = tempInstallDir('cursor-bin')
  const cursorPath = join(binDir, 'cursor')
  writeFileSync(cursorPath, '#!/usr/bin/env bash\nprintf "%s\\n" "anysphere.remote-ssh"\n')
  chmodSync(cursorPath, 0o755)
  return binDir
}

function captureTerminalText (chunks: string[], chunk: string | Uint8Array): boolean {
  const text = String(chunk)
  if (/^[\t\n\r -~]*$/u.test(text)) chunks.push(text)
  return true
}

async function withInstallEnvironment<T> (
  overrides: Record<string, string>,
  run: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

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

const coordinatorContext = {} as WorkspaceContext
const coordinatorAlias = 'demo-devcontainer'
const coordinatorSshResult: SshAliasInstallResult = successfulCursorReport().ssh as SshAliasInstallResult

function appResultFor (target: SshConfigInstallTarget): AppInstallResult {
  const appLabel = target === 'codex' ? 'ChatGPT' : target === 'claude' ? 'Claude' : 'Cursor'
  return {
    kind: 'app',
    target,
    appLabel,
    disposition: 'installed',
    summary: `${appLabel} configured`,
    warnings: [],
    action: { label: `Open ${appLabel}.` },
    details: []
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
    assert.match(output, /cursor --folder-uri 'vscode-remote:\/\/ssh-remote\+demo-devcontainer\/workspaces\/demo'/)
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

  test('removes a redundant app suffix from failure and skipped labels', () => {
    const report = successfulCursorReport()
    report.apps = []
    report.failures.push({ scope: 'app', target: 'codex', label: 'ChatGPT app', message: 'Invalid JSON' })
    report.skipped.push({ target: 'codex', label: 'ChatGPT app', reason: 'SSH alias configuration failed' })

    const output = formatRemoteAccessInstallReport(report, { outcomeLabel: 'Configuration', interactive: false, columns: 80, verbose: false, color: false })

    assert.match(output, /ChatGPT configuration failed/)
    assert.match(output, /ChatGPT skipped/)
    assert.doesNotMatch(output, /ChatGPT app (?:configuration failed|skipped)/)
  })

  test('omits every action for a failed app target while retaining later successful actions', () => {
    const report = successfulCursorReport()
    report.apps[0]?.warnings.push({
      message: 'Cursor Remote SSH extension is not installed',
      remediation: { label: 'Install Cursor Remote SSH:', command: 'cursor --install-extension anysphere.remote-ssh' }
    })
    report.failures.push({
      scope: 'app', target: 'cursor', label: 'Cursor', message: 'Cursor uses a different SSH config'
    })
    report.apps.push({
      ...report.apps[0]!,
      target: 'codex',
      appLabel: 'Codex',
      summary: 'Codex configured',
      warnings: [],
      action: { label: 'Open this project in Codex:', command: 'codex --remote ssh://demo-devcontainer/workspaces/demo' }
    })

    const output = formatRemoteAccessInstallReport(report, { outcomeLabel: 'Configuration', interactive: false, columns: 80, verbose: false, color: false })

    assert.doesNotMatch(output, /cursor --install-extension/)
    assert.doesNotMatch(output, /cursor --folder-uri/)
    assert.match(output, /codex --remote ssh:\/\/demo-devcontainer\/workspaces\/demo/)
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
    const output = formatRemoteAccessInstallReport(report, { outcomeLabel: 'Configuration', interactive: true, columns: 32, verbose: false, color: false })
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

test('maps SSH install and idempotent reinstall to structured results', async () => {
  const workspace = tempInstallDir('ssh-workspace')
  const sshConfigPath = join(tempInstallDir('ssh-config'), 'config')
  const context = createWorkspaceContext({
    workspace,
    env: {
      HOME: tempInstallDir('ssh-home'),
      BOXDOWN_DATA_HOME: tempInstallDir('ssh-data')
    }
  })
  const alias = `${context.workspaceBasename}-devcontainer`
  const first = await installSshConfig(context, alias, { configPath: sshConfigPath })
  const second = await installSshConfig(context, alias, { configPath: sshConfigPath })

  assert.strictEqual(first.disposition, 'installed')
  assert.strictEqual(first.summary, 'SSH alias configured')
  assert.strictEqual(first.configPath, sshConfigPath)
  assert.strictEqual(first.identityPath, context.sshKeyPath)
  assert.strictEqual(first.validationCommand, `ssh ${alias} 'whoami && pwd'`)
  assert.strictEqual(second.disposition, 'already-current')
  assert.strictEqual(second.summary, 'SSH alias already configured')
})

test('keeps direct SSH and app installs presentation-free', async () => {
  const workspace = tempInstallDir('silent-installs-workspace')
  const context = createWorkspaceContext({
    workspace,
    env: {
      HOME: tempInstallDir('silent-installs-home'),
      BOXDOWN_DATA_HOME: tempInstallDir('silent-installs-data')
    }
  })
  const alias = `${context.workspaceBasename}-devcontainer`
  const sshConfigPath = join(tempInstallDir('silent-installs-ssh'), 'config')
  const cursorBinDir = installedCursorCli()
  const stdout: string[] = []
  const stderr: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write

  await withInstallEnvironment({
    HOME: tempInstallDir('silent-installs-apps-home'),
    BOXDOWN_CODEX_APP_CONFIG: join(tempInstallDir('silent-installs-codex'), 'config.json'),
    BOXDOWN_CODEX_GLOBAL_STATE: join(tempInstallDir('silent-installs-codex-state'), 'state.json'),
    BOXDOWN_CLAUDE_SSH_CONFIGS: join(tempInstallDir('silent-installs-claude'), 'ssh_configs.json'),
    BOXDOWN_CURSOR_SETTINGS: join(tempInstallDir('silent-installs-cursor'), 'settings.json'),
    BOXDOWN_HOST_PATH_PREFIX: cursorBinDir
  }, async () => {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      return captureTerminalText(stdout, chunk)
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      return captureTerminalText(stderr, chunk)
    }) as typeof process.stderr.write

    try {
      const ssh = await installSshConfig(context, alias, { configPath: sshConfigPath })
      const chatgpt = await installSshInstallTarget(context, alias, 'codex')
      const claude = await installSshInstallTarget(context, alias, 'claude')
      const cursor = await installSshInstallTarget(context, alias, 'cursor')

      assert.strictEqual(ssh.kind, 'ssh')
      assert.strictEqual(chatgpt.kind, 'app')
      assert.strictEqual(claude.kind, 'app')
      assert.strictEqual(cursor.kind, 'app')
      assert.deepStrictEqual(cursor.warnings, [])
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
    }
  })

  assert.deepStrictEqual(stdout, [])
  assert.deepStrictEqual(stderr, [])
})

test('maps ChatGPT and Claude installs to the common app contract', async () => {
  const workspace = tempInstallDir('apps-workspace')
  const context = createWorkspaceContext({
    workspace,
    env: {
      HOME: tempInstallDir('apps-home'),
      BOXDOWN_DATA_HOME: tempInstallDir('apps-data')
    }
  })
  const alias = `${context.workspaceBasename}-devcontainer`
  const chatgptConfigPath = join(tempInstallDir('chatgpt-config'), 'config.json')
  const chatgptStatePath = join(tempInstallDir('chatgpt-state'), 'state.json')
  const claudeConfigPath = join(tempInstallDir('claude-config'), 'ssh_configs.json')
  const appsHome = tempInstallDir('apps-process-home')

  const { chatgpt, claude } = await withInstallEnvironment({
    HOME: appsHome,
    BOXDOWN_CODEX_APP_CONFIG: chatgptConfigPath,
    BOXDOWN_CODEX_GLOBAL_STATE: chatgptStatePath,
    BOXDOWN_CLAUDE_SSH_CONFIGS: claudeConfigPath
  }, async () => ({
    chatgpt: await installSshInstallTarget(context, alias, 'codex'),
    claude: await installSshInstallTarget(context, alias, 'claude')
  }))

  assert.deepStrictEqual({ target: chatgpt.target, label: chatgpt.appLabel, disposition: chatgpt.disposition }, {
    target: 'codex', label: 'ChatGPT', disposition: 'installed'
  })
  assert.match(chatgpt.action.label, /Restart ChatGPT/)
  assert.deepStrictEqual({ target: claude.target, label: claude.appLabel, disposition: claude.disposition }, {
    target: 'claude', label: 'Claude', disposition: 'installed'
  })
  assert.match(claude.action.label, /Restart Claude/)
})

describe('remote access installation coordination', () => {
  test('skips every app when SSH installation fails', async () => {
    const targetCalls: string[] = []
    const report = await installRemoteAccess(coordinatorContext, coordinatorAlias, ['codex', 'cursor'], {
      installSsh: async () => { throw new Error('SSH config is not writable') },
      installTarget: async (_context, _alias, target) => {
        targetCalls.push(target)
        throw new Error('must not run')
      }
    })

    assert.deepStrictEqual(targetCalls, [])
    assert.deepStrictEqual(report.failures.map((failure) => failure.scope), ['ssh'])
    assert.deepStrictEqual(report.skipped.map((skipped) => skipped.target), ['codex', 'cursor'])
    assert.strictEqual(report.failures[0]?.message, 'SSH config is not writable')
    assert.doesNotMatch(report.failures[0]?.message ?? '', /^Error:/)
    assert.strictEqual(remoteAccessExitCode(report), 1)
  })

  test('continues after one app fails and preserves target order', async () => {
    const targetCalls: string[] = []
    const report = await installRemoteAccess(coordinatorContext, coordinatorAlias, ['codex', 'claude', 'cursor'], {
      installSsh: async () => coordinatorSshResult,
      installTarget: async (_context, _alias, target) => {
        targetCalls.push(target)
        if (target === 'codex') throw new Error('invalid ChatGPT config')
        return appResultFor(target)
      }
    })

    assert.deepStrictEqual(targetCalls, ['codex', 'claude', 'cursor'])
    assert.deepStrictEqual(report.failures.map((failure) => failure.target), ['codex'])
    assert.deepStrictEqual(report.apps.map((app) => app.target), ['claude', 'cursor'])
    assert.strictEqual(remoteAccessExitCode(report), 1)
  })

  test('defines progress steps in target order', () => {
    assert.deepStrictEqual(remoteAccessProgressSteps(['cursor', 'codex']), [
      { id: 'ssh-alias', label: 'Configuring SSH alias' },
      { id: 'ssh-target:cursor', label: 'Configuring Cursor' },
      { id: 'ssh-target:codex', label: 'Configuring ChatGPT app' }
    ])
  })

  test('reports successful, failed, and skipped dependency progress events', async () => {
    const events: string[] = []
    const progress: Pick<ProgressReporter, 'startStep' | 'completeStep' | 'failStep' | 'skipStep'> = {
      startStep: (id: string) => events.push(`start:${id}`),
      completeStep: (id: string) => events.push(`complete:${id}`),
      failStep: (id: string) => events.push(`fail:${id}`),
      skipStep: (id: string) => events.push(`skip:${id}`)
    }

    await installRemoteAccess(coordinatorContext, coordinatorAlias, ['codex', 'claude', 'cursor'], {
      progress: progress as ProgressReporter,
      installSsh: async () => coordinatorSshResult,
      installTarget: async (_context, _alias, target) => {
        if (target === 'codex') throw new Error('bad ChatGPT config')
        return appResultFor(target)
      }
    })
    await installRemoteAccess(coordinatorContext, coordinatorAlias, ['codex', 'claude', 'cursor'], {
      progress: progress as ProgressReporter,
      installSsh: async () => { throw new Error('bad SSH config') },
      installTarget: async () => { throw new Error('must not run') }
    })

    assert.deepStrictEqual(events, [
      'start:ssh-alias',
      'complete:ssh-alias',
      'start:ssh-target:codex',
      'fail:ssh-target:codex',
      'start:ssh-target:claude',
      'complete:ssh-target:claude',
      'start:ssh-target:cursor',
      'complete:ssh-target:cursor',
      'start:ssh-alias',
      'fail:ssh-alias',
      'skip:ssh-target:codex',
      'skip:ssh-target:claude',
      'skip:ssh-target:cursor'
    ])
  })
})
