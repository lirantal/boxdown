import assert from 'node:assert'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { buildGeneratedDevcontainerConfig, publishContainerPortFromConfig } from '../src/config.ts'
import { doctorHasFailures, formatDoctorText } from '../src/doctor.ts'
import { parseJsonc } from '../src/jsonc.ts'
import { parseCliArgs, USAGE } from '../src/main.ts'
import { createWorkspaceContext } from '../src/paths.ts'
import { DEFAULT_TTY_MAX_COLUMNS, interactiveShellEnvArgs, interactiveShellScript } from '../src/shell.ts'
import { buildSshConfigBlock, defaultSshAlias, replaceSshConfigBlock } from '../src/ssh-config.ts'
import { createStatusInfo, formatStatusText, parseDockerPsJsonLines, statusIsHealthy } from '../src/status.ts'

const assetsDevcontainerDir = fileURLToPath(new URL('../assets/devcontainer', import.meta.url))

function tempDir (name: string): string {
  return mkdtempSync(join(tmpdir(), `boxdown-${name}-`))
}

describe('CLI parsing', () => {
  test('parses start options', () => {
    assert.deepStrictEqual(parseCliArgs(['start', '--workspace', '/tmp/project', '--recreate']), {
      command: 'start',
      workspace: '/tmp/project',
      alias: undefined,
      recreate: true,
      json: false
    })
  })

  test('maps shell to start', () => {
    assert.strictEqual(parseCliArgs(['shell']).command, 'start')
  })

  test('parses ssh-config install', () => {
    assert.deepStrictEqual(parseCliArgs(['ssh-config', 'install', '--alias', 'demo-devcontainer']), {
      command: 'ssh-config-install',
      workspace: undefined,
      alias: 'demo-devcontainer',
      recreate: false,
      json: false
    })
  })

  test('parses lifecycle commands', () => {
    assert.deepStrictEqual(parseCliArgs(['status', '--workspace', '/tmp/project', '--alias', 'demo-devcontainer', '--json']), {
      command: 'status',
      workspace: '/tmp/project',
      alias: 'demo-devcontainer',
      recreate: false,
      json: true
    })
    assert.strictEqual(parseCliArgs(['stop']).command, 'stop')
    assert.strictEqual(parseCliArgs(['down']).command, 'down')
    assert.strictEqual(parseCliArgs(['doctor']).command, 'doctor')
  })

  test('rejects unknown commands', () => {
    assert.throws(() => parseCliArgs(['ssh-config', 'remove']), /Unknown command/)
    assert.throws(() => parseCliArgs(['install-ssh-config']), /Unknown command/)
    assert.throws(() => parseCliArgs(['start', '--json']), /--json is only supported with status/)
  })

  test('help describes available commands', () => {
    const usageLines = USAGE.split(/\r?\n/)

    assert.match(USAGE, /Commands:/)
    assert.match(USAGE, /start\s+Start or reuse the workspace devcontainer/)
    assert.match(USAGE, /Alias: shell/)
    assert.match(USAGE, /status\s+Show workspace state/)
    assert.match(USAGE, /stop\s+Stop the workspace devcontainer/)
    assert.match(USAGE, /down\s+Remove the workspace devcontainer/)
    assert.match(USAGE, /doctor\s+Check required host tools/)
    assert.ok(!usageLines.includes('  boxdown shell [--workspace <path>] [--recreate]'))
    assert.ok(!usageLines.includes('  boxdown install-ssh-config [--workspace <path>] [--alias <name>]'))
    assert.ok(!usageLines.some((line) => line.startsWith('  shell')))
    assert.ok(!usageLines.some((line) => line.startsWith('  install-ssh-config')))
    assert.match(USAGE, /ssh-config install\s+Install or update an SSH host alias/)
    assert.match(USAGE, /ssh-proxy\s+Internal command used by the generated SSH/)
    assert.match(USAGE, /refresh-gh-token\s+Start or reuse the devcontainer/)
    assert.match(USAGE, /refresh-gh-token-running\s+Refresh GitHub CLI auth only if/)
  })
})

