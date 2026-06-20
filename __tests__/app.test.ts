import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { codingAgentBinary, codingAgentFromCommand } from '../src/coding-agents.ts'
import { buildGeneratedDevcontainerConfig, publishContainerPortFromConfig } from '../src/config.ts'
import { DEVCONTAINER_CLI_VERSION } from '../src/constants.ts'
import { codingAgentDevcontainerExecArgs } from '../src/devcontainer.ts'
import { resolveDevcontainerCli } from '../src/devcontainer-cli.ts'
import { doctorHasFailures, formatDoctorText } from '../src/doctor.ts'
import { canonicalGithubRemoteUrl, configureWorkspaceGithubGitAuth } from '../src/github-git-auth.ts'
import { parseJsonc } from '../src/jsonc.ts'
import { createWorkspaceListEntries, formatWorkspaceListText } from '../src/list.ts'
import { parseCliArgs, USAGE } from '../src/main.ts'
import { listWorkspaceMetadata, writeWorkspaceMetadata } from '../src/metadata.ts'
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

  test('parses coding-agent launch aliases', () => {
    assert.deepStrictEqual(parseCliArgs(['codex']), {
      command: 'coding-agent',
      agent: 'codex',
      agentArgs: [],
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false
    })
    assert.deepStrictEqual(parseCliArgs(['claude']), {
      command: 'coding-agent',
      agent: 'claude',
      agentArgs: [],
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false
    })
    assert.deepStrictEqual(parseCliArgs(['cc']), {
      command: 'coding-agent',
      agent: 'claude',
      agentArgs: [],
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false
    })
    assert.deepStrictEqual(parseCliArgs(['opencode']), {
      command: 'coding-agent',
      agent: 'opencode',
      agentArgs: [],
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false
    })
    assert.deepStrictEqual(parseCliArgs(['antigravity']), {
      command: 'coding-agent',
      agent: 'antigravity',
      agentArgs: [],
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false
    })
  })

  test('parses coding-agent passthrough args after delimiter', () => {
    assert.deepStrictEqual(parseCliArgs(['claude', '--workspace', '/tmp/project', '--recreate', '--', '--continue', '--model', 'sonnet']), {
      command: 'coding-agent',
      agent: 'claude',
      agentArgs: ['--continue', '--model', 'sonnet'],
      workspace: '/tmp/project',
      alias: undefined,
      recreate: true,
      json: false
    })
  })

  test('parses ssh-config install', () => {
    assert.deepStrictEqual(parseCliArgs(['ssh-config']), {
      command: 'ssh-config-install',
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false
    })
    assert.deepStrictEqual(parseCliArgs(['ssh-config', 'install', '--alias', 'demo-devcontainer']), {
      command: 'ssh-config-install',
      workspace: undefined,
      alias: 'demo-devcontainer',
      recreate: false,
      json: false
    })
  })

  test('parses lifecycle commands', () => {
    assert.deepStrictEqual(parseCliArgs(['list', '--json']), {
      command: 'list',
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: true
    })
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
    assert.throws(() => parseCliArgs(['ssh-config', 'remove']), /Unknown ssh-config command: remove/)
    assert.throws(() => parseCliArgs(['ssh-config', 'install', 'extra']), /Unknown ssh-config command: install extra/)
    assert.throws(() => parseCliArgs(['install-ssh-config']), /Unknown command/)
    assert.throws(() => parseCliArgs(['start', '--json']), /--json is only supported with status and list/)
    assert.throws(() => parseCliArgs(['start', '--', '--ignored']), /passthrough is only supported/)
    assert.throws(() => parseCliArgs(['claude', 'resume']), /must come after --/)
    assert.throws(() => parseCliArgs(['claude', '--continue']), /Unknown option: --continue/)
  })

  test('help describes available commands', () => {
    const usageLines = USAGE.split(/\r?\n/)

    assert.match(USAGE, /Commands:/)
    assert.match(USAGE, /start\s+Start or reuse the workspace devcontainer/)
    assert.match(USAGE, /Alias: shell/)
    assert.match(USAGE, /codex\s+Start or reuse the devcontainer, then launch Codex/)
    assert.match(USAGE, /claude\s+Start or reuse the devcontainer, then launch Claude/)
    assert.match(USAGE, /Alias: cc/)
    assert.match(USAGE, /opencode\s+Start or reuse the devcontainer, then launch/)
    assert.match(USAGE, /antigravity\s+Start or reuse the devcontainer, then launch/)
    assert.match(USAGE, /list\s+List Boxdown-known devcontainer workspaces/)
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

describe('coding-agent command mapping', () => {
  test('maps public command aliases to updater profiles and binaries', () => {
    assert.strictEqual(codingAgentFromCommand('codex'), 'codex')
    assert.strictEqual(codingAgentFromCommand('opencode'), 'opencode')
    assert.strictEqual(codingAgentFromCommand('claude'), 'claude')
    assert.strictEqual(codingAgentFromCommand('cc'), 'claude')
    assert.strictEqual(codingAgentFromCommand('antigravity'), 'antigravity')
    assert.strictEqual(codingAgentFromCommand('unknown'), undefined)

    assert.strictEqual(codingAgentBinary('codex'), 'codex')
    assert.strictEqual(codingAgentBinary('opencode'), 'opencode')
    assert.strictEqual(codingAgentBinary('claude'), 'claude')
    assert.strictEqual(codingAgentBinary('antigravity'), 'agy')
  })

  test('builds devcontainer exec args for direct coding-agent launch', () => {
    const workspace = tempDir('agent-launch-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('agent-launch-cache'),
        BOXDOWN_DATA_HOME: tempDir('agent-launch-data')
      },
      assetsDevcontainerDir
    })
    const args = codingAgentDevcontainerExecArgs(context, 'antigravity', ['--help'])

    assert.deepStrictEqual(args.slice(0, 5), [
      'exec',
      '--workspace-folder',
      context.workspaceFolder,
      '--override-config',
      context.generatedConfigPath
    ])
    assert.ok(args.includes('COLORTERM=truecolor'))
    assert.ok(args.includes('bash'))
    assert.ok(args.includes('-c'))
    assert.match(args.join('\n'), /exec "\$@"/)
    assert.deepStrictEqual(args.slice(-3), ['boxdown-agent', 'agy', '--help'])
  })
})

