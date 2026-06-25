import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { codexDiscoveredRemoteHostId, codexProjectEntryForWorkspace, defaultCodexAppConfigPath, defaultCodexGlobalStatePath, installCodexAppConfigProject, mergeCodexAppProject, parseCodexAppConfig, removeCodexAppProject, removeCodexGlobalStateProject, uninstallCodexAppConfigProject, uninstallCodexGlobalStateProject } from '../src/codex-app-config.ts'
import { codingAgentBinary, codingAgentFromCommand } from '../src/coding-agents.ts'
import { buildGeneratedDevcontainerConfig, publishContainerPortFromConfig } from '../src/config.ts'
import { BOXDOWN_CONTAINER_AGENTS_DIR, DEVCONTAINER_CLI_VERSION } from '../src/constants.ts'
import { codingAgentDevcontainerExecArgs } from '../src/devcontainer.ts'
import { resolveDevcontainerCli } from '../src/devcontainer-cli.ts'
import { doctorHasFailures, formatDoctorText } from '../src/doctor.ts'
import { canonicalGithubRemoteUrl, configureWorkspaceGithubGitAuth } from '../src/github-git-auth.ts'
import { parseJsonc } from '../src/jsonc.ts'
import { createWorkspaceListEntries, formatWorkspaceListText } from '../src/list.ts'
import { commandWritesWorkspaceMetadata, parseCliArgs, USAGE } from '../src/main.ts'
import { listWorkspaceMetadata, writeWorkspaceMetadata } from '../src/metadata.ts'
import { createWorkspaceContext } from '../src/paths.ts'
import { DEFAULT_TTY_MAX_COLUMNS, interactiveShellEnvArgs, interactiveShellScript } from '../src/shell.ts'
import { buildSshConfigBlock, defaultSshAlias, installSshConfig, removeSshConfigBlock, replaceSshConfigBlock, uninstallSshConfig } from '../src/ssh-config.ts'
import { createStatusInfo, formatStatusText, inspectSshConfigStatus, parseDockerPsJsonLines, statusIsHealthy } from '../src/status.ts'

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
    assert.deepStrictEqual(parseCliArgs(['ssh-config', 'install', '--target', 'codex']), {
      command: 'ssh-config-install',
      workspace: undefined,
      alias: undefined,
      target: 'codex',
      recreate: false,
      json: false
    })
  })

  test('parses ssh-config uninstall', () => {
    assert.deepStrictEqual(parseCliArgs(['ssh-config', 'uninstall']), {
      command: 'ssh-config-uninstall',
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false
    })
    assert.deepStrictEqual(parseCliArgs(['ssh-config', 'uninstall', '--workspace', '/tmp/project', '--alias', 'demo-devcontainer']), {
      command: 'ssh-config-uninstall',
      workspace: '/tmp/project',
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
    assert.throws(() => parseCliArgs(['ssh-config', 'uninstall', 'extra']), /Unknown ssh-config command: uninstall extra/)
    assert.throws(() => parseCliArgs(['install-ssh-config']), /Unknown command/)
    assert.throws(() => parseCliArgs(['start', '--json']), /--json is only supported with status and list/)
    assert.throws(() => parseCliArgs(['ssh-config', 'install', '--target', 'cursor']), /Unsupported ssh-config install target: cursor/)
    assert.throws(() => parseCliArgs(['start', '--target', 'codex']), /--target is only supported with ssh-config install/)
    assert.throws(() => parseCliArgs(['codex', '--target', 'codex']), /--target is only supported with ssh-config install/)
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
    assert.match(USAGE, /ssh-config uninstall\s+Remove Boxdown's managed SSH host alias/)
    assert.match(USAGE, /--target codex\s+Also register the SSH alias/)
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

  test('status does not record workspace metadata', () => {
    assert.strictEqual(commandWritesWorkspaceMetadata('status'), false)
    assert.strictEqual(commandWritesWorkspaceMetadata('list'), false)
    assert.strictEqual(commandWritesWorkspaceMetadata('start'), true)
    assert.strictEqual(commandWritesWorkspaceMetadata('ssh-config-install'), true)
    assert.strictEqual(commandWritesWorkspaceMetadata('ssh-config-uninstall'), false)
    assert.strictEqual(commandWritesWorkspaceMetadata('ssh-proxy'), true)
    assert.strictEqual(commandWritesWorkspaceMetadata('refresh-gh-token'), true)
    assert.strictEqual(commandWritesWorkspaceMetadata('refresh-gh-token-running'), true)
    assert.strictEqual(commandWritesWorkspaceMetadata('coding-agent'), true)
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

  test('inspects only Boxdown-managed SSH config blocks', () => {
    const workspace = tempDir('status-ssh-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('status-ssh-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-ssh-data')
      },
      assetsDevcontainerDir
    })
    const configDir = tempDir('status-ssh-config')
    const sshConfigPath = join(configDir, 'config')

    assert.deepStrictEqual(inspectSshConfigStatus(context, 'demo-devcontainer', sshConfigPath, existsSync), {
      configPath: sshConfigPath,
      configExists: false,
      managedBlockState: 'missing'
    })

    writeFileSync(sshConfigPath, buildSshConfigBlock(context, 'demo-devcontainer'))
    assert.deepStrictEqual(inspectSshConfigStatus(context, 'demo-devcontainer', sshConfigPath, existsSync), {
      configPath: sshConfigPath,
      configExists: true,
      managedBlockState: 'installed'
    })

    writeFileSync(sshConfigPath, buildSshConfigBlock(context, 'demo-devcontainer').replace('  User node', '  User root'))
    assert.deepStrictEqual(inspectSshConfigStatus(context, 'demo-devcontainer', sshConfigPath, existsSync), {
      configPath: sshConfigPath,
      configExists: true,
      managedBlockState: 'outdated'
    })

    writeFileSync(sshConfigPath, 'Host demo-devcontainer\n  HostName localhost\n')
    assert.deepStrictEqual(inspectSshConfigStatus(context, 'demo-devcontainer', sshConfigPath, existsSync), {
      configPath: sshConfigPath,
      configExists: true,
      managedBlockState: 'missing'
    })
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
    const sshConfigPath = join(tempDir('status-config'), 'config')
    writeFileSync(sshConfigPath, buildSshConfigBlock(context, 'demo-devcontainer'))
    const exists = (path: string): boolean => [
      sshConfigPath,
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
    }, exists, { aliasSource: 'default', sshConfigPath })
    const stopped = createStatusInfo(context, 'demo-devcontainer', {
      id: 'def456',
      name: 'demo',
      state: 'exited',
      status: 'Exited (0) 1 minute ago'
    }, exists, { aliasSource: 'provided', sshConfigPath })
    const absent = createStatusInfo(context, 'demo-devcontainer', undefined, () => false, {
      aliasSource: 'default',
      sshConfigPath
    })

    assert.strictEqual(running.container.running, true)
    assert.strictEqual(statusIsHealthy(running), true)
    assert.strictEqual(stopped.container.running, false)
    assert.strictEqual(statusIsHealthy(stopped), false)
    assert.strictEqual(absent.container.found, false)
    assert.strictEqual(statusIsHealthy(absent), false)
    assert.strictEqual(running.ssh.aliasSource, 'default')
    assert.strictEqual(running.ssh.managedBlockState, 'installed')
    assert.strictEqual(absent.ssh.managedBlockState, 'missing')
    assert.match(formatStatusText(running), /SSH alias: demo-devcontainer \(computed default; installed\)/)
    assert.match(formatStatusText(stopped), /SSH alias: demo-devcontainer \(provided; installed\)/)
    assert.match(formatStatusText(running), /State: running/)
    assert.match(formatStatusText(stopped), /State: exited/)
    assert.match(formatStatusText(running), /Generated config: .* \(exists\)/)
    assert.match(formatStatusText(absent), /Generated config: .* \(missing\)/)
    assert.match(formatStatusText(running), /SSH config: .* \(exists\)/)
    assert.match(formatStatusText(running), /Boxdown SSH block: installed/)
    assert.match(formatStatusText(absent), /State: absent/)
    assert.match(formatStatusText(absent, { color: true }), /\u001B\[31mmissing\u001B\[0m/)
    assert.match(formatStatusText(running, { color: true }), /\u001B\[32mexists\u001B\[0m/)
    assert.match(formatStatusText(running, { color: true }), /\u001B\[32minstalled\u001B\[0m/)
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
        HOME: tempDir('config-home'),
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
    assert.ok(!config.mounts?.some((mount) => mount.includes(`target=${BOXDOWN_CONTAINER_AGENTS_DIR}`)))
    assert.ok(!config.mounts?.some((mount) => mount.startsWith(`type=bind,source=${context.sshKeyDir},`)))
    assert.strictEqual(config.containerEnv?.DEVCONTAINER_SSH_PUBLIC_KEY_FILE, '/opt/boxdown/state/ssh/id_ed25519.pub')
    assert.strictEqual(publishContainerPortFromConfig(config), '3000')
  })

  test('mounts host global agent config when present', () => {
    const workspace = tempDir('agents-config-workspace')
    const home = tempDir('agents-config-home')
    const hostAgentsDir = join(home, '.agents')
    mkdirSync(hostAgentsDir)
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: home,
        BOXDOWN_CACHE_HOME: tempDir('agents-config-cache'),
        BOXDOWN_DATA_HOME: tempDir('agents-config-data')
      },
      assetsDevcontainerDir
    })

    const config = buildGeneratedDevcontainerConfig(context)

    assert.strictEqual(context.hostAgentsDir, hostAgentsDir)
    assert.ok(config.mounts?.includes(`type=bind,source=${hostAgentsDir},target=${BOXDOWN_CONTAINER_AGENTS_DIR},readonly`))
    assert.ok(!config.mounts?.some((mount) => mount.startsWith(`type=bind,source=${context.sshKeyDir},`)))
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

  test('removes managed block without touching unrelated SSH config', () => {
    const workspace = tempDir('ssh-remove-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-remove-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-remove-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const block = buildSshConfigBlock(context, alias)
    const existing = replaceSshConfigBlock('Host github.com\n  User git\n', alias, block)
    const removed = removeSshConfigBlock(existing, alias)

    assert.strictEqual(removed, 'Host github.com\n  User git\n')
    assert.strictEqual(removed.includes(`# BEGIN ${alias} boxdown`), false)
    assert.strictEqual(removeSshConfigBlock(removed, alias), removed)
  })

  test('uninstalls managed SSH config block idempotently', async () => {
    const workspace = tempDir('ssh-uninstall-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-uninstall-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-uninstall-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const sshConfigPath = join(tempDir('ssh-uninstall-config'), 'config')

    await installSshConfig(context, alias, { quiet: true, configPath: sshConfigPath })

    assert.strictEqual(uninstallSshConfig(alias, { quiet: true, configPath: sshConfigPath }), true)
    assert.strictEqual(readFileSync(sshConfigPath, 'utf8'), '')
    assert.strictEqual(uninstallSshConfig(alias, { quiet: true, configPath: sshConfigPath }), false)
  })
})

describe('Codex app config injection', () => {
  test('builds the default config path and workspace project entry', () => {
    const workspace = tempDir('codex-entry-workspace')
    const home = tempDir('codex-entry-home')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: home,
        BOXDOWN_CACHE_HOME: tempDir('codex-entry-cache'),
        BOXDOWN_DATA_HOME: tempDir('codex-entry-data')
      },
      assetsDevcontainerDir
    })

    assert.strictEqual(defaultCodexAppConfigPath({ HOME: home }), join(home, '.codex', 'codex-app', 'config.json'))
    assert.strictEqual(defaultCodexAppConfigPath({ HOME: home, BOXDOWN_CODEX_APP_CONFIG: '/tmp/codex.json' }), '/tmp/codex.json')
    assert.deepStrictEqual(codexProjectEntryForWorkspace(context, 'demo-devcontainer'), {
      sshAlias: 'demo-devcontainer',
      remotePath: `/home/node/${context.workspaceBasename}`,
      label: context.workspaceBasename
    })
  })

  test('merges by SSH alias and normalized remote path', () => {
    const config = parseCodexAppConfig({
      version: 1,
      ignored: true,
      remoteConnectionMaxRetryAttempts: 2,
      sshConnectTimeoutSeconds: 30,
      remoteConnections: [
        {
          sshAlias: 'demo-devcontainer',
          ignored: true,
          projects: [
            {
              remotePath: '/home/node/demo/',
              label: 'Old demo',
              ignored: true
            }
          ]
        },
        {
          sshAlias: 'other-devcontainer',
          projects: [
            {
              remotePath: '/home/node/other',
              label: 'Other'
            }
          ]
        }
      ]
    })

    const first = mergeCodexAppProject(config, {
      sshAlias: 'demo-devcontainer',
      remotePath: '/home/node/demo',
      label: 'Demo'
    })
    const second = mergeCodexAppProject(first, {
      sshAlias: 'demo-devcontainer',
      remotePath: '/home/node/new-demo/',
      label: 'New demo'
    })

    assert.strictEqual(first.remoteConnectionMaxRetryAttempts, 2)
    assert.strictEqual(first.sshConnectTimeoutSeconds, 30)
    assert.deepStrictEqual(first.remoteConnections[0], {
      sshAlias: 'demo-devcontainer',
      projects: [
        {
          remotePath: '/home/node/demo',
          label: 'Demo'
        }
      ]
    })
    assert.strictEqual(second.remoteConnections[0]?.projects.length, 2)
    assert.deepStrictEqual(second.remoteConnections[1], {
      sshAlias: 'other-devcontainer',
      projects: [
        {
          remotePath: '/home/node/other',
          label: 'Other'
        }
      ]
    })
  })

  test('removes by SSH alias and normalized remote path', () => {
    const config = parseCodexAppConfig({
      version: 1,
      remoteConnectionMaxRetryAttempts: 2,
      sshConnectTimeoutSeconds: 30,
      remoteConnections: [
        {
          sshAlias: 'demo-devcontainer',
          projects: [
            {
              remotePath: '/home/node/demo/',
              label: 'Demo'
            },
            {
              remotePath: '/home/node/other-demo',
              label: 'Other demo'
            }
          ]
        },
        {
          sshAlias: 'other-devcontainer',
          projects: [
            {
              remotePath: '/home/node/demo',
              label: 'Other connection demo'
            }
          ]
        }
      ]
    })

    const first = removeCodexAppProject(config, {
      sshAlias: 'demo-devcontainer',
      remotePath: '/home/node/demo',
      label: 'Demo'
    })
    const second = removeCodexAppProject(first, {
      sshAlias: 'demo-devcontainer',
      remotePath: '/home/node/other-demo',
      label: 'Other demo'
    })

    assert.strictEqual(first.remoteConnectionMaxRetryAttempts, 2)
    assert.strictEqual(first.sshConnectTimeoutSeconds, 30)
    assert.deepStrictEqual(first.remoteConnections[0], {
      sshAlias: 'demo-devcontainer',
      projects: [
        {
          remotePath: '/home/node/other-demo',
          label: 'Other demo'
        }
      ]
    })
    assert.deepStrictEqual(first.remoteConnections[1], {
      sshAlias: 'other-devcontainer',
      projects: [
        {
          remotePath: '/home/node/demo',
          label: 'Other connection demo'
        }
      ]
    })
    assert.deepStrictEqual(second.remoteConnections, [
      {
        sshAlias: 'other-devcontainer',
        projects: [
          {
            remotePath: '/home/node/demo',
            label: 'Other connection demo'
          }
        ]
      }
    ])
  })

  test('creates a missing Codex app config', () => {
    const configPath = join(tempDir('codex-create'), 'codex-app', 'config.json')
    const result = installCodexAppConfigProject({
      sshAlias: 'demo-devcontainer',
      remotePath: '/home/node/demo',
      label: 'demo'
    }, {
      configPath,
      now: new Date('2026-01-01T00:00:00.000Z')
    })

    assert.deepStrictEqual(result, {
      configPath,
      changed: true
    })
    assert.deepStrictEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      version: 1,
      remoteConnections: [
        {
          sshAlias: 'demo-devcontainer',
          projects: [
            {
              remotePath: '/home/node/demo',
              label: 'demo'
            }
          ]
        }
      ]
    })
  })

  test('updates existing Codex config, strips unknown keys, and writes a backup', () => {
    const configPath = join(tempDir('codex-update'), 'config.json')
    writeFileSync(configPath, `${JSON.stringify({
      version: 1,
      unknown: true,
      remoteConnectionMaxRetryAttempts: 3,
      sshConnectTimeoutSeconds: 45,
      remoteConnections: [
        {
          sshAlias: 'demo-devcontainer',
          unknown: true,
          projects: [
            {
              remotePath: '/home/node/demo/',
              label: 'Old demo',
              unknown: true
            }
          ]
        },
        {
          sshAlias: 'other-devcontainer',
          projects: [
            {
              remotePath: '/home/node/other',
              label: 'Other'
            }
          ]
        }
      ]
    }, null, 2)}\n`)

    const result = installCodexAppConfigProject({
      sshAlias: 'demo-devcontainer',
      remotePath: '/home/node/demo',
      label: 'Demo'
    }, {
      configPath,
      now: new Date('2026-01-01T00:00:00.000Z')
    })
    const second = installCodexAppConfigProject({
      sshAlias: 'demo-devcontainer',
      remotePath: '/home/node/demo',
      label: 'Demo'
    }, {
      configPath,
      now: new Date('2026-01-02T00:00:00.000Z')
    })

    assert.strictEqual(result.changed, true)
    assert.strictEqual(result.backupPath, `${configPath}.2026-01-01T00-00-00-000Z.bak`)
    assert.strictEqual(existsSync(result.backupPath), true)
    assert.deepStrictEqual(second, {
      configPath,
      changed: false
    })
    assert.deepStrictEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      version: 1,
      remoteConnectionMaxRetryAttempts: 3,
      sshConnectTimeoutSeconds: 45,
      remoteConnections: [
        {
          sshAlias: 'demo-devcontainer',
          projects: [
            {
              remotePath: '/home/node/demo',
              label: 'Demo'
            }
          ]
        },
        {
          sshAlias: 'other-devcontainer',
          projects: [
            {
              remotePath: '/home/node/other',
              label: 'Other'
            }
          ]
        }
      ]
    })
  })

  test('uninstalls existing Codex project config and writes a backup', () => {
    const configPath = join(tempDir('codex-uninstall'), 'config.json')
    writeFileSync(configPath, `${JSON.stringify({
      version: 1,
      remoteConnections: [
        {
          sshAlias: 'demo-devcontainer',
          projects: [
            {
              remotePath: '/home/node/demo/',
              label: 'Demo'
            },
            {
              remotePath: '/home/node/other-demo',
              label: 'Other demo'
            }
          ]
        },
        {
          sshAlias: 'other-devcontainer',
          projects: [
            {
              remotePath: '/home/node/demo',
              label: 'Other connection demo'
            }
          ]
        }
      ]
    }, null, 2)}\n`)

    const result = uninstallCodexAppConfigProject({
      sshAlias: 'demo-devcontainer',
      remotePath: '/home/node/demo',
      label: 'Demo'
    }, {
      configPath,
      now: new Date('2026-01-01T00:00:00.000Z')
    })
    const second = uninstallCodexAppConfigProject({
      sshAlias: 'demo-devcontainer',
      remotePath: '/home/node/demo',
      label: 'Demo'
    }, {
      configPath,
      now: new Date('2026-01-02T00:00:00.000Z')
    })

    assert.strictEqual(result.changed, true)
    assert.strictEqual(result.backupPath, `${configPath}.2026-01-01T00-00-00-000Z.bak`)
    assert.strictEqual(existsSync(result.backupPath), true)
    assert.deepStrictEqual(second, {
      configPath,
      changed: false
    })
    assert.deepStrictEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      version: 1,
      remoteConnections: [
        {
          sshAlias: 'demo-devcontainer',
          projects: [
            {
              remotePath: '/home/node/other-demo',
              label: 'Other demo'
            }
          ]
        },
        {
          sshAlias: 'other-devcontainer',
          projects: [
            {
              remotePath: '/home/node/demo',
              label: 'Other connection demo'
            }
          ]
        }
      ]
    })
  })

  test('uninstalls matching Codex global sidebar state and writes a backup', () => {
    const statePath = join(tempDir('codex-state-uninstall'), '.codex-global-state.json')
    const entry = {
      sshAlias: 'demo-devcontainer',
      remotePath: '/home/node/demo',
      label: 'Demo'
    }
    const hostId = codexDiscoveredRemoteHostId(entry.sshAlias)
    const otherHostId = codexDiscoveredRemoteHostId('other-devcontainer')
    const state = {
      'remote-connection-analytics-id-by-host-id': {
        [hostId]: 'demo-analytics',
        [otherHostId]: 'other-analytics'
      },
      'codex-managed-remote-connections': [
        {
          hostId,
          displayName: entry.sshAlias,
          alias: entry.sshAlias
        },
        {
          hostId: otherHostId,
          displayName: 'other-devcontainer',
          alias: 'other-devcontainer'
        }
      ],
      'selected-remote-host-id': hostId,
      'remote-connection-auto-connect-by-host-id': {
        [hostId]: true,
        [otherHostId]: false
      },
      'project-order': ['demo-project-id', 'other-project-id'],
      'sidebar-collapsed-groups': {
        'demo-project-id': true,
        'other-project-id': true
      },
      'remote-projects': [
        {
          id: 'demo-project-id',
          hostId,
          remotePath: '/home/node/demo/',
          label: 'Demo'
        },
        {
          id: 'other-project-id',
          hostId: otherHostId,
          remotePath: '/home/node/other',
          label: 'Other'
        }
      ],
      'electron-persisted-atom-state': {
        'agent-mode-by-host-id': {
          [hostId]: 'auto',
          [otherHostId]: 'full-access'
        }
      }
    }

    writeFileSync(statePath, `${JSON.stringify(state)}\n`)

    const pure = removeCodexGlobalStateProject(state, entry)
    const result = uninstallCodexGlobalStateProject(entry, {
      statePath,
      now: new Date('2026-01-01T00:00:00.000Z')
    })
    const second = uninstallCodexGlobalStateProject(entry, {
      statePath,
      now: new Date('2026-01-02T00:00:00.000Z')
    })
    const nextState = JSON.parse(readFileSync(statePath, 'utf8'))

    assert.strictEqual(defaultCodexGlobalStatePath({ HOME: '/tmp/home' }), '/tmp/home/.codex/.codex-global-state.json')
    assert.strictEqual(defaultCodexGlobalStatePath({ HOME: '/tmp/home', BOXDOWN_CODEX_GLOBAL_STATE: '/tmp/state.json' }), '/tmp/state.json')
    assert.deepStrictEqual(pure, nextState)
    assert.strictEqual(result.changed, true)
    assert.strictEqual(result.backupPath, `${statePath}.2026-01-01T00-00-00-000Z.bak`)
    assert.strictEqual(existsSync(result.backupPath), true)
    assert.deepStrictEqual(second, {
      statePath,
      changed: false
    })
    assert.deepStrictEqual(nextState['remote-projects'], [
      {
        id: 'other-project-id',
        hostId: otherHostId,
        remotePath: '/home/node/other',
        label: 'Other'
      }
    ])
    assert.deepStrictEqual(nextState['codex-managed-remote-connections'], [
      {
        hostId: otherHostId,
        displayName: 'other-devcontainer',
        alias: 'other-devcontainer'
      }
    ])
    assert.deepStrictEqual(nextState['project-order'], ['other-project-id'])
    assert.deepStrictEqual(nextState['sidebar-collapsed-groups'], {
      'other-project-id': true
    })
    assert.deepStrictEqual(nextState['remote-connection-analytics-id-by-host-id'], {
      [otherHostId]: 'other-analytics'
    })
    assert.deepStrictEqual(nextState['remote-connection-auto-connect-by-host-id'], {
      [otherHostId]: false
    })
    assert.strictEqual(nextState['selected-remote-host-id'], undefined)
    assert.deepStrictEqual(nextState['electron-persisted-atom-state']['agent-mode-by-host-id'], {
      [otherHostId]: 'full-access'
    })
  })

  test('fails without rewriting invalid or unsupported Codex app configs', () => {
    const invalidJsonPath = join(tempDir('codex-invalid-json'), 'config.json')
    writeFileSync(invalidJsonPath, '{ invalid json')

    assert.throws(() => installCodexAppConfigProject({
      sshAlias: 'demo-devcontainer',
      remotePath: '/home/node/demo',
      label: 'Demo'
    }, { configPath: invalidJsonPath }), /Invalid Codex app config JSON/)
    assert.strictEqual(readFileSync(invalidJsonPath, 'utf8'), '{ invalid json')

    const unsupportedPath = join(tempDir('codex-unsupported'), 'config.json')
    writeFileSync(unsupportedPath, '{"version":2,"remoteConnections":[]}\n')

    assert.throws(() => installCodexAppConfigProject({
      sshAlias: 'demo-devcontainer',
      remotePath: '/home/node/demo',
      label: 'Demo'
    }, { configPath: unsupportedPath }), /Unsupported Codex app config version: 2/)
    assert.strictEqual(readFileSync(unsupportedPath, 'utf8'), '{"version":2,"remoteConnections":[]}\n')
  })

  test('keeps plain SSH install and later Codex target install idempotent', async () => {
    const workspace = tempDir('codex-idempotent-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('codex-idempotent-cache'),
        BOXDOWN_DATA_HOME: tempDir('codex-idempotent-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const sshConfigPath = join(tempDir('codex-idempotent-ssh'), 'config')
    const codexConfigPath = join(tempDir('codex-idempotent-app'), 'config.json')

    await installSshConfig(context, alias, { quiet: true, configPath: sshConfigPath })
    await installSshConfig(context, alias, { quiet: true, configPath: sshConfigPath })
    installCodexAppConfigProject(codexProjectEntryForWorkspace(context, alias), { configPath: codexConfigPath })
    installCodexAppConfigProject(codexProjectEntryForWorkspace(context, alias), { configPath: codexConfigPath })

    const sshConfig = readFileSync(sshConfigPath, 'utf8')
    const codexConfig = parseCodexAppConfig(JSON.parse(readFileSync(codexConfigPath, 'utf8')))

    assert.strictEqual(sshConfig.split(`# BEGIN ${alias} boxdown`).length - 1, 1)
    assert.strictEqual(codexConfig.remoteConnections.length, 1)
    assert.strictEqual(codexConfig.remoteConnections[0]?.sshAlias, alias)
    assert.strictEqual(codexConfig.remoteConnections[0]?.projects.length, 1)
    assert.deepStrictEqual(codexConfig.remoteConnections[0]?.projects[0], {
      remotePath: `/home/node/${context.workspaceBasename}`,
      label: context.workspaceBasename
    })
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
    assert.doesNotMatch(updater, /--skip-path/)
    assert.match(codexWrapper, /coding-agent-cli-update\.sh" "\$\{1:-maybe-update\}" codex/)
  })

  test('runs Antigravity installer without unsupported path flags', () => {
    const updaterPath = join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh')
    const stateDir = tempDir('antigravity-update-state')
    const installerPath = join(tempDir('antigravity-installer'), 'install.sh')
    const argsPath = join(tempDir('antigravity-args'), 'args.txt')

    writeFileSync(installerPath, [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$#" > "${BOXDOWN_FAKE_ANTIGRAVITY_ARGS_FILE}"',
      'if [ "$#" -gt 0 ]; then',
      '  printf "%s\\n" "$@" >> "${BOXDOWN_FAKE_ANTIGRAVITY_ARGS_FILE}"',
      'fi'
    ].join('\n'))

    execFileSync('bash', [updaterPath, 'update-now', 'antigravity'], {
      env: {
        ...process.env,
        BOXDOWN_ANTIGRAVITY_INSTALL_URL: `file://${installerPath}`,
        BOXDOWN_CODING_AGENT_UPDATE_STATE_DIR: stateDir,
        BOXDOWN_FAKE_ANTIGRAVITY_ARGS_FILE: argsPath
      },
      stdio: 'pipe'
    })

    assert.strictEqual(readFileSync(argsPath, 'utf8'), '0\n')
    assert.strictEqual(existsSync(join(stateDir, 'antigravity.stamp')), true)
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