describe('workspace state', () => {
  test('resolves workspace and XDG-style state paths', () => {
    const workspace = tempDir('workspace')
    const cache = tempDir('cache')
    const data = tempDir('data')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: cache,
        BOXDOWN_DATA_HOME: data
      },
      assetsDevcontainerDir
    })

    assert.strictEqual(context.workspaceFolder, realpathSync(workspace))
    assert.strictEqual(context.workspaceBasename, realpathSync(workspace).split('/').at(-1))
    assert.match(context.workspaceId, /^[a-f0-9]{16}$/)
    assert.ok(context.generatedConfigPath.startsWith(cache))
    assert.ok(context.sshKeyPath.startsWith(data))
    assert.strictEqual(context.assetsDevcontainerDir, assetsDevcontainerDir)
  })
})

describe('status output', () => {
  test('parses docker ps JSON lines', () => {
    assert.deepStrictEqual(parseDockerPsJsonLines('{"ID":"abc123","Names":"demo","State":"running","Status":"Up 2 minutes"}\n'), [
      {
        id: 'abc123',
        name: 'demo',
        state: 'running',
        status: 'Up 2 minutes'
      }
    ])

    assert.deepStrictEqual(parseDockerPsJsonLines(''), [])
  })

  test('rejects malformed docker ps JSON lines', () => {
    assert.throws(() => parseDockerPsJsonLines('not json'), /Could not parse docker ps output/)
    assert.throws(() => parseDockerPsJsonLines('{"Names":"demo"}'), /missing container ID/)
  })

  test('formats status for running and absent containers', () => {
    const workspace = tempDir('status-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('status-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-data')
      },
      assetsDevcontainerDir
    })
    const exists = (path: string): boolean => [
      context.generatedConfigPath,
      context.assetsDevcontainerDir,
      context.sshKeyPath,
      context.sshPublicKeyPath,
      context.sshPublicKeyRuntimePath
    ].includes(path)
    const running = createStatusInfo(context, 'demo-devcontainer', {
      id: 'abc123',
      name: 'demo',
      state: 'running',
      status: 'Up 2 minutes'
    }, exists)
    const stopped = createStatusInfo(context, 'demo-devcontainer', {
      id: 'def456',
      name: 'demo',
      state: 'exited',
      status: 'Exited (0) 1 minute ago'
    }, exists)
    const absent = createStatusInfo(context, 'demo-devcontainer', undefined, () => false)

    assert.strictEqual(running.container.running, true)
    assert.strictEqual(statusIsHealthy(running), true)
    assert.strictEqual(stopped.container.running, false)
    assert.strictEqual(statusIsHealthy(stopped), false)
    assert.strictEqual(absent.container.found, false)
    assert.strictEqual(statusIsHealthy(absent), false)
    assert.match(formatStatusText(running), /State: running/)
    assert.match(formatStatusText(stopped), /State: exited/)
    assert.match(formatStatusText(running), /Generated config: .* \(yes\)/)
    assert.match(formatStatusText(absent), /State: absent/)
    assert.match(formatStatusText(absent, { color: true }), /\u001B\[31mno\u001B\[0m/)
    assert.match(formatStatusText(running, { color: true }), /\u001B\[32myes\u001B\[0m/)
  })
})

describe('doctor output', () => {
  test('formats doctor checks and detects failures', () => {
    const passing = [
      { name: 'node', level: 'ok' as const, message: 'Node 24.15.0' },
      { name: 'gh', level: 'warn' as const, message: 'GitHub CLI is optional and was not available' }
    ]
    const failing = [
      ...passing,
      { name: 'docker-daemon', level: 'fail' as const, message: 'Docker daemon is required but was not reachable' }
    ]

    assert.strictEqual(doctorHasFailures(passing), false)
    assert.strictEqual(doctorHasFailures(failing), true)
    assert.match(formatDoctorText(passing), /\[ok\] node: Node 24\.15\.0/)
    assert.match(formatDoctorText(passing), /\[warn\] gh:/)
    assert.match(formatDoctorText(failing), /Result: failed/)
  })
})

describe('devcontainer config generation', () => {
  test('rewrites lifecycle paths to Boxdown assets and mounted runtime', () => {
    const workspace = tempDir('config-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('config-cache'),
        BOXDOWN_DATA_HOME: tempDir('config-data')
      },
      assetsDevcontainerDir
    })

    const config = buildGeneratedDevcontainerConfig(context)

    assert.match(config.initializeCommand ?? '', /BOXDOWN_WORKSPACE_FOLDER=/)
    assert.match(config.initializeCommand ?? '', /assets\/devcontainer\/hooks\/initialize\.sh/)
    assert.strictEqual(config.postCreateCommand, "bash '/opt/boxdown/devcontainer/hooks/post-create.sh'")
    assert.strictEqual(config.postStartCommand, "bash '/opt/boxdown/devcontainer/hooks/post-start.sh'")
    assert.ok(config.mounts?.some((mount) => mount.includes(`source=${assetsDevcontainerDir}`)))
    assert.ok(config.mounts?.some((mount) => mount.includes(`source=${context.sshPublicKeyRuntimeDir}`)))
    assert.ok(!config.mounts?.some((mount) => mount.startsWith(`type=bind,source=${context.sshKeyDir},`)))
    assert.strictEqual(config.containerEnv?.DEVCONTAINER_SSH_PUBLIC_KEY_FILE, '/opt/boxdown/state/ssh/id_ed25519.pub')
    assert.strictEqual(publishContainerPortFromConfig(config), '3000')
  })

  test('parses JSONC without stripping URLs inside strings', () => {
    const parsed = parseJsonc<{ url: string }>('{ "url": "https://example.com/path" // keep string URL\n }')
    assert.strictEqual(parsed.url, 'https://example.com/path')
  })
})