describe('workspace metadata', () => {
  test('writes stable metadata and preserves firstSeenAt', () => {
    const workspace = tempDir('metadata-workspace')
    const data = tempDir('metadata-data')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('metadata-cache'),
        BOXDOWN_DATA_HOME: data
      },
      assetsDevcontainerDir
    })
    const first = writeWorkspaceMetadata(context, 'first-alias', new Date('2026-01-01T00:00:00.000Z'))
    const second = writeWorkspaceMetadata(context, 'second-alias', new Date('2026-01-02T00:00:00.000Z'))
    const [listed] = listWorkspaceMetadata(data)

    assert.strictEqual(first.firstSeenAt, '2026-01-01T00:00:00.000Z')
    assert.strictEqual(second.firstSeenAt, first.firstSeenAt)
    assert.strictEqual(second.lastSeenAt, '2026-01-02T00:00:00.000Z')
    assert.strictEqual(second.sshAlias, 'second-alias')
    assert.deepStrictEqual(listed, second)
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
    assert.deepStrictEqual(parseDockerPsJsonLines('{"ID":"abc123","Names":"demo","State":"running","Status":"Up 2 minutes","Labels":"devcontainer.local_folder=/tmp/demo,other=value"}\n'), [
      {
        id: 'abc123',
        name: 'demo',
        state: 'running',
        status: 'Up 2 minutes',
        localFolder: '/tmp/demo'
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

describe('workspace list output', () => {
  test('formats empty list output', () => {
    assert.strictEqual(formatWorkspaceListText([]), 'Boxdown list\n\nNo Boxdown workspaces found.\n')
  })

  test('sorts workspaces and joins container state', () => {
    const alphaWorkspace = tempDir('alpha-workspace')
    const betaWorkspace = '/tmp/boxdown-missing-beta-workspace'
    const entries = createWorkspaceListEntries([
      {
        version: 1,
        workspaceId: 'beta-id',
        workspaceFolder: betaWorkspace,
        workspaceBasename: 'beta',
        sshAlias: 'beta-devcontainer',
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-02T00:00:00.000Z'
      },
      {
        version: 1,
        workspaceId: 'alpha-id',
        workspaceFolder: alphaWorkspace,
        workspaceBasename: 'alpha',
        sshAlias: 'alpha-devcontainer',
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-02T00:00:00.000Z'
      }
    ], [
      {
        id: 'abc123',
        name: 'alpha-container',
        state: 'running',
        status: 'Up 2 minutes',
        localFolder: alphaWorkspace
      }
    ], (path) => path === alphaWorkspace)

    assert.strictEqual(entries[0]?.workspaceBasename, 'alpha')
    assert.strictEqual(entries[0]?.repoExists, true)
    assert.strictEqual(entries[0]?.state, 'running')
    assert.strictEqual(entries[0]?.container.running, true)
    assert.strictEqual(entries[1]?.workspaceBasename, 'beta')
    assert.strictEqual(entries[1]?.repoExists, false)
    assert.strictEqual(entries[1]?.state, 'missing')
    assert.match(formatWorkspaceListText(entries), /STATE\s+REPO\s+PATH\s+SSH ALIAS\s+CONTAINER/)
    assert.match(formatWorkspaceListText(entries), /running\s+alpha/)
    assert.match(formatWorkspaceListText(entries), /missing\s+beta/)
  })

  test('marks container state unknown when Docker is unavailable', () => {
    const workspace = tempDir('unknown-docker-workspace')
    const [entry] = createWorkspaceListEntries([
      {
        version: 1,
        workspaceId: 'unknown-id',
        workspaceFolder: workspace,
        workspaceBasename: 'unknown',
        sshAlias: 'unknown-devcontainer',
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-02T00:00:00.000Z'
      }
    ], undefined, (path) => path === workspace)

    assert.strictEqual(entry?.state, 'unknown')
    assert.strictEqual(entry?.container.found, false)
    assert.strictEqual(entry?.container.running, false)
    assert.strictEqual(entry?.container.state, 'unknown')
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

describe('GitHub Git auth setup', () => {
  test('canonicalizes supported GitHub remote URL forms', () => {
    assert.strictEqual(canonicalGithubRemoteUrl('git@github.com:lirantal/lirantaldotcom.git'), 'https://github.com/lirantal/lirantaldotcom.git')
    assert.strictEqual(canonicalGithubRemoteUrl('ssh://git@github.com/lirantal/lirantaldotcom.git'), 'https://github.com/lirantal/lirantaldotcom.git')
    assert.strictEqual(canonicalGithubRemoteUrl('https://github.com/lirantal/lirantaldotcom'), 'https://github.com/lirantal/lirantaldotcom.git')
    assert.strictEqual(canonicalGithubRemoteUrl('https://x-access-token@github.com/lirantal/lirantaldotcom.git'), 'https://github.com/lirantal/lirantaldotcom.git')
    assert.strictEqual(canonicalGithubRemoteUrl('git@example.com:lirantal/lirantaldotcom.git'), undefined)
  })

  test('configures GitHub remotes for gh-backed HTTPS Git operations', async () => {
    const workspace = tempDir('github-git-auth')

    execFileSync('git', ['init'], { cwd: workspace })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:lirantal/lirantaldotcom.git'], { cwd: workspace })
    execFileSync('git', ['remote', 'add', 'upstream', 'https://x-access-token@github.com/lirantal/boxdown.git'], { cwd: workspace })
    execFileSync('git', ['remote', 'add', 'example', 'ssh://git@example.com/lirantal/example.git'], { cwd: workspace })

    assert.strictEqual(await configureWorkspaceGithubGitAuth(workspace), true)

    assert.strictEqual(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: workspace }).toString('utf8').trim(), 'https://github.com/lirantal/lirantaldotcom.git')
    assert.strictEqual(execFileSync('git', ['remote', 'get-url', '--push', 'origin'], { cwd: workspace }).toString('utf8').trim(), 'https://github.com/lirantal/lirantaldotcom.git')
    assert.strictEqual(execFileSync('git', ['remote', 'get-url', 'upstream'], { cwd: workspace }).toString('utf8').trim(), 'https://github.com/lirantal/boxdown.git')
    assert.strictEqual(execFileSync('git', ['remote', 'get-url', 'example'], { cwd: workspace }).toString('utf8').trim(), 'ssh://git@example.com/lirantal/example.git')

    const helpers = execFileSync('git', ['config', '--local', '--get-all', 'credential.https://github.com.helper'], { cwd: workspace })
      .toString('utf8')
      .replace(/\r?\n$/, '')
      .split(/\r?\n/)
    assert.deepStrictEqual(helpers, ['', '!gh auth git-credential'])

    assert.strictEqual(
      execFileSync('git', ['config', '--local', '--get', 'url.https://github.com/lirantal/lirantaldotcom.git.insteadOf'], { cwd: workspace }).toString('utf8').trim(),
      'https://github.com/lirantal/lirantaldotcom.git'
    )

    assert.strictEqual(
      execFileSync('git', ['-c', 'url.git@github.com:.insteadOf=https://github.com/', 'ls-remote', '--get-url', 'https://github.com/lirantal/lirantaldotcom.git'], { cwd: workspace }).toString('utf8').trim(),
      'https://github.com/lirantal/lirantaldotcom.git'
    )
  })

  test('does not refresh GitHub auth during ssh-proxy startup', () => {
    const mainSource = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8')
    const sshProxyBlock = /if \(parsed\.command === 'ssh-proxy'\) {([\s\S]*?)\n\s{4}if \(parsed\.command === 'refresh-gh-token-running'\)/.exec(mainSource)?.[1]

    assert.ok(sshProxyBlock !== undefined)
    assert.doesNotMatch(sshProxyBlock, /refreshContainerGhAuth/)
  })
})

describe('SSH config generation', () => {
  test('builds default alias and packaged proxy command', () => {
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
    assert.match(block, /ProxyCommand .*node' .*dist\/bin\/cli\.cjs' ssh-proxy/)
    assert.ok(!block.includes('npx --yes boxdown'))
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

  test('refreshes coding-agent CLIs from lifecycle hooks through updater utility', () => {
    const postCreate = readFileSync(join(assetsDevcontainerDir, 'hooks', 'post-create.sh'), 'utf8')
    const postStart = readFileSync(join(assetsDevcontainerDir, 'hooks', 'post-start.sh'), 'utf8')
    const updater = readFileSync(join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh'), 'utf8')
    const codexWrapper = readFileSync(join(assetsDevcontainerDir, 'utils', 'codex-cli-update.sh'), 'utf8')

    assert.match(postCreate, /install_or_update_coding_agent_clis/)
    assert.match(postCreate, /coding-agent-cli-update\.sh" install/)
    assert.match(postStart, /coding-agent-cli-update\.sh" maybe-update/)
    assert.match(updater, /DEFAULT_AGENTS=\(codex opencode claude antigravity\)/)
    assert.match(updater, /codex update/)
    assert.match(updater, /opencode upgrade --method curl/)
    assert.match(updater, /claude update/)
    assert.match(updater, /antigravity\.google\/cli\/install\.sh/)
    assert.match(codexWrapper, /coding-agent-cli-update\.sh" "\$\{1:-maybe-update\}" codex/)
  })

  test('skips coding-agent CLI refresh when all stamps are fresh', () => {
    const updaterPath = join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh')
    const stateDir = tempDir('coding-agent-update-state')
    mkdirSync(stateDir, { recursive: true })

    for (const agent of ['codex', 'opencode', 'claude', 'antigravity']) {
      writeFileSync(join(stateDir, `${agent}.stamp`), '')
    }

    execFileSync('bash', [updaterPath, 'maybe-update'], {
      env: {
        ...process.env,
        BOXDOWN_CODING_AGENT_UPDATE_STATE_DIR: stateDir,
        BOXDOWN_CODING_AGENT_UPDATE_INTERVAL_SECONDS: '999999'
      },
      stdio: 'pipe'
    })
  })

  test('keeps Codex updater compatibility wrapper', () => {
    const updater = readFileSync(join(assetsDevcontainerDir, 'utils', 'codex-cli-update.sh'), 'utf8')

    assert.match(updater, /Compatibility wrapper/)
    assert.match(updater, /coding-agent-cli-update\.sh/)
    assert.match(updater, /codex/)
  })

  test('resolves packaged devcontainers CLI dependency', () => {
    const workspace = tempDir('devcontainers-cli-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('devcontainers-cli-cache'),
        BOXDOWN_DATA_HOME: tempDir('devcontainers-cli-data')
      },
      assetsDevcontainerDir
    })
    const cli = resolveDevcontainerCli(context)

    assert.strictEqual(cli.command, process.execPath)
    assert.strictEqual(cli.version, DEVCONTAINER_CLI_VERSION)
    assert.match(cli.path, /@devcontainers[+/]cli@0\.84\.1|@devcontainers\/cli/)
    assert.strictEqual(existsSync(cli.path), true)
  })
})