describe('interactive shell setup', () => {
  test('defaults to conservative TTY width normalization', () => {
    assert.deepStrictEqual(interactiveShellEnvArgs({ TERM: 'xterm-kitty' }), [
      'TERM=xterm-kitty',
      'COLORTERM=truecolor',
      'BOXDOWN_TTY_NORMALIZE=1',
      `BOXDOWN_TTY_MAX_COLUMNS=${DEFAULT_TTY_MAX_COLUMNS}`
    ])
  })

  test('allows terminal width normalization overrides', () => {
    assert.deepStrictEqual(interactiveShellEnvArgs({
      TERM: 'xterm-256color',
      BOXDOWN_TTY_NORMALIZE: '0',
      BOXDOWN_TTY_MAX_COLUMNS: '180'
    }), [
      'TERM=xterm-256color',
      'COLORTERM=truecolor',
      'BOXDOWN_TTY_NORMALIZE=0',
      'BOXDOWN_TTY_MAX_COLUMNS=180'
    ])
  })

  test('clamps only oversized interactive TTY columns before opening bash', () => {
    const script = interactiveShellScript()

    assert.match(script, /stty size/)
    assert.match(script, /stty cols "\$max_columns"/)
    assert.match(script, /BOXDOWN_TTY_NORMALIZE/)
    assert.match(script, /exec bash -i/)
  })
})

describe('SSH config generation', () => {
  test('builds default alias and npx proxy command', () => {
    const workspace = tempDir('ssh-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-data')
      },
      assetsDevcontainerDir
    })

    const alias = defaultSshAlias(context.workspaceBasename)
    const block = buildSshConfigBlock(context, alias)

    assert.strictEqual(alias, `${context.workspaceBasename}-devcontainer`)
    assert.ok(block.includes(`Host ${alias}`))
    assert.match(block, /ProxyCommand npx --yes boxdown ssh-proxy/)
    assert.match(block, /--workspace '/)
    assert.match(block, /IdentityFile "/)
  })

  test('replaces managed block idempotently', () => {
    const workspace = tempDir('ssh-replace-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-replace-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-replace-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const block = buildSshConfigBlock(context, alias)

    const first = replaceSshConfigBlock('Host github.com\n  User git\n', alias, block)
    const second = replaceSshConfigBlock(first, alias, block)

    assert.strictEqual(second, first)
    assert.match(second, /Host github.com/)
    assert.strictEqual(second.split(`# BEGIN ${alias} boxdown`).length - 1, 1)
  })
})

describe('packaged assets', () => {
  test('does not include generated SSH key material', () => {
    assert.strictEqual(existsSync(join(assetsDevcontainerDir, '.ssh')), false)
  })
})
