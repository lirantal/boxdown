import assert from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { claudeSshConfigEntryForWorkspace, defaultClaudeSshConfigsPath, installClaudeSshConfigHost, mergeClaudeSshConfigHost, parseClaudeSshConfigs, removeClaudeSshConfigHost, uninstallClaudeSshConfigHost } from '../src/claude-app-config.ts'
import { canonicalCodexRemotePathForWorkspace, codexDiscoveredRemoteHostId, codexProjectEntryForWorkspace, defaultCodexAppConfigPath, defaultCodexGlobalStatePath, installCodexAppConfigProject, installCodexGlobalStateProject, legacyCodexRemotePathForWorkspace, mergeCodexAppProject, normalizeCodexGlobalStateProject, parseCodexAppConfig, removeCodexAppProject, removeCodexGlobalStateProject, uninstallCodexAppConfigProject, uninstallCodexGlobalStateProject } from '../src/codex-app-config.ts'
import { codingAgentBinary, codingAgentFromCommand } from '../src/coding-agents.ts'
import { color, formatPromptEnd, formatPromptTitle, promptRail, selectedMark } from '../src/cli-style.ts'
import { buildGeneratedDevcontainerConfig, publishContainerPortFromConfig } from '../src/config.ts'
import { BOXDOWN_CONTAINER_AGENTS_DIR, BOXDOWN_CONTAINER_CODEX_AUTH_PATH, BOXDOWN_CONTAINER_CODEX_DIR, BOXDOWN_CONTAINER_GITCONFIG_PATH, BOXDOWN_CONTAINER_HOST_GITCONFIG_DIR, DEVCONTAINER_CLI_VERSION } from '../src/constants.ts'
import { codingAgentDevcontainerExecArgs, sshTunnelArgs } from '../src/devcontainer.ts'
import { resolveDevcontainerCli } from '../src/devcontainer-cli.ts'
import { doctorHasFailures, formatDoctorText, runDoctorChecks } from '../src/doctor.ts'
import { parseSshPublicKey, reportGitSigningPlan, resolveConfiguredSshSigningKey, resolveGitSigningPlan, selectGitSigningKey, type GitSigningPlan, type GitSigningReason } from '../src/git-signing.ts'
import { canonicalGithubRemoteUrl, configureWorkspaceGithubGitAuth } from '../src/github-git-auth.ts'
import { parseJsonc } from '../src/jsonc.ts'
import { createWorkspaceListEntries, formatWorkspaceListDetailsText, formatWorkspaceListText } from '../src/list.ts'
import { createWorkspaceCommandLogger, withLoggedProcessOutput } from '../src/logging.ts'
import { commandWritesWorkspaceMetadata, parseCliArgs, parseTunnelPort, parseTunnelPortList, runCli, setupWorkspace, USAGE } from '../src/main.ts'
import { listWorkspaceMetadata, readWorkspaceMetadata, recordWorkspaceDockerImage, writeWorkspaceMetadata } from '../src/metadata.ts'
import { readPackageVersion } from '../src/package-info.ts'
import { createWorkspaceContext } from '../src/paths.ts'
import { promptConfirm, promptMultiSelect, promptText, type PromptInput, type PromptOutput } from '../src/interactive-prompts.ts'
import { buildHostToolPath, runBuffered, runInteractive } from '../src/process.ts'
import { createProgress, formatCommandFailure, resolveProgressMode, runProgressCommand } from '../src/progress.ts'
import { DEFAULT_TTY_MAX_COLUMNS, interactiveCommandScript, interactiveShellEnvArgs, interactiveShellScript } from '../src/shell.ts'
import { buildSshConfigBlock, defaultSshAlias, installSshConfig, removeSshConfigBlock, replaceSshConfigBlock, uninstallSshConfig } from '../src/ssh-config.ts'
import { createStatusInfo, formatStatusText, inspectSshConfigStatus, parseDockerPsJsonLines, statusIsHealthy } from '../src/status.ts'
import { ensureHostSshKey } from '../src/ssh-key.ts'

const assetsDevcontainerDir = fileURLToPath(new URL('../assets/devcontainer', import.meta.url))

function tempDir (name: string): string {
  return mkdtempSync(join(tmpdir(), `boxdown-${name}-`))
}

function readGitConfig (configPath: string, key: string): string | undefined {
  try {
    return execFileSync('git', ['config', '--file', configPath, '--get', key]).toString('utf8').trim()
  } catch {
    return undefined
  }
}

function readGitConfigAll (configPath: string, key: string): string[] {
  try {
    return execFileSync('git', ['config', '--file', configPath, '--get-all', key]).toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/)
  } catch {
    return []
  }
}

interface FakeDockerWorkspace {
  workspace: string
  id: string
  containerState?: string
  removeExitCode?: number
  imageId?: string
  imageName?: string
  inspectExitCode?: number
  imageRemoveExitCode?: number
}

function runCliProcess (argv: string[], env: NodeJS.ProcessEnv): { code: number, stdout: string, stderr: string } {
  const script = [
    'import { runCli } from "./src/main.ts"',
    'const argv = JSON.parse(process.env.BOXDOWN_TEST_CLI_ARGS ?? "[]")',
    'process.exitCode = await runCli(argv)'
  ].join('\n')
  const result = spawnSync(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    script
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...env,
      BOXDOWN_TEST_CLI_ARGS: JSON.stringify(argv)
    }
  })

  if (result.error !== undefined) {
    throw result.error
  }

  return {
    code: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr
  }
}

async function withFakeDocker<T> (workspaces: FakeDockerWorkspace[], run: (logPath: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const binDir = tempDir('fake-docker-bin')
  const statePath = join(tempDir('fake-docker-state'), 'state.tsv')
  const logPath = join(tempDir('fake-docker-log'), 'calls.log')
  const dockerPath = join(binDir, 'docker')
  const script = [
    '#!/usr/bin/env bash',
    'set -u',
    'printf "%s\\n" "$*" >> "${BOXDOWN_FAKE_DOCKER_LOG}"',
    'if [ "${1:-}" = "ps" ]; then',
    '  filter=""',
    '  previous=""',
    '  for arg in "$@"; do',
    '    if [ "$previous" = "--filter" ]; then',
    '      filter="$arg"',
    '      break',
    '    fi',
    '    previous="$arg"',
    '  done',
    '  if [ "$filter" = "label=devcontainer.local_folder" ]; then',
    '    while IFS="$(printf \'\\t\')" read -r folder id container_state remove_exit_code image_id image_name inspect_exit_code image_remove_exit_code; do',
    '      printf \'{"ID":"%s","Names":"%s","State":"%s","Status":"%s","Labels":"devcontainer.local_folder=%s"}\\n\' "$id" "$id" "$container_state" "$container_state" "$folder"',
    '    done < "${BOXDOWN_FAKE_DOCKER_STATE}"',
    '    exit 0',
    '  fi',
    '  workspace="${filter#label=devcontainer.local_folder=}"',
    '  if [ "$workspace" = "$filter" ]; then',
    '    exit 0',
    '  fi',
    '  while IFS="$(printf \'\\t\')" read -r folder id container_state remove_exit_code image_id image_name inspect_exit_code image_remove_exit_code; do',
    '    if [ "$folder" = "$workspace" ]; then',
    '      printf \'{"ID":"%s","Names":"%s","State":"%s","Status":"%s","Labels":"devcontainer.local_folder=%s"}\\n\' "$id" "$id" "$container_state" "$container_state" "$folder"',
    '      exit 0',
    '    fi',
    '  done < "${BOXDOWN_FAKE_DOCKER_STATE}"',
    '  exit 0',
    'fi',
    'if [ "${1:-}" = "inspect" ]; then',
    '  id="${@: -1}"',
    '  while IFS="$(printf \'\\t\')" read -r folder container_id container_state remove_exit_code image_id image_name inspect_exit_code image_remove_exit_code; do',
    '    if [ "$container_id" = "$id" ]; then',
    '      if [ "${inspect_exit_code:-0}" != "0" ]; then',
    '        exit "$inspect_exit_code"',
    '      fi',
    '      printf \'{"Image":"%s","Config":{"Image":"%s"}}\\n\' "${image_id:-sha256:${container_id}-image}" "${image_name:-boxdown-test:${container_id}}"',
    '      exit 0',
    '    fi',
    '  done < "${BOXDOWN_FAKE_DOCKER_STATE}"',
    '  exit 1',
    'fi',
    'if [ "${1:-}" = "rm" ]; then',
    '  id="${@: -1}"',
    '  while IFS="$(printf \'\\t\')" read -r folder container_id container_state remove_exit_code image_id image_name inspect_exit_code image_remove_exit_code; do',
    '    if [ "$container_id" = "$id" ]; then',
    '      exit "${remove_exit_code:-0}"',
    '    fi',
    '  done < "${BOXDOWN_FAKE_DOCKER_STATE}"',
    '  exit 0',
    'fi',
    'if [ "${1:-}" = "image" ] && [ "${2:-}" = "rm" ]; then',
    '  image_id="${@: -1}"',
    '  while IFS="$(printf \'\\t\')" read -r folder container_id container_state remove_exit_code recorded_image_id image_name inspect_exit_code image_remove_exit_code; do',
    '    if [ "$recorded_image_id" = "$image_id" ]; then',
    '      exit "${image_remove_exit_code:-0}"',
    '    fi',
    '  done < "${BOXDOWN_FAKE_DOCKER_STATE}"',
    '  exit 0',
    'fi',
    'exit 64'
  ].join('\n')

  writeFileSync(statePath, `${workspaces.map((workspace) => [
    realpathSync(workspace.workspace),
    workspace.id,
    workspace.containerState ?? 'running',
    String(workspace.removeExitCode ?? 0),
    workspace.imageId ?? `sha256:${workspace.id}-image`,
    workspace.imageName ?? `boxdown-test:${workspace.id}`,
    String(workspace.inspectExitCode ?? 0),
    String(workspace.imageRemoveExitCode ?? 0)
  ].join('\t')).join('\n')}\n`)
  writeFileSync(dockerPath, script)
  chmodSync(dockerPath, 0o755)

  return run(logPath, {
    ...process.env,
    PATH: process.env.PATH === undefined ? binDir : `${binDir}${delimiter}${process.env.PATH}`,
    BOXDOWN_FAKE_DOCKER_STATE: statePath,
    BOXDOWN_FAKE_DOCKER_LOG: logPath
  })
}

function fakeDockerCalls (logPath: string): string[] {
  if (!existsSync(logPath)) {
    return []
  }

  return readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter((line) => line.length > 0)
}

const codexPromptChoice = {
  value: 'codex',
  label: 'Codex',
  description: 'Register this SSH alias as a Codex app remote project.'
} as const

function fakePromptStreams (options: { columns?: number, rawMode?: boolean } = {}): {
  input: PassThrough & PromptInput
  output: PassThrough & PromptOutput
  outputText: () => string
} {
  const input = new PassThrough() as PassThrough & PromptInput
  const output = new PassThrough() as PassThrough & PromptOutput
  const outputChunks: Buffer[] = []

  input.isTTY = true
  output.isTTY = true
  output.columns = options.columns
  output.on('data', (chunk: Buffer) => {
    outputChunks.push(chunk)
  })

  if (options.rawMode !== false) {
    input.setRawMode = () => {}
  }

  return {
    input,
    output,
    outputText: () => Buffer.concat(outputChunks).toString('utf8')
  }
}

async function waitForPromptOutput (outputText: () => string, pattern: RegExp): Promise<void> {
  const deadline = Date.now() + 1000

  while (Date.now() < deadline) {
    if (pattern.test(outputText())) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  assert.match(outputText(), pattern)
}

async function withProcessEnv<T> (overrides: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>()

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }

  try {
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

async function withCwd<T> (cwd: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd()
  process.chdir(cwd)

  try {
    return await run()
  } finally {
    process.chdir(previous)
  }
}

describe('CLI parsing', () => {
  test('parses setup options', () => {
    assert.deepStrictEqual(parseCliArgs(['setup']), {
      command: 'setup',
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['setup', '--workspace', '/tmp/project', '--alias', 'demo-devcontainer', '--recreate', '--target', 'codex']), {
      command: 'setup',
      workspace: '/tmp/project',
      alias: 'demo-devcontainer',
      targets: ['codex'],
      recreate: true,
      json: false,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['setup', '--target', 'codex', '--target', 'codex']), {
      command: 'setup',
      workspace: undefined,
      alias: undefined,
      targets: ['codex'],
      recreate: false,
      json: false,
      verbose: false
    })
  })

  test('parses start options', () => {
    assert.deepStrictEqual(parseCliArgs(['start', '--workspace', '/tmp/project', '--recreate']), {
      command: 'start',
      workspace: '/tmp/project',
      alias: undefined,
      recreate: true,
      json: false,
      verbose: false
    })
  })

  test('maps shell to start', () => {
    assert.strictEqual(parseCliArgs(['shell']).command, 'start')
  })

  test('parses global verbose option', () => {
    assert.strictEqual(parseCliArgs(['setup', '--verbose']).verbose, true)
    assert.deepStrictEqual(parseCliArgs(['status', '--json', '--verbose']), {
      command: 'status',
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: true,
      verbose: true
    })
  })

  test('parses global version option', () => {
    assert.strictEqual(parseCliArgs(['--version']).command, 'version')
    assert.strictEqual(parseCliArgs(['-v']).command, 'version')
  })

  test('prints package version', () => {
    const expectedVersion = `${readPackageVersion()}\n`

    for (const flag of ['--version', '-v']) {
      const result = runCliProcess([flag], process.env)

      assert.strictEqual(result.code, 0)
      assert.strictEqual(result.stdout, expectedVersion)
      assert.strictEqual(result.stderr, '')
    }
  })

  test('parses coding-agent launch aliases', () => {
    assert.deepStrictEqual(parseCliArgs(['codex']), {
      command: 'coding-agent',
      agent: 'codex',
      agentArgs: [],
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['claude']), {
      command: 'coding-agent',
      agent: 'claude',
      agentArgs: [],
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['cc']), {
      command: 'coding-agent',
      agent: 'claude',
      agentArgs: [],
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['opencode']), {
      command: 'coding-agent',
      agent: 'opencode',
      agentArgs: [],
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['antigravity']), {
      command: 'coding-agent',
      agent: 'antigravity',
      agentArgs: [],
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false,
      verbose: false
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
      json: false,
      verbose: false
    })
  })

  test('parses ssh install', () => {
    assert.deepStrictEqual(parseCliArgs(['ssh']), {
      command: 'ssh-install',
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['ssh', 'install', '--alias', 'demo-devcontainer']), {
      command: 'ssh-install',
      workspace: undefined,
      alias: 'demo-devcontainer',
      recreate: false,
      json: false,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['ssh', 'install', '--target', 'codex']), {
      command: 'ssh-install',
      workspace: undefined,
      alias: undefined,
      targets: ['codex'],
      recreate: false,
      json: false,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['ssh', 'install', '--target', 'codex', '--target', 'claude', '--target', 'codex']), {
      command: 'ssh-install',
      workspace: undefined,
      alias: undefined,
      targets: ['codex', 'claude'],
      recreate: false,
      json: false,
      verbose: false
    })
  })

  test('parses ssh uninstall', () => {
    assert.deepStrictEqual(parseCliArgs(['ssh', 'uninstall']), {
      command: 'ssh-uninstall',
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['ssh', 'uninstall', '--workspace', '/tmp/project', '--alias', 'demo-devcontainer']), {
      command: 'ssh-uninstall',
      workspace: '/tmp/project',
      alias: 'demo-devcontainer',
      recreate: false,
      json: false,
      verbose: false
    })
  })

  test('parses tunnel ports', () => {
    assert.deepStrictEqual(parseTunnelPort('3030'), {
      localPort: 3030,
      remotePort: 3030
    })
    assert.deepStrictEqual(parseTunnelPort('8080:3030'), {
      localPort: 8080,
      remotePort: 3030
    })
    assert.deepStrictEqual(parseTunnelPortList('3030, 8080:3031 9090'), [
      {
        localPort: 3030,
        remotePort: 3030
      },
      {
        localPort: 8080,
        remotePort: 3031
      },
      {
        localPort: 9090,
        remotePort: 9090
      }
    ])
    assert.deepStrictEqual(parseCliArgs(['tunnel', '--port', '3030']), {
      command: 'tunnel',
      workspace: undefined,
      alias: undefined,
      tunnelPorts: [
        {
          localPort: 3030,
          remotePort: 3030
        }
      ],
      recreate: false,
      json: false,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['tunnel', '--workspace', '/tmp/project', '--port', '3030', '--port', '8080:3031']), {
      command: 'tunnel',
      workspace: '/tmp/project',
      alias: undefined,
      tunnelPorts: [
        {
          localPort: 3030,
          remotePort: 3030
        },
        {
          localPort: 8080,
          remotePort: 3031
        }
      ],
      recreate: false,
      json: false,
      verbose: false
    })
  })

  test('parses lifecycle commands', () => {
    assert.deepStrictEqual(parseCliArgs(['list', '--json']), {
      command: 'list',
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: true,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['list', '--format', 'json']), {
      command: 'list',
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: true,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['list', '--json', '--format', 'json']), {
      command: 'list',
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: true,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['list', '--details']), {
      command: 'list',
      workspace: undefined,
      alias: undefined,
      recreate: false,
      json: false,
      details: true,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['status', '--workspace', '/tmp/project', '--alias', 'demo-devcontainer', '--json']), {
      command: 'status',
      workspace: '/tmp/project',
      alias: 'demo-devcontainer',
      recreate: false,
      json: true,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['status', '--workspace', '/tmp/project', '--format', 'json']), {
      command: 'status',
      workspace: '/tmp/project',
      alias: undefined,
      recreate: false,
      json: true,
      verbose: false
    })
    assert.strictEqual(parseCliArgs(['stop']).command, 'stop')
    assert.strictEqual(parseCliArgs(['down']).command, 'down')
    assert.deepStrictEqual(parseCliArgs(['purge', '--workspace', '/tmp/project', '--alias', 'demo-devcontainer']), {
      command: 'purge',
      workspace: '/tmp/project',
      alias: 'demo-devcontainer',
      recreate: false,
      json: false,
      verbose: false
    })
    assert.strictEqual(parseCliArgs(['doctor']).command, 'doctor')
  })

  test('parses repeated workspaces for down only', () => {
    assert.deepStrictEqual(parseCliArgs(['down', '--workspace', '/tmp/a', '--workspace', '/tmp/b']), {
      command: 'down',
      workspace: '/tmp/a',
      workspaces: ['/tmp/a', '/tmp/b'],
      alias: undefined,
      recreate: false,
      json: false,
      verbose: false
    })
    assert.deepStrictEqual(parseCliArgs(['down', '--workspace', '/tmp/a']), {
      command: 'down',
      workspace: '/tmp/a',
      workspaces: ['/tmp/a'],
      alias: undefined,
      recreate: false,
      json: false,
      verbose: false
    })
    assert.throws(() => parseCliArgs(['start', '--workspace', '/tmp/a', '--workspace', '/tmp/b']), /--workspace can only be repeated with down/)
    assert.throws(() => parseCliArgs(['status', '--workspace', '/tmp/a', '--workspace', '/tmp/b']), /--workspace can only be repeated with down/)
    assert.throws(() => parseCliArgs(['claude', '--workspace', '/tmp/a', '--workspace', '/tmp/b']), /--workspace can only be repeated with down/)
    assert.throws(() => parseCliArgs(['purge', '--workspace', '/tmp/a', '--workspace', '/tmp/b']), /--workspace can only be repeated with down/)
  })

  test('rejects unknown commands', () => {
    assert.throws(() => parseCliArgs(['ssh-config']), /Unknown command: ssh-config/)
    assert.throws(() => parseCliArgs(['ssh-config', 'install']), /Unknown command: ssh-config install/)
    assert.throws(() => parseCliArgs(['codex', 'repair']), /Unknown command: codex repair/)
    assert.throws(() => parseCliArgs(['ssh', 'remove']), /Unknown ssh command: remove/)
    assert.throws(() => parseCliArgs(['ssh', 'install', 'extra']), /Unknown ssh command: install extra/)
    assert.throws(() => parseCliArgs(['ssh', 'uninstall', 'extra']), /Unknown ssh command: uninstall extra/)
    assert.throws(() => parseCliArgs(['install-ssh-config']), /Unknown command/)
    assert.throws(() => parseCliArgs(['start', '--json']), /--json is only supported with status and list/)
    assert.throws(() => parseCliArgs(['ssh', 'install', '--target', 'cursor']), /Unsupported ssh install target: cursor/)
    assert.throws(() => parseCliArgs(['start', '--target', 'codex']), /--target is only supported with setup and ssh install/)
    assert.throws(() => parseCliArgs(['start', '--port', '3030']), /--port is only supported with tunnel/)
    assert.throws(() => parseCliArgs(['codex', '--target', 'codex']), /--target is only supported with setup and ssh install/)
    assert.throws(() => parseCliArgs(['codex', '--port', '3030']), /--port is only supported with tunnel/)
    assert.throws(() => parseCliArgs(['start', '--dry-run']), /Unknown option: --dry-run/)
    assert.throws(() => parseCliArgs(['start', '--details']), /--details is only supported with list/)
    assert.throws(() => parseCliArgs(['start', '--apply']), /Unknown option: --apply/)
    assert.throws(() => parseCliArgs(['start', '--', '--ignored']), /passthrough is only supported/)
    assert.throws(() => parseCliArgs(['list', '--details', '--json']), /--details cannot be combined with JSON output/)
    assert.throws(() => parseCliArgs(['list', '--details', '--format', 'json']), /--details cannot be combined with JSON output/)
    assert.throws(() => parseCliArgs(['list', '--format']), /--format requires a value/)
    assert.throws(() => parseCliArgs(['list', '--format', 'yaml']), /Unsupported format: yaml/)
    assert.throws(() => parseCliArgs(['setup', '--json']), /--json is only supported with status and list/)
    assert.throws(() => parseCliArgs(['purge', '--format', 'json']), /--json is only supported with status and list/)
    assert.throws(() => parseCliArgs(['setup', '--port', '3030']), /--port is only supported with tunnel/)
    assert.throws(() => parseCliArgs(['setup', '--workspace', '/tmp/a', '--workspace', '/tmp/b']), /--workspace can only be repeated with down/)
    assert.throws(() => parseCliArgs(['setup', '--', '--ignored']), /passthrough is only supported/)
    assert.throws(() => parseCliArgs(['purge', '--json']), /--json is only supported with status and list/)
    assert.throws(() => parseCliArgs(['purge', '--port', '3030']), /--port is only supported with tunnel/)
    assert.throws(() => parseCliArgs(['purge', '--recreate']), /--recreate is not supported with purge/)
    assert.throws(() => parseCliArgs(['claude', 'resume']), /must come after --/)
    assert.throws(() => parseCliArgs(['claude', '--continue']), /Unknown option: --continue/)
    assert.throws(() => parseCliArgs(['tunnel', '--port', '0']), /Invalid tunnel port: 0/)
    assert.throws(() => parseCliArgs(['tunnel', '--port', '65536']), /Invalid tunnel port: 65536/)
    assert.throws(() => parseCliArgs(['tunnel', '--port', '3030:3031:3032']), /Invalid tunnel port: 3030:3031:3032/)
  })

  test('help describes available commands', () => {
    const usageLines = USAGE.split(/\r?\n/)

    assert.match(USAGE, /Commands:/)
    assert.match(USAGE, /boxdown setup \[--workspace <path>\] \[--alias <name>\] \[--recreate\] \[--target <name>\]\.\.\./)
    assert.match(USAGE, /boxdown list \[--details\] \[--json\|--format json\]/)
    assert.match(USAGE, /boxdown status \[--workspace <path>\] \[--alias <name>\] \[--json\|--format json\]/)
    assert.match(USAGE, /setup\s+Prepare the workspace devcontainer/)
    assert.match(USAGE, /start, shell\s+Start or reuse the workspace devcontainer/)
    assert.match(USAGE, /codex\s+Start or reuse the devcontainer, then launch Codex/)
    assert.match(USAGE, /claude, cc\s+Start or reuse the devcontainer, then launch Claude/)
    assert.match(USAGE, /opencode\s+Start or reuse the devcontainer, then launch/)
    assert.match(USAGE, /antigravity\s+Start or reuse the devcontainer, then launch/)
    assert.match(USAGE, /list\s+List Boxdown-known devcontainer workspaces/)
    assert.match(USAGE, /status\s+Show workspace state/)
    assert.match(USAGE, /stop\s+Stop the workspace devcontainer/)
    assert.match(USAGE, /down\s+Remove the workspace devcontainer/)
    assert.match(USAGE, /boxdown down \[--workspace <path>\]\.\.\./)
    assert.match(USAGE, /purge\s+Remove the workspace devcontainer, exact Docker/)
    assert.match(USAGE, /boxdown purge \[--workspace <path\|ssh-alias\|repo>\] \[--alias <name>\]/)
    assert.match(USAGE, /--workspace <path>\s+Target project directory[\s\S]*Repeatable with down\. With purge, also accepts PATH,/)
    assert.match(USAGE, /SSH ALIAS, or an unambiguous REPO from boxdown list\./)
    assert.match(USAGE, /Without --workspace, purge only targets the current[\s\S]*interactive[\s\S]*terminals prompt for tracked workspaces\./)
    assert.match(USAGE, /--json\s+Print JSON output\. Supported by status and list\./)
    assert.match(USAGE, /--format json\s+Print JSON output\. Equivalent to --json\./)
    assert.match(USAGE, /--details\s+Print detailed human list output\. Supported by list\./)
    assert.match(USAGE, /--verbose\s+Stream raw Docker, devcontainer, and hook command output\.[\s\S]*per-workspace command log either way\./)
    assert.match(USAGE, /--version, -v\s+Show version\./)
    assert.match(USAGE, /doctor\s+Check required host tools/)
    assert.doesNotMatch(USAGE, /Alias:/)
    assert.ok(!usageLines.includes('  boxdown cc [--workspace <path>] [--recreate] [-- <claude args...>]'))
    assert.ok(!usageLines.includes('  boxdown shell [--workspace <path>] [--recreate]'))
    assert.ok(!usageLines.includes('  boxdown install-ssh-config [--workspace <path>] [--alias <name>]'))
    assert.ok(!usageLines.includes('  boxdown ssh-config install [--workspace <path>] [--alias <name>] [--target codex]'))
    assert.ok(!usageLines.includes('  boxdown ssh-config uninstall [--workspace <path>] [--alias <name>]'))
    assert.ok(!usageLines.some((line) => line.startsWith('  shell')))
    assert.ok(!usageLines.some((line) => line.startsWith('  cc')))
    assert.ok(!usageLines.some((line) => line.startsWith('  install-ssh-config')))
    assert.match(USAGE, /ssh install\s+Install or update an SSH host alias/)
    assert.match(USAGE, /ssh uninstall\s+Remove Boxdown's managed SSH host alias/)
    assert.doesNotMatch(USAGE, /ssh-config/)
    assert.match(USAGE, /--target <name>\s+Optional SSH install target/)
    assert.match(USAGE, /Repeatable\. Supported by[\s\S]*setup and ssh install: codex, claude\./)
    assert.match(USAGE, /ssh-proxy\s+Internal command used by the generated SSH/)
    assert.match(USAGE, /tunnel\s+Start or reuse the devcontainer/)
    assert.match(USAGE, /boxdown tunnel \[--port <port>\]/)
    assert.match(USAGE, /--port <port>\s+Tunnel a local port/)
    assert.match(USAGE, /refresh-gh-token\s+Start or reuse the devcontainer/)
    assert.match(USAGE, /refresh-gh-token-running\s+Refresh GitHub CLI auth only if/)
  })

  test('help aligns wrapped command descriptions', () => {
    const usageLines = USAGE.split(/\r?\n/)
    const commandsStart = usageLines.indexOf('Commands:')
    const optionsStart = usageLines.indexOf('Options:')
    const commandLines = usageLines.slice(commandsStart + 1, optionsStart)
    const setupLine = commandLines.find((line) => line.startsWith('  setup'))
    const setupContinuationLine = commandLines[commandLines.findIndex((line) => line.startsWith('  setup')) + 1]
    const longestCommandLine = commandLines.find((line) => line.startsWith('  refresh-gh-token-running'))

    assert.ok(setupLine !== undefined)
    assert.ok(setupContinuationLine !== undefined)
    assert.ok(longestCommandLine !== undefined)

    const descriptionColumn = longestCommandLine.indexOf('Refresh')
    assert.strictEqual(setupLine.indexOf('Prepare'), descriptionColumn)
    assert.strictEqual(setupContinuationLine.indexOf('integration'), descriptionColumn)
  })
})

describe('interactive install target prompt', () => {
  test('uses the shared prompt style primitives', () => {
    assert.strictEqual(formatPromptTitle('Install optional SSH targets?'), '\u001B[36m◆\u001B[0m  \u001B[1mInstall optional SSH targets?\u001B[0m')
    assert.strictEqual(promptRail(), '\u001B[36m│\u001B[0m')
    assert.strictEqual(selectedMark(), '\u001B[32m■\u001B[0m')
  })

  test('selects a target with raw-mode keys', async () => {
    const { input, output, outputText } = fakePromptStreams()
    const resultPromise = promptMultiSelect({
      title: 'Install optional SSH targets?',
      choices: [codexPromptChoice],
      skipLabel: 'Skip optional targets',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('\u001B[A')
    input.write(' ')
    input.write('\r')

    assert.deepStrictEqual(await resultPromise, {
      status: 'selected',
      values: ['codex']
    })
    assert.match(outputText(), /\u001B\[36m◆\u001B\[0m {2}\u001B\[1mInstall optional SSH targets\?\u001B\[0m/)
    assert.match(outputText(), /\u001B\[36m│\u001B\[0m {2}\u001B\[32m■\u001B\[0m \u001B\[1mCodex\u001B\[0m/)
  })

  test('redraws raw-mode long choices over wrapped terminal rows', async () => {
    const { input, output, outputText } = fakePromptStreams({ columns: 32 })
    const resultPromise = promptMultiSelect({
      title: 'Install optional SSH targets?',
      choices: [{
        value: 'codex',
        label: 'Codex',
        description: 'Register this SSH alias as a Codex app remote project with a deliberately long description.'
      }],
      skipLabel: 'Skip optional targets',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('\u001B[A')
    input.write('\u001B[B')
    input.write('\r')

    assert.deepStrictEqual(await resultPromise, {
      status: 'skipped',
      values: []
    })

    const redrawRows = [...outputText().matchAll(/\u001B\[(\d+)A\r\u001B\[J/gu)].map((match) => Number(match[1]))
    assert.strictEqual(redrawRows.length, 2)
    assert.ok(redrawRows.every((rowCount) => rowCount > 5))
  })

  test('colors focused description segments without changing unfocused rows', async () => {
    const { input, output, outputText } = fakePromptStreams()
    const resultPromise = promptMultiSelect({
      title: 'Purge Boxdown workspaces?',
      choices: [
        {
          value: 'absent',
          label: 'absent-repo',
          description: '(absent) /tmp/absent',
          focusedDescription: [
            { text: '(absent)', color: 'red' },
            { text: ' /tmp/absent', color: 'dim' }
          ]
        },
        {
          value: 'running',
          label: 'running-repo',
          description: '(running) /tmp/running',
          focusedDescription: [
            { text: '(running)', color: 'green' },
            { text: ' /tmp/running', color: 'dim' }
          ]
        },
        {
          value: 'exited',
          label: 'exited-repo',
          description: '(exited) /tmp/exited',
          focusedDescription: [
            { text: '(exited)', color: 'yellow' },
            { text: ' /tmp/exited', color: 'dim' }
          ]
        }
      ],
      skipLabel: 'Cancel',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('\u001B[A')
    input.write(' ')
    input.write('\r')

    assert.deepStrictEqual(await resultPromise, {
      status: 'selected',
      values: ['exited']
    })

    assert.ok(outputText().includes(color(' - (absent) /tmp/absent', 'dim')))
    assert.ok(outputText().includes(color(' - (running) /tmp/running', 'dim')))
    assert.ok(outputText().includes(`${color(' - ', 'dim')}${color('(exited)', 'yellow')}${color(' /tmp/exited', 'dim')}`))
  })

  test('starts raw-mode focus on the selected skip row', async () => {
    const { input, output, outputText } = fakePromptStreams()
    const resultPromise = promptMultiSelect({
      title: 'Install optional SSH targets?',
      choices: [codexPromptChoice],
      skipLabel: 'Skip optional targets',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('\r')

    assert.deepStrictEqual(await resultPromise, {
      status: 'skipped',
      values: []
    })
    assert.match(outputText(), /\u001B\[36m│\u001B\[0m {2}\u001B\[32m■\u001B\[0m \u001B\[1mSkip optional targets\u001B\[0m/)
    assert.match(outputText(), /\u001B\[36m└\u001B\[0m/)
    assert.doesNotMatch(outputText(), /Use arrows to move/)
    assert.doesNotMatch(outputText(), /Ctrl-C to cancel/)
  })

  test('falls back to line-based selection when raw mode is unavailable', async () => {
    const { input, output } = fakePromptStreams({ rawMode: false })
    const resultPromise = promptMultiSelect({
      title: 'Install optional SSH targets?',
      choices: [codexPromptChoice],
      skipLabel: 'Skip optional targets',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('1\n')

    assert.deepStrictEqual(await resultPromise, {
      status: 'selected',
      values: ['codex']
    })
  })

  test('skips without blocking when input is not interactive', async () => {
    const input = new PassThrough() as PassThrough & PromptInput
    const output = new PassThrough() as PassThrough & PromptOutput

    input.isTTY = false
    output.isTTY = false

    assert.deepStrictEqual(await promptMultiSelect({
      title: 'Install optional SSH targets?',
      choices: [codexPromptChoice],
      skipLabel: 'Skip optional targets',
      input,
      output,
      env: { CI: 'false' }
    }), {
      status: 'non-interactive',
      values: []
    })
  })

  test('cancels when the raw-mode prompt receives Ctrl-C', async () => {
    const { input, output } = fakePromptStreams()
    const resultPromise = promptMultiSelect({
      title: 'Install optional SSH targets?',
      choices: [codexPromptChoice],
      skipLabel: 'Skip optional targets',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('\u0003')

    assert.deepStrictEqual(await resultPromise, {
      status: 'cancelled',
      values: []
    })
  })

  test('text prompt accepts a default value on blank input', async () => {
    const { input, output, outputText } = fakePromptStreams()
    const resultPromise = promptText({
      title: 'Tunnel port(s) to forward?',
      defaultValue: '3000',
      summaryLabel: 'Tunnel ports',
      validate: (value) => {
        try {
          parseTunnelPortList(value)
          return undefined
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('\n')

    assert.deepStrictEqual(await resultPromise, {
      status: 'submitted',
      value: '3000'
    })
    assert.match(outputText(), /\u001B\[36m◆\u001B\[0m {2}\u001B\[1mTunnel port\(s\) to forward\?\u001B\[0m/)
    assert.match(outputText(), /Tunnel ports: 3000/)
  })

  test('text prompt retries invalid tunnel ports until corrected', async () => {
    const { input, output, outputText } = fakePromptStreams()
    const resultPromise = promptText({
      title: 'Tunnel port(s) to forward?',
      summaryLabel: 'Tunnel ports',
      validate: (value) => {
        try {
          parseTunnelPortList(value)
          return undefined
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('nope\n')
    input.write('3030, 8080:3031\n')

    assert.deepStrictEqual(await resultPromise, {
      status: 'submitted',
      value: '3030, 8080:3031'
    })
    assert.match(outputText(), /Invalid tunnel port: nope/)
  })

  test('confirm prompt defaults to cancel', async () => {
    const { input, output, outputText } = fakePromptStreams()
    const resultPromise = promptConfirm({
      title: 'Purge Boxdown workspace?',
      details: ['Workspace: /tmp/demo'],
      confirmLabel: 'Purge',
      cancelLabel: 'Cancel',
      summaryLabel: 'Purge',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('\r')

    assert.deepStrictEqual(await resultPromise, {
      status: 'denied'
    })
    assert.match(outputText(), /\u001B\[36m│\u001B\[0m {2}\u001B\[32m■\u001B\[0m \u001B\[1mCancel\u001B\[0m/)
    assert.match(outputText(), /Purge: canceled/)
  })

  test('confirm prompt confirms with arrow selection', async () => {
    const { input, output, outputText } = fakePromptStreams()
    const resultPromise = promptConfirm({
      title: 'Purge Boxdown workspace?',
      details: ['Workspace: /tmp/demo'],
      confirmLabel: 'Purge',
      cancelLabel: 'Cancel',
      summaryLabel: 'Purge',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('\u001B[C')
    input.write('\r')

    assert.deepStrictEqual(await resultPromise, {
      status: 'confirmed'
    })
    assert.match(outputText(), /\u001B\[36m│\u001B\[0m {2}\u001B\[32m■\u001B\[0m \u001B\[1mPurge\u001B\[0m/)
    assert.match(outputText(), /Purge: confirmed/)
  })

  test('confirm prompt cancels on Ctrl-C', async () => {
    const { input, output } = fakePromptStreams()
    const resultPromise = promptConfirm({
      title: 'Purge Boxdown workspace?',
      details: ['Workspace: /tmp/demo'],
      confirmLabel: 'Purge',
      cancelLabel: 'Cancel',
      summaryLabel: 'Purge',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('\u0003')

    assert.deepStrictEqual(await resultPromise, {
      status: 'cancelled'
    })
  })

  test('new prompt types skip without blocking when input is not interactive', async () => {
    const input = new PassThrough() as PassThrough & PromptInput
    const output = new PassThrough() as PassThrough & PromptOutput

    input.isTTY = false
    output.isTTY = false

    assert.deepStrictEqual(await promptText({
      title: 'Tunnel port(s) to forward?',
      summaryLabel: 'Tunnel ports',
      input,
      output,
      env: { CI: 'false' }
    }), {
      status: 'non-interactive'
    })
    assert.deepStrictEqual(await promptConfirm({
      title: 'Purge Boxdown workspace?',
      confirmLabel: 'Purge',
      cancelLabel: 'Cancel',
      summaryLabel: 'Purge',
      input,
      output,
      env: { CI: 'false' }
    }), {
      status: 'non-interactive'
    })
  })
})

describe('CLI execution', () => {
  test('setup stops before prompts or state writes when the readiness preflight fails', async () => {
    const workspace = tempDir('setup-preflight-failure-workspace')
    const dataHome = tempDir('setup-preflight-failure-data')
    const cacheHome = tempDir('setup-preflight-failure-cache')
    const calls: string[] = []

    const code = await withProcessEnv({
      BOXDOWN_DATA_HOME: dataHome,
      BOXDOWN_CACHE_HOME: cacheHome,
      CI: '1'
    }, async () => runCli(['setup', '--workspace', workspace], {
      env: { CI: '1', BOXDOWN_DATA_HOME: dataHome, BOXDOWN_CACHE_HOME: cacheHome },
      runDoctorChecks: async () => {
        calls.push('doctor')
        return [{
          name: 'docker-daemon',
          level: 'fail',
          message: 'Docker daemon is required but was not reachable'
        }]
      },
      setupWorkspace: async () => {
        calls.push('setup')
      }
    }))

    const context = createWorkspaceContext({
      workspace,
      env: { BOXDOWN_DATA_HOME: dataHome, BOXDOWN_CACHE_HOME: cacheHome }
    })
    assert.strictEqual(code, 1)
    assert.deepStrictEqual(calls, ['doctor'])
    assert.strictEqual(existsSync(context.workspaceDataDir), false)
    assert.strictEqual(existsSync(context.sshKeyPath), false)
    assert.strictEqual(existsSync(context.generatedConfigPath), false)
  })

  test('setup continues after a non-blocking readiness warning', async () => {
    const workspace = tempDir('setup-preflight-warning-workspace')
    const dataHome = tempDir('setup-preflight-warning-data')
    const cacheHome = tempDir('setup-preflight-warning-cache')
    const calls: string[] = []

    const code = await withProcessEnv({
      BOXDOWN_DATA_HOME: dataHome,
      BOXDOWN_CACHE_HOME: cacheHome,
      CI: '1'
    }, async () => runCli(['setup', '--workspace', workspace], {
      env: { CI: '1', BOXDOWN_DATA_HOME: dataHome, BOXDOWN_CACHE_HOME: cacheHome },
      runDoctorChecks: async () => {
        calls.push('doctor')
        return [{
          name: 'docker-bind-mounts',
          level: 'warn',
          message: 'Docker bind-mount readiness was not checked because no local Docker image is available'
        }]
      },
      setupWorkspace: async () => {
        calls.push('setup')
      }
    }))

    assert.strictEqual(code, 0)
    assert.deepStrictEqual(calls, ['doctor', 'setup'])
  })

  test('setup workflow starts devcontainer and installs SSH without opening a shell', async () => {
    const workspace = tempDir('setup-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('setup-cache'),
        BOXDOWN_DATA_HOME: tempDir('setup-data')
      },
      assetsDevcontainerDir
    })
    const alias = 'demo-devcontainer'
    const calls: string[] = []

    await setupWorkspace(context, alias, {
      start: async (receivedContext, options) => {
        assert.strictEqual(receivedContext, context)
        assert.deepStrictEqual(options, { recreate: undefined })
        calls.push('start')
        return 'setup-container'
      },
      installSsh: async (receivedContext, receivedAlias) => {
        assert.strictEqual(receivedContext, context)
        assert.strictEqual(receivedAlias, alias)
        calls.push('ssh')
      }
    })

    assert.deepStrictEqual(calls, ['start', 'ssh'])
  })

  test('setup workflow passes recreate and installs selected targets', async () => {
    const workspace = tempDir('setup-codex-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('setup-codex-cache'),
        BOXDOWN_DATA_HOME: tempDir('setup-codex-data')
      },
      assetsDevcontainerDir
    })
    const alias = 'demo-devcontainer'
    const calls: string[] = []

    await setupWorkspace(context, alias, {
      recreate: true,
      targets: ['codex'],
      start: async (receivedContext, options) => {
        assert.strictEqual(receivedContext, context)
        assert.deepStrictEqual(options, { recreate: true })
        calls.push('start')
        return 'setup-container'
      },
      installSsh: async () => {
        calls.push('ssh')
      },
      installTarget: async (receivedContext, receivedAlias, target) => {
        assert.strictEqual(receivedContext, context)
        assert.strictEqual(receivedAlias, alias)
        assert.strictEqual(target, 'codex')
        calls.push('codex')
      }
    })

    assert.deepStrictEqual(calls, ['start', 'ssh', 'codex'])
  })

  test('setup workflow uses progress-aware quiet installs', async () => {
    const workspace = tempDir('setup-progress-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('setup-progress-cache'),
        BOXDOWN_DATA_HOME: tempDir('setup-progress-data')
      },
      assetsDevcontainerDir
    })
    const alias = 'demo-devcontainer'
    const lines: string[] = []
    const progress = createProgress({
      write: (target, message) => {
        lines.push(`${target}:${message}`)
      }
    })
    const calls: string[] = []

    await setupWorkspace(context, alias, {
      progress,
      targets: ['codex'],
      start: async (receivedContext, options) => {
        assert.strictEqual(receivedContext, context)
        assert.strictEqual(options.progress, progress)
        calls.push('start')
        return 'setup-container'
      },
      installSsh: async (receivedContext, receivedAlias, installOptions) => {
        assert.strictEqual(receivedContext, context)
        assert.strictEqual(receivedAlias, alias)
        assert.deepStrictEqual(installOptions, { quiet: true })
        calls.push('ssh')
      },
      installTarget: async (receivedContext, receivedAlias, target, installOptions) => {
        assert.strictEqual(receivedContext, context)
        assert.strictEqual(receivedAlias, alias)
        assert.strictEqual(target, 'codex')
        assert.deepStrictEqual(installOptions, { quiet: true })
        calls.push('codex')
      }
    })

    assert.deepStrictEqual(calls, ['start', 'ssh', 'codex'])
    assert.ok(lines.includes(`stdout:${promptRail()}  ${selectedMark()} Installing SSH alias`))
    assert.ok(lines.includes(`stdout:${promptRail()}  ${color('demo-devcontainer', 'dim')}`))
    assert.ok(lines.includes(`stdout:${promptRail()}  ${selectedMark()} Installing codex SSH target`))
  })

  test('removes each requested down workspace', async () => {
    const alpha = tempDir('down-alpha-workspace')
    const beta = tempDir('down-beta-workspace')

    await withFakeDocker([
      { workspace: alpha, id: 'alpha-container' },
      { workspace: beta, id: 'beta-container' }
    ], async (logPath, env) => {
      const result = runCliProcess(['down', '--workspace', alpha, '--workspace', beta], env)
      const rmCalls = fakeDockerCalls(logPath).filter((line) => line.startsWith('rm -f '))

      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(rmCalls, ['rm -f alpha-container', 'rm -f beta-container'])
      assert.match(result.stdout, /Removed devcontainer: alpha-container/)
      assert.match(result.stdout, /Removed devcontainer: beta-container/)
    })
  })

  test('continues batch down after a removal failure', async () => {
    const alpha = tempDir('down-fail-alpha-workspace')
    const beta = tempDir('down-fail-beta-workspace')
    const gamma = tempDir('down-fail-gamma-workspace')

    await withFakeDocker([
      { workspace: alpha, id: 'alpha-container' },
      { workspace: beta, id: 'beta-container', removeExitCode: 37 },
      { workspace: gamma, id: 'gamma-container' }
    ], async (logPath, env) => {
      const result = runCliProcess(['down', '--workspace', alpha, '--workspace', beta, '--workspace', gamma], env)
      const rmCalls = fakeDockerCalls(logPath).filter((line) => line.startsWith('rm -f '))

      assert.strictEqual(result.code, 1)
      assert.deepStrictEqual(rmCalls, ['rm -f alpha-container', 'rm -f beta-container', 'rm -f gamma-container'])
      assert.match(result.stderr, /Could not remove devcontainer beta-container/)
      assert.match(result.stdout, /Removed devcontainer: alpha-container/)
      assert.match(result.stdout, /Removed devcontainer: gamma-container/)
    })
  })

  test('continues batch down after a missing workspace path', async () => {
    const missing = join(tempDir('down-missing-parent'), 'missing-workspace')
    const valid = tempDir('down-valid-workspace')

    await withFakeDocker([
      { workspace: valid, id: 'valid-container' }
    ], async (logPath, env) => {
      const result = runCliProcess(['down', '--workspace', missing, '--workspace', valid], env)
      const rmCalls = fakeDockerCalls(logPath).filter((line) => line.startsWith('rm -f '))

      assert.strictEqual(result.code, 1)
      assert.deepStrictEqual(rmCalls, ['rm -f valid-container'])
      assert.match(result.stderr, /Workspace does not exist:/)
      assert.match(result.stdout, /Removed devcontainer: valid-container/)
    })
  })

  test('keeps current down behavior when cwd is a known workspace', async () => {
    const workspace = tempDir('down-known-cwd-workspace')
    const env = {
      HOME: tempDir('down-known-cwd-home'),
      BOXDOWN_CACHE_HOME: tempDir('down-known-cwd-cache'),
      BOXDOWN_DATA_HOME: tempDir('down-known-cwd-data')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      { workspace, id: 'known-cwd-container' }
    ], async (logPath, dockerEnv) => {
      const code = await withProcessEnv({
        ...dockerEnv,
        ...env
      }, async () => withCwd(workspace, async () => runCli(['down'])))
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(code, 0)
      assert.ok(calls.includes('rm -f known-cwd-container'))
    })
  })

  test('down appends Docker and Boxdown output to the workspace log', async () => {
    const workspace = tempDir('down-log-workspace')
    const env = {
      HOME: tempDir('down-log-home'),
      BOXDOWN_CACHE_HOME: tempDir('down-log-cache'),
      BOXDOWN_DATA_HOME: tempDir('down-log-data')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    await withFakeDocker([
      { workspace, id: 'down-log-container' }
    ], async (_logPath, dockerEnv) => {
      const code = await withProcessEnv({
        ...dockerEnv,
        ...env
      }, async () => runCli(['down', '--workspace', workspace]))
      const log = readFileSync(context.workspaceLogPath, 'utf8')

      assert.strictEqual(code, 0)
      assert.match(log, /=== boxdown down ===/)
      assert.match(log, /command start: \["docker","ps"/)
      assert.match(log, /command start: \["docker","rm","-f","down-log-container"\]/)
      assert.match(log, /\[boxdown\] Removed devcontainer: down-log-container/)
    })
  })

  test('prompts for known workspaces when down runs from an unknown cwd', async () => {
    const alpha = tempDir('down-prompt-alpha-workspace')
    const beta = tempDir('down-prompt-beta-workspace')
    const unknown = tempDir('down-prompt-unknown-cwd')
    const env = {
      HOME: tempDir('down-prompt-home'),
      BOXDOWN_CACHE_HOME: tempDir('down-prompt-cache'),
      BOXDOWN_DATA_HOME: tempDir('down-prompt-data')
    }
    const alphaContext = createWorkspaceContext({ workspace: alpha, env, assetsDevcontainerDir })
    const betaContext = createWorkspaceContext({ workspace: beta, env, assetsDevcontainerDir })
    const { input, output } = fakePromptStreams()

    writeWorkspaceMetadata(alphaContext, defaultSshAlias(alphaContext.workspaceBasename))
    writeWorkspaceMetadata(betaContext, defaultSshAlias(betaContext.workspaceBasename))

    await withFakeDocker([
      { workspace: alpha, id: 'alpha-prompt-container' },
      { workspace: beta, id: 'beta-prompt-container' }
    ], async (logPath, dockerEnv) => {
      const codePromise = withProcessEnv({
        ...dockerEnv,
        ...env
      }, async () => withCwd(unknown, async () => runCli(['down'], {
        promptInput: input,
        promptOutput: output,
        env: { ...process.env, CI: 'false' }
      })))

      input.write('\u001B[A')
      input.write(' ')
      input.write('\u001B[A')
      input.write(' ')
      input.write('\r')

      const code = await codePromise
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(code, 0)
      assert.ok(calls.includes('rm -f alpha-prompt-container'))
      assert.ok(calls.includes('rm -f beta-prompt-container'))
    })
  })

  test('cancels prompted down without removing workspaces', async () => {
    const workspace = tempDir('down-prompt-cancel-workspace')
    const unknown = tempDir('down-prompt-cancel-unknown-cwd')
    const env = {
      HOME: tempDir('down-prompt-cancel-home'),
      BOXDOWN_CACHE_HOME: tempDir('down-prompt-cancel-cache'),
      BOXDOWN_DATA_HOME: tempDir('down-prompt-cancel-data')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const { input, output } = fakePromptStreams()

    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      { workspace, id: 'cancel-down-container' }
    ], async (logPath, dockerEnv) => {
      const codePromise = withProcessEnv({
        ...dockerEnv,
        ...env
      }, async () => withCwd(unknown, async () => runCli(['down'], {
        promptInput: input,
        promptOutput: output,
        env: { ...process.env, CI: 'false' }
      })))

      input.write('\r')

      const code = await codePromise
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(code, 1)
      assert.ok(!calls.some((line) => line.startsWith('rm -f')))
      assert.strictEqual(existsSync(context.workspaceLogPath), false)
    })
  })

  test('keeps non-interactive unknown-cwd down behavior', async () => {
    const workspace = tempDir('down-non-tty-known-workspace')
    const unknown = tempDir('down-non-tty-unknown-cwd')
    const env = {
      HOME: tempDir('down-non-tty-home'),
      BOXDOWN_CACHE_HOME: tempDir('down-non-tty-cache'),
      BOXDOWN_DATA_HOME: tempDir('down-non-tty-data')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      { workspace, id: 'non-tty-known-container' }
    ], async (logPath, dockerEnv) => {
      const code = await withProcessEnv({
        ...dockerEnv,
        ...env
      }, async () => withCwd(unknown, async () => runCli(['down'])))
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(code, 0)
      assert.ok(calls.some((line) => line.startsWith('ps -a ')))
      assert.ok(!calls.some((line) => line.startsWith('rm -f')))
    })
  })

  test('tunnel with no port still errors without a TTY and writes no metadata', () => {
    const workspace = tempDir('tunnel-non-tty-workspace')
    const dataDir = tempDir('tunnel-non-tty-data')
    const result = runCliProcess(['tunnel', '--workspace', workspace], {
      ...process.env,
      HOME: tempDir('tunnel-non-tty-home'),
      BOXDOWN_CACHE_HOME: tempDir('tunnel-non-tty-cache'),
      BOXDOWN_DATA_HOME: dataDir,
      BOXDOWN_SSH_CONFIG: join(tempDir('tunnel-non-tty-ssh'), 'config')
    })

    assert.strictEqual(result.code, 1)
    assert.match(result.stderr, /tunnel requires at least one --port value/)
    assert.deepStrictEqual(listWorkspaceMetadata(dataDir), [])
  })

  test('cancels prompted tunnel without writing metadata or SSH config', async () => {
    const workspace = tempDir('tunnel-prompt-cancel-workspace')
    const dataDir = tempDir('tunnel-prompt-cancel-data')
    const sshConfigPath = join(tempDir('tunnel-prompt-cancel-ssh'), 'config')
    const { input, output } = fakePromptStreams()

    const codePromise = withProcessEnv({
      HOME: tempDir('tunnel-prompt-cancel-home'),
      BOXDOWN_CACHE_HOME: tempDir('tunnel-prompt-cancel-cache'),
      BOXDOWN_DATA_HOME: dataDir,
      BOXDOWN_SSH_CONFIG: sshConfigPath
    }, async () => runCli(['tunnel', '--workspace', workspace], {
      promptInput: input,
      promptOutput: output,
      env: { ...process.env, CI: 'false' }
    }))

    input.end()

    const code = await codePromise

    assert.strictEqual(code, 1)
    assert.deepStrictEqual(listWorkspaceMetadata(dataDir), [])
    assert.strictEqual(existsSync(createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('tunnel-prompt-cancel-cache-after'),
        BOXDOWN_DATA_HOME: dataDir
      },
      assetsDevcontainerDir
    }).workspaceLogPath), false)
    assert.strictEqual(existsSync(sshConfigPath), false)
  })

  test('installs explicit Codex ssh install target', () => {
    const workspace = tempDir('cli-explicit-codex-workspace')
    const sshConfigPath = join(tempDir('cli-explicit-codex-ssh'), 'config')
    const codexConfigPath = join(tempDir('cli-explicit-codex-app'), 'config.json')
    const result = runCliProcess(['ssh', 'install', '--workspace', workspace, '--target', 'codex'], {
      ...process.env,
      HOME: tempDir('cli-explicit-codex-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-explicit-codex-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-explicit-codex-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CODEX_APP_CONFIG: codexConfigPath
    })
    const codexConfig = parseCodexAppConfig(JSON.parse(readFileSync(codexConfigPath, 'utf8')))

    assert.strictEqual(result.code, 0)
    assert.match(result.stdout, /Installed SSH alias:/)
    assert.match(result.stdout, /Installed Codex remote project:/)
    assert.strictEqual(existsSync(sshConfigPath), true)
    assert.strictEqual(codexConfig.remoteConnections.length, 1)
    assert.strictEqual(codexConfig.remoteConnections[0]?.projects[0]?.label, realpathSync(workspace).split('/').at(-1))
  })

  test('installs explicit Claude ssh install target', () => {
    const workspace = tempDir('cli-explicit-claude-workspace')
    const sshConfigPath = join(tempDir('cli-explicit-claude-ssh'), 'config')
    const claudeConfigPath = join(tempDir('cli-explicit-claude-app'), 'ssh_configs.json')
    const result = runCliProcess(['ssh', 'install', '--workspace', workspace, '--target', 'claude'], {
      ...process.env,
      HOME: tempDir('cli-explicit-claude-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-explicit-claude-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-explicit-claude-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CLAUDE_SSH_CONFIGS: claudeConfigPath
    })
    const claudeConfig = parseClaudeSshConfigs(JSON.parse(readFileSync(claudeConfigPath, 'utf8')))
    const workspaceName = realpathSync(workspace).split('/').at(-1) ?? 'workspace'

    assert.strictEqual(result.code, 0)
    assert.match(result.stdout, /Installed SSH alias:/)
    assert.match(result.stdout, /Installed Claude SSH remote:/)
    assert.strictEqual(existsSync(sshConfigPath), true)
    assert.deepStrictEqual(claudeConfig.configs.map((config) => ({
      name: config.name,
      sshHost: config.sshHost,
      source: config.source
    })), [
      {
        name: workspaceName,
        sshHost: `${workspaceName}-devcontainer`,
        source: 'desktop'
      }
    ])
    assert.match(claudeConfig.configs[0]?.id ?? '', /^[0-9a-f-]{36}$/u)
    assert.deepStrictEqual(claudeConfig.trustedHosts, [`${workspaceName}-devcontainer`])
  })

  test('skips optional ssh install targets without a TTY', () => {
    const workspace = tempDir('cli-non-tty-workspace')
    const sshConfigPath = join(tempDir('cli-non-tty-ssh'), 'config')
    const codexConfigPath = join(tempDir('cli-non-tty-codex-app'), 'config.json')
    const result = runCliProcess(['ssh', 'install', '--workspace', workspace], {
      ...process.env,
      HOME: tempDir('cli-non-tty-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-non-tty-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-non-tty-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CODEX_APP_CONFIG: codexConfigPath
    })

    assert.strictEqual(result.code, 0)
    assert.match(result.stdout, /No optional SSH install targets selected/)
    assert.strictEqual(existsSync(sshConfigPath), true)
    assert.strictEqual(existsSync(codexConfigPath), false)
  })

  test('installs prompt-selected Codex ssh install target', async () => {
    const workspace = tempDir('cli-prompt-codex-workspace')
    const sshConfigPath = join(tempDir('cli-prompt-codex-ssh'), 'config')
    const codexConfigPath = join(tempDir('cli-prompt-codex-app'), 'config.json')
    const { input, output } = fakePromptStreams()

    const code = await withProcessEnv({
      HOME: tempDir('cli-prompt-codex-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-prompt-codex-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-prompt-codex-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CODEX_APP_CONFIG: codexConfigPath
    }, async () => {
      const runPromise = runCli(['ssh', 'install', '--workspace', workspace], {
        promptInput: input,
        promptOutput: output,
        env: { ...process.env, CI: 'false' }
      })

      input.write('\u001B[A')
      input.write('\u001B[A')
      input.write(' ')
      input.write('\r')

      return runPromise
    })
    const codexConfig = parseCodexAppConfig(JSON.parse(readFileSync(codexConfigPath, 'utf8')))

    assert.strictEqual(code, 0)
    assert.strictEqual(existsSync(sshConfigPath), true)
    assert.strictEqual(codexConfig.remoteConnections[0]?.sshAlias, defaultSshAlias(realpathSync(workspace).split('/').at(-1) ?? 'workspace'))
  })

  test('cancels prompted ssh install without installing', async () => {
    const workspace = tempDir('cli-prompt-cancel-workspace')
    const sshConfigPath = join(tempDir('cli-prompt-cancel-ssh'), 'config')
    const codexConfigPath = join(tempDir('cli-prompt-cancel-app'), 'config.json')
    const dataDir = tempDir('cli-prompt-cancel-data')
    const { input, output } = fakePromptStreams()

    const code = await withProcessEnv({
      HOME: tempDir('cli-prompt-cancel-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-prompt-cancel-cache'),
      BOXDOWN_DATA_HOME: dataDir,
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CODEX_APP_CONFIG: codexConfigPath
    }, async () => {
      const runPromise = runCli(['ssh', 'install', '--workspace', workspace], {
        promptInput: input,
        promptOutput: output,
        env: { ...process.env, CI: 'false' }
      })

      input.write('\u0003')

      return runPromise
    })

    assert.strictEqual(code, 1)
    assert.strictEqual(existsSync(sshConfigPath), false)
    assert.strictEqual(existsSync(codexConfigPath), false)
    assert.deepStrictEqual(listWorkspaceMetadata(dataDir), [])
  })

  test('purges workspace container image state and managed integrations', async () => {
    const workspace = tempDir('purge-workspace')
    const env = {
      HOME: tempDir('purge-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-codex-state'), '.codex-global-state.json'),
      BOXDOWN_CLAUDE_SSH_CONFIGS: join(tempDir('purge-claude-app'), 'ssh_configs.json')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const defaultAlias = defaultSshAlias(context.workspaceBasename)
    const recordedAlias = 'recorded-devcontainer'
    const providedAlias = 'provided-devcontainer'
    const otherAlias = 'other-devcontainer'

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeFileSync(context.generatedConfigPath, '{}\n')
    writeWorkspaceMetadata(context, recordedAlias)
    writeFileSync(env.BOXDOWN_SSH_CONFIG, 'Host github.com\n  User git\n')
    await installSshConfig(context, defaultAlias, { quiet: true, configPath: env.BOXDOWN_SSH_CONFIG })
    await installSshConfig(context, recordedAlias, { quiet: true, configPath: env.BOXDOWN_SSH_CONFIG })
    await installSshConfig(context, providedAlias, { quiet: true, configPath: env.BOXDOWN_SSH_CONFIG })
    installCodexAppConfigProject(codexProjectEntryForWorkspace(context, defaultAlias), { configPath: env.BOXDOWN_CODEX_APP_CONFIG })
    installCodexAppConfigProject(codexProjectEntryForWorkspace(context, recordedAlias), { configPath: env.BOXDOWN_CODEX_APP_CONFIG })
    installCodexAppConfigProject(codexProjectEntryForWorkspace(context, providedAlias), { configPath: env.BOXDOWN_CODEX_APP_CONFIG })
    installCodexAppConfigProject({
      sshAlias: otherAlias,
      remotePath: '/home/node/other',
      label: 'Other'
    }, { configPath: env.BOXDOWN_CODEX_APP_CONFIG })
    installClaudeSshConfigHost(claudeSshConfigEntryForWorkspace(context, defaultAlias), { configPath: env.BOXDOWN_CLAUDE_SSH_CONFIGS, createId: () => 'default-claude-id' })
    installClaudeSshConfigHost(claudeSshConfigEntryForWorkspace(context, recordedAlias), { configPath: env.BOXDOWN_CLAUDE_SSH_CONFIGS, createId: () => 'recorded-claude-id' })
    installClaudeSshConfigHost(claudeSshConfigEntryForWorkspace(context, providedAlias), { configPath: env.BOXDOWN_CLAUDE_SSH_CONFIGS, createId: () => 'provided-claude-id' })
    installClaudeSshConfigHost({
      name: 'Other',
      sshHost: otherAlias
    }, { configPath: env.BOXDOWN_CLAUDE_SSH_CONFIGS, createId: () => 'other-claude-id' })

    const state = {
      'remote-projects': [
        { id: 'default-project-id', hostId: codexDiscoveredRemoteHostId(defaultAlias), remotePath: `/home/node/${context.workspaceBasename}` },
        { id: 'recorded-project-id', hostId: codexDiscoveredRemoteHostId(recordedAlias), remotePath: `/home/node/${context.workspaceBasename}` },
        { id: 'provided-project-id', hostId: codexDiscoveredRemoteHostId(providedAlias), remotePath: `/home/node/${context.workspaceBasename}` },
        { id: 'other-project-id', hostId: codexDiscoveredRemoteHostId(otherAlias), remotePath: '/home/node/other' }
      ],
      'codex-managed-remote-connections': [
        { hostId: codexDiscoveredRemoteHostId(defaultAlias) },
        { hostId: codexDiscoveredRemoteHostId(recordedAlias) },
        { hostId: codexDiscoveredRemoteHostId(providedAlias) },
        { hostId: codexDiscoveredRemoteHostId(otherAlias) }
      ],
      'project-order': ['default-project-id', 'recorded-project-id', 'provided-project-id', 'other-project-id'],
      'sidebar-collapsed-groups': {
        'default-project-id': true,
        'recorded-project-id': true,
        'provided-project-id': true,
        'other-project-id': true
      }
    }
    writeFileSync(env.BOXDOWN_CODEX_GLOBAL_STATE, `${JSON.stringify(state)}\n`)

    await withFakeDocker([
      {
        workspace,
        id: 'purge-container',
        imageId: 'sha256:purge-image',
        imageName: 'boxdown-purge:latest'
      }
    ], async (logPath, dockerEnv) => {
      const result = runCliProcess(['purge', '--workspace', workspace, '--alias', providedAlias], {
        ...dockerEnv,
        ...env
      })
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(result.code, 0)
      assert.ok(calls.includes('inspect --format {{json .}} purge-container'))
      assert.ok(calls.includes('rm -f -v purge-container'))
      assert.ok(calls.includes('image rm -f sha256:purge-image'))
      assert.strictEqual(existsSync(context.workspaceFolder), true)
      assert.strictEqual(existsSync(context.workspaceCacheDir), false)
      assert.strictEqual(existsSync(context.workspaceDataDir), false)
      assert.strictEqual(existsSync(context.workspaceLogPath), false)
      assert.strictEqual(readFileSync(env.BOXDOWN_SSH_CONFIG, 'utf8'), 'Host github.com\n  User git\n')

      const codexConfig = parseCodexAppConfig(JSON.parse(readFileSync(env.BOXDOWN_CODEX_APP_CONFIG, 'utf8')))
      assert.deepStrictEqual(codexConfig.remoteConnections, [
        {
          sshAlias: otherAlias,
          projects: [
            {
              remotePath: '/home/node/other',
              label: 'Other'
            }
          ]
        }
      ])
      assert.deepStrictEqual(parseClaudeSshConfigs(JSON.parse(readFileSync(env.BOXDOWN_CLAUDE_SSH_CONFIGS, 'utf8'))), {
        configs: [
          {
            name: 'Other',
            sshHost: otherAlias,
            id: 'other-claude-id',
            source: 'desktop'
          }
        ],
        trustedHosts: [otherAlias]
      })

      const codexState = JSON.parse(readFileSync(env.BOXDOWN_CODEX_GLOBAL_STATE, 'utf8'))
      assert.deepStrictEqual(codexState['remote-projects'], [
        {
          id: 'other-project-id',
          hostId: codexDiscoveredRemoteHostId(otherAlias),
          remotePath: '/home/node/other'
        }
      ])
      assert.deepStrictEqual(codexState['project-order'], ['other-project-id'])
      assert.deepStrictEqual(codexState['sidebar-collapsed-groups'], {
        'other-project-id': true
      })
    })
  })

  test('purge removes a recorded image when the container is already absent', async () => {
    const workspace = tempDir('purge-recorded-image-workspace')
    const env = {
      HOME: tempDir('purge-recorded-image-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-recorded-image-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-recorded-image-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-recorded-image-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-recorded-image-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-recorded-image-codex-state'), '.codex-global-state.json')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeFileSync(join(context.workspaceCacheDir, 'devcontainer.json'), '{}\n')
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))
    recordWorkspaceDockerImage(context, { id: 'sha256:recorded-image', name: 'recorded:latest' })

    await withFakeDocker([], async (logPath, dockerEnv) => {
      const result = runCliProcess(['purge', '--workspace', workspace], {
        ...dockerEnv,
        ...env
      })
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(result.code, 0)
      assert.ok(calls.some((line) => line.startsWith('ps -a ')))
      assert.ok(!calls.some((line) => line.startsWith('rm -f')))
      assert.ok(calls.includes('image rm -f sha256:recorded-image'))
      assert.strictEqual(existsSync(context.workspaceCacheDir), false)
      assert.strictEqual(existsSync(context.workspaceDataDir), false)
    })
  })

  test('purge resolves workspace selector from recorded SSH alias', async () => {
    const workspace = tempDir('purge-alias-selector-workspace')
    const env = {
      HOME: tempDir('purge-alias-selector-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-alias-selector-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-alias-selector-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-alias-selector-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-alias-selector-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-alias-selector-codex-state'), '.codex-global-state.json')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const alias = 'custom-alias-selector'

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeWorkspaceMetadata(context, alias)

    await withFakeDocker([
      { workspace, id: 'purge-alias-selector-container' }
    ], async (logPath, dockerEnv) => {
      const result = runCliProcess(['purge', '--workspace', alias], {
        ...dockerEnv,
        ...env
      })
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(result.code, 0)
      assert.ok(calls.includes('rm -f -v purge-alias-selector-container'))
      assert.strictEqual(existsSync(context.workspaceCacheDir), false)
      assert.strictEqual(existsSync(context.workspaceDataDir), false)
    })
  })

  test('purge resolves workspace selector from unambiguous repo name', async () => {
    const workspace = tempDir('purge-repo-selector-workspace')
    const env = {
      HOME: tempDir('purge-repo-selector-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-repo-selector-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-repo-selector-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-repo-selector-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-repo-selector-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-repo-selector-codex-state'), '.codex-global-state.json')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      { workspace, id: 'purge-repo-selector-container' }
    ], async (logPath, dockerEnv) => {
      const result = runCliProcess(['purge', '--workspace', context.workspaceBasename], {
        ...dockerEnv,
        ...env
      })
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(result.code, 0)
      assert.ok(calls.includes('rm -f -v purge-repo-selector-container'))
      assert.strictEqual(existsSync(context.workspaceCacheDir), false)
      assert.strictEqual(existsSync(context.workspaceDataDir), false)
    })
  })

  test('purge resolves workspace selector from metadata when the repo path is missing', async () => {
    const workspace = tempDir('purge-missing-selector-workspace')
    const env = {
      HOME: tempDir('purge-missing-selector-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-missing-selector-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-missing-selector-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-missing-selector-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-missing-selector-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-missing-selector-codex-state'), '.codex-global-state.json')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const alias = defaultSshAlias(context.workspaceBasename)

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeWorkspaceMetadata(context, alias)
    rmSync(workspace, { recursive: true, force: true })

    await withFakeDocker([], async (_logPath, dockerEnv) => {
      const result = runCliProcess(['purge', '--workspace', alias], {
        ...dockerEnv,
        ...env
      })

      assert.strictEqual(result.code, 0)
      assert.strictEqual(existsSync(context.workspaceFolder), false)
      assert.strictEqual(existsSync(context.workspaceCacheDir), false)
      assert.strictEqual(existsSync(context.workspaceDataDir), false)
    })
  })

  test('purge rejects ambiguous repo name selectors', () => {
    const firstParent = tempDir('purge-ambiguous-first-parent')
    const secondParent = tempDir('purge-ambiguous-second-parent')
    const firstWorkspace = join(firstParent, 'same-repo')
    const secondWorkspace = join(secondParent, 'same-repo')
    const env = {
      HOME: tempDir('purge-ambiguous-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-ambiguous-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-ambiguous-data')
    }

    mkdirSync(firstWorkspace)
    mkdirSync(secondWorkspace)
    writeWorkspaceMetadata(
      createWorkspaceContext({ workspace: firstWorkspace, env, assetsDevcontainerDir }),
      'first-same-repo-devcontainer'
    )
    writeWorkspaceMetadata(
      createWorkspaceContext({ workspace: secondWorkspace, env, assetsDevcontainerDir }),
      'second-same-repo-devcontainer'
    )

    const result = runCliProcess(['purge', '--workspace', 'same-repo'], env)

    assert.strictEqual(result.code, 1)
    assert.match(result.stderr, /Workspace selector is ambiguous: same-repo/)
    assert.match(result.stderr, /first-same-repo-devcontainer/)
    assert.match(result.stderr, /second-same-repo-devcontainer/)
  })

  test('purge from a tracked cwd keeps single-workspace confirmation', async () => {
    const workspace = tempDir('purge-tracked-cwd-workspace')
    const env = {
      HOME: tempDir('purge-tracked-cwd-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-tracked-cwd-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-tracked-cwd-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-tracked-cwd-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-tracked-cwd-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-tracked-cwd-codex-state'), '.codex-global-state.json')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const { input, output, outputText } = fakePromptStreams()

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      { workspace, id: 'purge-tracked-cwd-container' }
    ], async (logPath, dockerEnv) => {
      const codePromise = withProcessEnv({
        ...dockerEnv,
        ...env
      }, async () => withCwd(workspace, async () => runCli(['purge'], {
        promptInput: input,
        promptOutput: output,
        env: { ...process.env, CI: 'false' }
      })))

      await waitForPromptOutput(outputText, /Purge Boxdown workspace\?/)
      input.write('\u001B[C')
      input.write('\r')

      const code = await codePromise
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(code, 0)
      assert.doesNotMatch(outputText(), /Purge Boxdown workspaces\?/)
      assert.ok(calls.includes('rm -f -v purge-tracked-cwd-container'))
      assert.strictEqual(existsSync(context.workspaceCacheDir), false)
      assert.strictEqual(existsSync(context.workspaceDataDir), false)
    })
  })

  test('prompts for purge workspaces from an untracked cwd including missing entries', async () => {
    const root = tempDir('purge-batch-root')
    const alpha = join(root, 'alpha')
    const beta = join(root, 'beta')
    const delta = join(root, 'delta')
    const missing = join(root, 'missing')
    const unknown = tempDir('purge-batch-unknown-cwd')
    const env = {
      HOME: tempDir('purge-batch-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-batch-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-batch-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-batch-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-batch-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-batch-codex-state'), '.codex-global-state.json')
    }

    mkdirSync(alpha)
    mkdirSync(beta)
    mkdirSync(delta)
    mkdirSync(missing)

    const alphaContext = createWorkspaceContext({ workspace: alpha, env, assetsDevcontainerDir })
    const betaContext = createWorkspaceContext({ workspace: beta, env, assetsDevcontainerDir })
    const deltaContext = createWorkspaceContext({ workspace: delta, env, assetsDevcontainerDir })
    const missingContext = createWorkspaceContext({ workspace: missing, env, assetsDevcontainerDir })
    const { input, output, outputText } = fakePromptStreams()

    mkdirSync(alphaContext.workspaceCacheDir, { recursive: true })
    mkdirSync(betaContext.workspaceCacheDir, { recursive: true })
    mkdirSync(deltaContext.workspaceCacheDir, { recursive: true })
    mkdirSync(missingContext.workspaceCacheDir, { recursive: true })
    writeWorkspaceMetadata(alphaContext, defaultSshAlias(alphaContext.workspaceBasename))
    writeWorkspaceMetadata(betaContext, defaultSshAlias(betaContext.workspaceBasename))
    writeWorkspaceMetadata(deltaContext, defaultSshAlias(deltaContext.workspaceBasename))
    writeWorkspaceMetadata(missingContext, defaultSshAlias(missingContext.workspaceBasename))
    rmSync(missing, { recursive: true, force: true })

    await withFakeDocker([
      { workspace: betaContext.workspaceFolder, id: 'purge-batch-beta-container' },
      { workspace: deltaContext.workspaceFolder, id: 'purge-batch-delta-container', containerState: 'exited' }
    ], async (logPath, dockerEnv) => {
      const codePromise = withProcessEnv({
        ...dockerEnv,
        ...env
      }, async () => withCwd(unknown, async () => runCli(['purge'], {
        promptInput: input,
        promptOutput: output,
        env: { ...process.env, CI: 'false' }
      })))

      await waitForPromptOutput(outputText, /Purge Boxdown workspaces\?/)
      assert.match(outputText(), /alpha/)
      assert.match(outputText(), /beta/)
      assert.match(outputText(), /delta/)
      assert.match(outputText(), /missing/)
      assert.ok(outputText().includes(`(absent) ${alphaContext.workspaceFolder}`))
      assert.ok(outputText().includes(`(running) ${betaContext.workspaceFolder}`))
      assert.ok(outputText().includes(`(exited) ${deltaContext.workspaceFolder}`))
      assert.ok(outputText().includes(`(missing) ${missingContext.workspaceFolder}`))
      assert.doesNotMatch(outputText(), /alpha-devcontainer/)
      assert.doesNotMatch(outputText(), /beta-devcontainer/)
      assert.doesNotMatch(outputText(), /delta-devcontainer/)
      assert.doesNotMatch(outputText(), /missing-devcontainer/)

      input.write('\u001B[A')
      await waitForPromptOutput(outputText, /\u001B\[31m\(missing\)\u001B\[0m/)
      assert.ok(outputText().includes(`${color(' - ', 'dim')}${color('(missing)', 'red')}${color(` ${missingContext.workspaceFolder}`, 'dim')}`))
      input.write(' ')
      input.write('\u001B[A')
      await waitForPromptOutput(outputText, /\u001B\[33m\(exited\)\u001B\[0m/)
      assert.ok(outputText().includes(`${color(' - ', 'dim')}${color('(exited)', 'yellow')}${color(` ${deltaContext.workspaceFolder}`, 'dim')}`))
      input.write('\u001B[A')
      await waitForPromptOutput(outputText, /\u001B\[32m\(running\)\u001B\[0m/)
      assert.ok(outputText().includes(`${color(' - ', 'dim')}${color('(running)', 'green')}${color(` ${betaContext.workspaceFolder}`, 'dim')}`))
      input.write(' ')
      input.write('\u001B[A')
      await waitForPromptOutput(outputText, /\u001B\[31m\(absent\)\u001B\[0m/)
      assert.ok(outputText().includes(`${color(' - ', 'dim')}${color('(absent)', 'red')}${color(` ${alphaContext.workspaceFolder}`, 'dim')}`))
      input.write('\r')
      await waitForPromptOutput(outputText, /Purge selected Boxdown workspaces\?/)
      input.write('\u001B[C')
      input.write('\r')

      const code = await codePromise
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(code, 0)
      assert.ok(calls.includes('rm -f -v purge-batch-beta-container'))
      assert.strictEqual(existsSync(alphaContext.workspaceCacheDir), true)
      assert.strictEqual(existsSync(alphaContext.workspaceDataDir), true)
      assert.strictEqual(existsSync(betaContext.workspaceCacheDir), false)
      assert.strictEqual(existsSync(betaContext.workspaceDataDir), false)
      assert.strictEqual(existsSync(deltaContext.workspaceCacheDir), true)
      assert.strictEqual(existsSync(deltaContext.workspaceDataDir), true)
      assert.strictEqual(existsSync(missingContext.workspaceCacheDir), false)
      assert.strictEqual(existsSync(missingContext.workspaceDataDir), false)
    })
  })

  test('colors unknown purge state red when Docker state is unavailable', async () => {
    const workspace = tempDir('purge-batch-unknown-state-workspace')
    const unknown = tempDir('purge-batch-unknown-state-cwd')
    const binDir = tempDir('purge-batch-unknown-state-bin')
    const dockerPath = join(binDir, 'docker')
    const env = {
      HOME: tempDir('purge-batch-unknown-state-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-batch-unknown-state-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-batch-unknown-state-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-batch-unknown-state-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-batch-unknown-state-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-batch-unknown-state-codex-state'), '.codex-global-state.json'),
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const { input, output, outputText } = fakePromptStreams()

    writeFileSync(dockerPath, '#!/usr/bin/env bash\nexit 1\n')
    chmodSync(dockerPath, 0o755)
    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    const codePromise = withProcessEnv(env, async () => withCwd(unknown, async () => runCli(['purge'], {
      promptInput: input,
      promptOutput: output,
      env: { ...process.env, CI: 'false' }
    })))

    await waitForPromptOutput(outputText, /Purge Boxdown workspaces\?/)
    assert.ok(outputText().includes(`(unknown) ${context.workspaceFolder}`))
    input.write('\u001B[A')
    await waitForPromptOutput(outputText, /\u001B\[31m\(unknown\)\u001B\[0m/)
    assert.ok(outputText().includes(`${color(' - ', 'dim')}${color('(unknown)', 'red')}${color(` ${context.workspaceFolder}`, 'dim')}`))
    input.write('\u0003')

    assert.strictEqual(await codePromise, 1)
    assert.strictEqual(existsSync(context.workspaceCacheDir), true)
    assert.strictEqual(existsSync(context.workspaceDataDir), true)
  })

  test('cancels prompted batch purge before selecting workspaces', async () => {
    const workspace = tempDir('purge-batch-select-cancel-workspace')
    const unknown = tempDir('purge-batch-select-cancel-cwd')
    const env = {
      HOME: tempDir('purge-batch-select-cancel-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-batch-select-cancel-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-batch-select-cancel-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-batch-select-cancel-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-batch-select-cancel-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-batch-select-cancel-codex-state'), '.codex-global-state.json')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const { input, output, outputText } = fakePromptStreams()

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      { workspace, id: 'purge-batch-select-cancel-container' }
    ], async (logPath, dockerEnv) => {
      const codePromise = withProcessEnv({
        ...dockerEnv,
        ...env
      }, async () => withCwd(unknown, async () => runCli(['purge'], {
        promptInput: input,
        promptOutput: output,
        env: { ...process.env, CI: 'false' }
      })))

      await waitForPromptOutput(outputText, /Purge Boxdown workspaces\?/)
      input.write('\r')

      const code = await codePromise
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(code, 1)
      assert.ok(!calls.some((line) => line.startsWith('rm -f')))
      assert.strictEqual(existsSync(context.workspaceCacheDir), true)
      assert.strictEqual(existsSync(context.workspaceDataDir), true)
    })
  })

  test('cancels prompted batch purge at confirmation', async () => {
    const workspace = tempDir('purge-batch-confirm-cancel-workspace')
    const unknown = tempDir('purge-batch-confirm-cancel-cwd')
    const env = {
      HOME: tempDir('purge-batch-confirm-cancel-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-batch-confirm-cancel-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-batch-confirm-cancel-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-batch-confirm-cancel-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-batch-confirm-cancel-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-batch-confirm-cancel-codex-state'), '.codex-global-state.json')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const { input, output, outputText } = fakePromptStreams()

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      { workspace, id: 'purge-batch-confirm-cancel-container' }
    ], async (logPath, dockerEnv) => {
      const codePromise = withProcessEnv({
        ...dockerEnv,
        ...env
      }, async () => withCwd(unknown, async () => runCli(['purge'], {
        promptInput: input,
        promptOutput: output,
        env: { ...process.env, CI: 'false' }
      })))

      await waitForPromptOutput(outputText, /Purge Boxdown workspaces\?/)
      input.write('\u001B[A')
      input.write(' ')
      input.write('\r')
      await waitForPromptOutput(outputText, /Purge selected Boxdown workspaces\?/)
      input.write('\r')

      const code = await codePromise
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(code, 1)
      assert.ok(!calls.some((line) => line.startsWith('rm -f')))
      assert.strictEqual(existsSync(context.workspaceCacheDir), true)
      assert.strictEqual(existsSync(context.workspaceDataDir), true)
    })
  })

  test('batch purge continues after one selected workspace fails', async () => {
    const root = tempDir('purge-batch-failure-root')
    const alpha = join(root, 'alpha')
    const beta = join(root, 'beta')
    const unknown = tempDir('purge-batch-failure-cwd')
    const env = {
      HOME: tempDir('purge-batch-failure-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-batch-failure-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-batch-failure-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-batch-failure-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-batch-failure-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-batch-failure-codex-state'), '.codex-global-state.json')
    }

    mkdirSync(alpha)
    mkdirSync(beta)

    const alphaContext = createWorkspaceContext({ workspace: alpha, env, assetsDevcontainerDir })
    const betaContext = createWorkspaceContext({ workspace: beta, env, assetsDevcontainerDir })
    const { input, output, outputText } = fakePromptStreams()

    mkdirSync(alphaContext.workspaceCacheDir, { recursive: true })
    mkdirSync(betaContext.workspaceCacheDir, { recursive: true })
    writeWorkspaceMetadata(alphaContext, defaultSshAlias(alphaContext.workspaceBasename))
    writeWorkspaceMetadata(betaContext, defaultSshAlias(betaContext.workspaceBasename))

    await withFakeDocker([
      { workspace: alpha, id: 'purge-batch-alpha-container', removeExitCode: 37 },
      { workspace: beta, id: 'purge-batch-beta-container' }
    ], async (logPath, dockerEnv) => {
      const codePromise = withProcessEnv({
        ...dockerEnv,
        ...env
      }, async () => withCwd(unknown, async () => runCli(['purge'], {
        promptInput: input,
        promptOutput: output,
        env: { ...process.env, CI: 'false' }
      })))

      await waitForPromptOutput(outputText, /Purge Boxdown workspaces\?/)
      input.write('\u001B[A')
      input.write(' ')
      input.write('\u001B[A')
      input.write(' ')
      input.write('\r')
      await waitForPromptOutput(outputText, /Purge selected Boxdown workspaces\?/)
      input.write('\u001B[C')
      input.write('\r')

      const code = await codePromise
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(code, 1)
      assert.ok(calls.includes('rm -f -v purge-batch-alpha-container'))
      assert.ok(calls.includes('rm -f -v purge-batch-beta-container'))
      assert.strictEqual(existsSync(alphaContext.workspaceCacheDir), false)
      assert.strictEqual(existsSync(alphaContext.workspaceDataDir), false)
      assert.strictEqual(existsSync(betaContext.workspaceCacheDir), false)
      assert.strictEqual(existsSync(betaContext.workspaceDataDir), false)
    })
  })

  test('non-interactive purge from an untracked cwd fails safely', async () => {
    const workspace = tempDir('purge-noninteractive-known-workspace')
    const unknown = tempDir('purge-noninteractive-unknown-cwd')
    const env = {
      HOME: tempDir('purge-noninteractive-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-noninteractive-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-noninteractive-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-noninteractive-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-noninteractive-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-noninteractive-codex-state'), '.codex-global-state.json')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      { workspace, id: 'purge-noninteractive-container' }
    ], async (logPath, dockerEnv) => {
      let code = 1

      await withProcessEnv({
        ...dockerEnv,
        ...env
      }, async () => {
        code = await withCwd(unknown, async () => runCli(['purge'], {
          env: { ...process.env, CI: 'true' }
        }))
      })
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(code, 1)
      assert.deepStrictEqual(calls, [])
      assert.strictEqual(existsSync(context.workspaceCacheDir), true)
      assert.strictEqual(existsSync(context.workspaceDataDir), true)
    })
  })

  test('purge continues after Docker cleanup failures and exits nonzero', async () => {
    const workspace = tempDir('purge-failure-workspace')
    const env = {
      HOME: tempDir('purge-failure-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-failure-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-failure-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-failure-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-failure-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-failure-codex-state'), '.codex-global-state.json')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      {
        workspace,
        id: 'failing-container',
        imageId: 'sha256:failing-image',
        removeExitCode: 37,
        imageRemoveExitCode: 41
      }
    ], async (logPath, dockerEnv) => {
      const result = runCliProcess(['purge', '--workspace', workspace], {
        ...dockerEnv,
        ...env
      })
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(result.code, 1)
      assert.ok(calls.includes('rm -f -v failing-container'))
      assert.ok(calls.includes('image rm -f sha256:failing-image'))
      assert.match(result.stderr, /Failed devcontainer failing-container/)
      assert.match(result.stderr, /Failed Docker image sha256:failing-image/)
      assert.strictEqual(existsSync(context.workspaceCacheDir), false)
      assert.strictEqual(existsSync(context.workspaceDataDir), false)
    })
  })

  test('cancels interactive purge before Docker or state removal', async () => {
    const workspace = tempDir('purge-prompt-cancel-workspace')
    const env = {
      HOME: tempDir('purge-prompt-cancel-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-prompt-cancel-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-prompt-cancel-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-prompt-cancel-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-prompt-cancel-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-prompt-cancel-codex-state'), '.codex-global-state.json')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const { input, output } = fakePromptStreams()

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      { workspace, id: 'purge-prompt-cancel-container' }
    ], async (logPath, dockerEnv) => {
      const codePromise = withProcessEnv({
        ...dockerEnv,
        ...env
      }, async () => runCli(['purge', '--workspace', workspace], {
        promptInput: input,
        promptOutput: output,
        env: { ...process.env, CI: 'false' }
      }))

      input.write('\r')

      const code = await codePromise
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(code, 1)
      assert.deepStrictEqual(calls, [])
      assert.strictEqual(existsSync(context.workspaceCacheDir), true)
      assert.strictEqual(existsSync(context.workspaceDataDir), true)
      assert.strictEqual(existsSync(context.workspaceLogPath), false)
    })
  })

  test('confirmed interactive purge runs the existing purge flow', async () => {
    const workspace = tempDir('purge-prompt-confirm-workspace')
    const env = {
      HOME: tempDir('purge-prompt-confirm-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-prompt-confirm-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-prompt-confirm-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-prompt-confirm-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: join(tempDir('purge-prompt-confirm-codex-app'), 'config.json'),
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('purge-prompt-confirm-codex-state'), '.codex-global-state.json')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const { input, output } = fakePromptStreams()

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      {
        workspace,
        id: 'purge-prompt-confirm-container',
        imageId: 'sha256:purge-prompt-confirm-image'
      }
    ], async (logPath, dockerEnv) => {
      const codePromise = withProcessEnv({
        ...dockerEnv,
        ...env
      }, async () => runCli(['purge', '--workspace', workspace], {
        promptInput: input,
        promptOutput: output,
        env: { ...process.env, CI: 'false' }
      }))

      input.write('\u001B[C')
      input.write('\r')

      const code = await codePromise
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(code, 0)
      assert.ok(calls.includes('rm -f -v purge-prompt-confirm-container'))
      assert.ok(calls.includes('image rm -f sha256:purge-prompt-confirm-image'))
      assert.strictEqual(existsSync(context.workspaceCacheDir), false)
      assert.strictEqual(existsSync(context.workspaceDataDir), false)
      assert.strictEqual(existsSync(context.workspaceLogPath), false)
    })
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
    const commandScript = args.join('\n')
    assert.match(commandScript, /codex_home="\$\{CODEX_HOME:-\$\{HOME\}\/\.codex\}"/)
    assert.match(commandScript, /export PATH="\$\{HOME\}\/\.local\/bin:\$\{HOME\}\/\.opencode\/bin:\$\{codex_home\}\/packages\/standalone\/current\/bin:\$\{PATH\}"/)
    assert.match(commandScript, /exec "\$@"/)
    assert.deepStrictEqual(args.slice(-3), ['boxdown-agent', 'agy', '--help'])
  })
})

describe('host tool path', () => {
  test('adds GUI-missing Docker and Homebrew paths while preserving existing priority', () => {
    const home = tempDir('host-tool-path-home')
    const customBin = join(tempDir('host-tool-path-custom'), 'bin')
    const path = buildHostToolPath({
      HOME: home,
      PATH: `/usr/bin${delimiter}/bin${delimiter}/usr/sbin${delimiter}/sbin`,
      BOXDOWN_HOST_PATH_PREFIX: customBin
    }).split(delimiter)

    assert.strictEqual(path[0], customBin)
    assert.ok(path.indexOf('/usr/bin') < path.indexOf('/usr/local/bin'))
    assert.ok(path.includes(`${home}/.docker/bin`))
    assert.ok(path.includes('/Applications/Docker.app/Contents/Resources/bin'))
    assert.strictEqual(path.filter((entry) => entry === '/usr/bin').length, 1)
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

  test('records and preserves workspace Docker image metadata', () => {
    const workspace = tempDir('metadata-image-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('metadata-image-cache'),
        BOXDOWN_DATA_HOME: tempDir('metadata-image-data')
      },
      assetsDevcontainerDir
    })

    writeWorkspaceMetadata(context, 'demo-devcontainer', new Date('2026-01-01T00:00:00.000Z'))
    const imageMetadata = recordWorkspaceDockerImage(context, {
      id: 'sha256:demo-image',
      name: 'boxdown-demo:latest'
    }, new Date('2026-01-01T00:01:00.000Z'))
    const laterMetadata = writeWorkspaceMetadata(context, 'updated-devcontainer', new Date('2026-01-02T00:00:00.000Z'))

    assert.strictEqual(imageMetadata?.dockerImageId, 'sha256:demo-image')
    assert.strictEqual(imageMetadata?.dockerImageName, 'boxdown-demo:latest')
    assert.strictEqual(imageMetadata?.dockerImageLastSeenAt, '2026-01-01T00:01:00.000Z')
    assert.strictEqual(laterMetadata.dockerImageId, 'sha256:demo-image')
    assert.deepStrictEqual(readWorkspaceMetadata(context), laterMetadata)
  })

  test('status does not record workspace metadata', () => {
    assert.strictEqual(commandWritesWorkspaceMetadata('status'), false)
    assert.strictEqual(commandWritesWorkspaceMetadata('list'), false)
    assert.strictEqual(commandWritesWorkspaceMetadata('purge'), false)
    assert.strictEqual(commandWritesWorkspaceMetadata('setup'), true)
    assert.strictEqual(commandWritesWorkspaceMetadata('start'), true)
    assert.strictEqual(commandWritesWorkspaceMetadata('ssh-install'), true)
    assert.strictEqual(commandWritesWorkspaceMetadata('ssh-uninstall'), false)
    assert.strictEqual(commandWritesWorkspaceMetadata('ssh-proxy'), true)
    assert.strictEqual(commandWritesWorkspaceMetadata('tunnel'), true)
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
    assert.strictEqual(context.workspaceLogPath, join(context.workspaceDataDir, 'boxdown.log'))
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
      context.workspaceLogPath,
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
    assert.strictEqual(running.paths.logPath, context.workspaceLogPath)
    assert.strictEqual(running.paths.logExists, true)
    assert.strictEqual(absent.ssh.managedBlockState, 'missing')
    assert.strictEqual(absent.paths.logExists, false)
    assert.match(formatStatusText(running), /SSH alias: demo-devcontainer \(computed default; installed\)/)
    assert.match(formatStatusText(stopped), /SSH alias: demo-devcontainer \(provided; installed\)/)
    assert.match(formatStatusText(running), /State: running/)
    assert.match(formatStatusText(stopped), /State: exited/)
    assert.match(formatStatusText(running), /Generated config: .* \(exists\)/)
    assert.match(formatStatusText(running), /Command log: .*boxdown\.log \(exists\)/)
    assert.match(formatStatusText(absent), /Generated config: .* \(missing\)/)
    assert.match(formatStatusText(absent), /Command log: .*boxdown\.log \(missing\)/)
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
    assert.strictEqual(formatWorkspaceListDetailsText([]), 'Boxdown list\n\nNo Boxdown workspaces found.\n')
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
    const output = formatWorkspaceListText(entries)
    assert.match(output, /STATE\s+REPO\s+PATH\s+CONTAINER/)
    assert.doesNotMatch(output, /SSH ALIAS/)
    assert.doesNotMatch(output, /alpha-devcontainer/)
    assert.match(output, /running\s+alpha/)
    assert.match(output, /missing\s+beta/)
  })

  test('formats detailed list output with copyable values', () => {
    const alphaWorkspace = tempDir('alpha-details-workspace')
    const entries = createWorkspaceListEntries([
      {
        version: 1,
        workspaceId: 'alpha-details-id',
        workspaceFolder: alphaWorkspace,
        workspaceBasename: 'alpha-details',
        sshAlias: 'alpha-details-devcontainer',
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-02T00:00:00.000Z'
      }
    ], [
      {
        id: 'abc123',
        name: 'alpha-details-container',
        state: 'running',
        status: 'Up 2 minutes',
        localFolder: alphaWorkspace
      }
    ], (path) => path === alphaWorkspace)

    assert.strictEqual(formatWorkspaceListDetailsText(entries), [
      'Boxdown list',
      '',
      'running  alpha-details',
      `  path     : ${alphaWorkspace}`,
      '  ssh alias: alpha-details-devcontainer',
      '  container: alpha-details-container',
      ''
    ].join('\n'))
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
  test('runs required checks without optional diagnostics when requested', async () => {
    const workspace = tempDir('doctor-required-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('doctor-required-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-required-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []

    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      includeDockerMountProbe: false,
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        return command === 'ssh-add'
          ? { code: 0, stdout: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest doctor\n', stderr: '' }
          : command === 'gh' && args.includes('user/ssh_signing_keys')
            ? { code: 0, stdout: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest\n', stderr: '' }
            : command === 'gh' && args.includes('user')
              ? { code: 0, stdout: 'example\n', stderr: '' }
              : command === 'gh' && args.includes('users/example/ssh_signing_keys')
                ? { code: 0, stdout: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest\n', stderr: '' }
          : { code: 0, stdout: '', stderr: '' }
      }
    })

    assert.ok(checks.every((item) => item.name !== 'gh' && item.name !== 'gh-auth'))
    assert.ok(calls.every((call) => !call.startsWith('gh ')))
    assert.ok(checks.some((item) => item.name === 'git-signing-agent'))
    assert.ok(checks.every((item) => item.level === 'ok'))
  })

  test('reports a Docker bind-mount failure and removes successful disposable probes', async () => {
    const workspace = tempDir('doctor-mount-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('doctor-mount-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-mount-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []
    const probeSources: string[] = []

    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'docker' && args[0] === 'image') {
          return { code: 0, stdout: 'example:latest\n', stderr: '' }
        }

        if (command === 'docker' && args[0] === 'create') {
          const mount = args.find((arg) => arg.startsWith('type=bind,')) ?? ''
          probeSources.push(mount)
          if (mount.includes(`source=${context.assetsDevcontainerDir},`)) {
            return { code: 1, stdout: '', stderr: 'invalid mount config for type "bind": bind source path does not exist' }
          }
          return { code: 0, stdout: `probe-${probeSources.length}\n`, stderr: '' }
        }

        return { code: 0, stdout: '', stderr: '' }
      }
    })

    const mountCheck = checks.find((item) => item.name === 'docker-bind-mounts')
    assert.deepStrictEqual(mountCheck?.level, 'fail')
    assert.match(mountCheck?.message ?? '', /Boxdown devcontainer assets/)
    assert.ok(calls.includes('docker rm -f probe-1'))
    assert.ok(probeSources.some((source) => source.includes(`source=${context.workspaceFolder},`)))
    assert.ok(probeSources.some((source) => source.includes(`source=${context.assetsDevcontainerDir},`)))
    assert.strictEqual(existsSync(context.sshKeyPath), false)
    assert.strictEqual(existsSync(context.workspaceDataDir), true)
  })

  test('removes every successful Docker mount probe and its temporary runtime path', async () => {
    const workspace = tempDir('doctor-mount-cleanup-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('doctor-mount-cleanup-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-mount-cleanup-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []
    const probeSources: string[] = []

    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'docker' && args[0] === 'image') {
          return { code: 0, stdout: 'example:latest\n', stderr: '' }
        }
        if (command === 'docker' && args[0] === 'create') {
          probeSources.push(args.find((arg) => arg.startsWith('type=bind,')) ?? '')
          return { code: 0, stdout: `probe-${probeSources.length}\n`, stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      }
    })

    assert.strictEqual(checks.find((item) => item.name === 'docker-bind-mounts')?.level, 'ok')
    assert.deepStrictEqual(calls.filter((call) => call.startsWith('docker rm -f ')), [
      'docker rm -f probe-1',
      'docker rm -f probe-2',
      'docker rm -f probe-3'
    ])
    const runtimeProbeSource = probeSources[2]?.match(/source=([^,]+)/)?.[1]
    assert.ok(runtimeProbeSource !== undefined)
    assert.strictEqual(existsSync(runtimeProbeSource ?? ''), false)
  })

  test('warns when Docker bind-mount readiness cannot be probed without a local image', async () => {
    const workspace = tempDir('doctor-mount-unavailable-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('doctor-mount-unavailable-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-mount-unavailable-data')
      },
      assetsDevcontainerDir
    })

    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      runCommand: async (command, args) => {
        if (command === 'docker' && args[0] === 'image') {
          return { code: 0, stdout: '', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      }
    })

    assert.deepStrictEqual(checks.find((item) => item.name === 'docker-bind-mounts'), {
      name: 'docker-bind-mounts',
      level: 'warn',
      message: 'Docker bind-mount readiness was not checked because no local Docker image is available'
    })
    assert.strictEqual(existsSync(context.workspaceDataDir), false)
  })

  test('doctor selects a configured public-key path from multiple agent identities', async () => {
    const workspace = tempDir('doctor-configured-signing-workspace')
    const home = tempDir('doctor-configured-signing-home')
    const signingKeyPath = join(home, 'signing.pub')
    const first = 'ssh-ed25519 AAAAC3NzaDoctorFirst first'
    const second = 'ssh-ed25519 AAAAC3NzaDoctorSecond second'
    writeFileSync(signingKeyPath, `${second}\n`)
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: home,
        BOXDOWN_CACHE_HOME: tempDir('doctor-configured-signing-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-configured-signing-data')
      },
      assetsDevcontainerDir
    })

    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      includeDockerMountProbe: false,
      runCommand: async (command, args) => {
        if (command === 'ssh-add') return { code: 0, stdout: `${first}\n${second}\n`, stderr: '' }
        if (command === 'git' && args.includes('gpg.format')) return { code: 0, stdout: 'ssh\n', stderr: '' }
        if (command === 'git' && args.includes('user.signingkey')) return { code: 0, stdout: `${signingKeyPath}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      }
    })

    assert.deepStrictEqual(checks.find((item) => item.name === 'git-signing-agent'), {
      name: 'git-signing-agent',
      level: 'ok',
      message: 'Configured SSH signing key is loaded in the agent'
    })
  })

  test('doctor uses GitHub matching for multiple identities and verifies the selected signing key', async () => {
    const workspace = tempDir('doctor-github-signing-workspace')
    const first = 'ssh-ed25519 AAAAC3NzaDoctorGithubFirst first'
    const second = 'ssh-ed25519 AAAAC3NzaDoctorGithubSecond second'
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('doctor-github-signing-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-github-signing-data')
      },
      assetsDevcontainerDir
    })

    const checks = await runDoctorChecks(context, {
      includeDockerMountProbe: false,
      runCommand: async (command, args) => {
        if (command === 'ssh-add') return { code: 0, stdout: `${first}\n${second}\n`, stderr: '' }
        if (command === 'git') return { code: 1, stdout: '', stderr: '' }
        if (command === 'gh' && args[0] === '--version') return { code: 0, stdout: 'gh version test\n', stderr: '' }
        if (command === 'gh' && args[0] === 'auth') return { code: 0, stdout: '', stderr: '' }
        if (command === 'gh' && args.includes('users/example/keys')) return { code: 0, stdout: `${second}\n`, stderr: '' }
        if (command === 'gh' && args.includes('users/example/ssh_signing_keys')) return { code: 0, stdout: `${second}\n`, stderr: '' }
        if (command === 'gh' && args.includes('user')) return { code: 0, stdout: 'example\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      }
    })

    assert.strictEqual(checks.find((item) => item.name === 'git-signing-agent')?.level, 'ok')
    assert.deepStrictEqual(checks.find((item) => item.name === 'git-signing-github'), {
      name: 'git-signing-github',
      level: 'ok',
      message: 'Selected SSH key is registered with GitHub for commit signing'
    })
  })

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

describe('progress output', () => {
  test('workspace logger appends sections and Boxdown output', async () => {
    const workspace = tempDir('logger-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('logger-cache'),
        BOXDOWN_DATA_HOME: tempDir('logger-data')
      },
      assetsDevcontainerDir
    })
    const logger = createWorkspaceCommandLogger(context, {
      now: () => new Date('2026-01-01T00:00:00.000Z')
    })

    logger.section('first command', { command: 'setup' })
    logger.section('second command', { command: 'start' })
    await withLoggedProcessOutput(logger, async () => {
      process.stdout.write('visible message\n')
    })

    const log = readFileSync(context.workspaceLogPath, 'utf8')

    assert.match(log, /2026-01-01T00:00:00\.000Z.*=== first command ===/)
    assert.match(log, /command: setup/)
    assert.match(log, /=== second command ===/)
    assert.match(log, /\[boxdown\] visible message/)
  })

  test('buffered commands log hidden stdout and stderr', async () => {
    const workspace = tempDir('logger-buffered-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('logger-buffered-cache'),
        BOXDOWN_DATA_HOME: tempDir('logger-buffered-data')
      },
      assetsDevcontainerDir
    })
    const logger = createWorkspaceCommandLogger(context)
    const result = await runBuffered('bash', [
      '-c',
      'printf "hidden stdout\\n"; printf "hidden stderr\\n" >&2'
    ], {
      logger,
      mirrorStdout: false,
      mirrorStderr: false
    })
    const log = readFileSync(context.workspaceLogPath, 'utf8')

    assert.strictEqual(result.code, 0)
    assert.match(log, /command start: \["bash","-c",/)
    assert.match(log, /\[stdout\] hidden stdout/)
    assert.match(log, /\[stderr\] hidden stderr/)
    assert.match(log, /command exit: 0/)
  })

  test('resolves progress modes from terminal and output context', () => {
    assert.strictEqual(resolveProgressMode({ isTTY: true, env: { CI: 'false' } }), 'interactive')
    assert.strictEqual(resolveProgressMode({ target: 'stderr', isTTY: true, env: { CI: 'false' } }), 'interactive')
    assert.strictEqual(resolveProgressMode({ isTTY: true, verbose: true, env: { CI: 'false' } }), 'verbose')
    assert.strictEqual(resolveProgressMode({ isTTY: true, env: { CI: 'true' } }), 'verbose')
    assert.strictEqual(resolveProgressMode({ isTTY: true, env: { CI: '1' } }), 'verbose')
    assert.strictEqual(resolveProgressMode({ isTTY: false, env: { CI: 'false' } }), 'verbose')
    assert.strictEqual(resolveProgressMode({ json: true, isTTY: true, env: { CI: 'false' } }), 'none')
  })

  test('none progress mode keeps output fully silent for JSON callers', () => {
    const lines: string[] = []
    const raw: string[] = []
    const progress = createProgress({
      mode: 'none',
      write: (target, message) => {
        lines.push(`${target}:${message}`)
      },
      writeRaw: (target, message) => {
        raw.push(`${target}:${message}`)
      }
    })

    progress.section('Boxdown status')
    progress.detail('Workspace: /tmp/demo')
    progress.warn('This should stay hidden')
    progress.setSteps([{ id: 'demo', label: 'Demo step' }])
    progress.startStep('demo')
    progress.completeStep('demo')
    progress.end()

    assert.deepStrictEqual(lines, [])
    assert.deepStrictEqual(raw, [])
    assert.deepStrictEqual({
      BOXDOWN_VERBOSE: progress.commandEnv().BOXDOWN_VERBOSE,
      BOXDOWN_PROGRESS: progress.commandEnv().BOXDOWN_PROGRESS
    }, {
      BOXDOWN_VERBOSE: '0',
      BOXDOWN_PROGRESS: '0'
    })
  })

  test('reports whether a checklist is active', () => {
    const progress = createProgress({
      mode: 'none'
    })

    assert.strictEqual(progress.isChecklistActive(), false)
    progress.setSteps([{ id: 'demo', label: 'Demo step' }])
    assert.strictEqual(progress.isChecklistActive(), true)
    progress.end()
    assert.strictEqual(progress.isChecklistActive(), false)
  })

  test('keeps first-time SSH identity output within an active checklist', async () => {
    const workspace = tempDir('progress-ssh-identity-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('progress-ssh-identity-cache'),
        BOXDOWN_DATA_HOME: tempDir('progress-ssh-identity-data')
      },
      assetsDevcontainerDir
    })
    const lines: string[] = []
    const raw: string[] = []
    const stderr: string[] = []
    const progress = createProgress({
      isTTY: true,
      spinnerIntervalMs: 60_000,
      write: (target, message) => {
        lines.push(`${target}:${message}`)
      },
      writeRaw: (target, message) => {
        raw.push(`${target}:${message}`)
      }
    })
    const originalStderrWrite = process.stderr.write

    progress.section('Boxdown setup')
    progress.setSteps([{ id: 'ssh-identity', label: 'Preparing SSH identity' }])
    progress.startStep('ssh-identity')
    process.stderr.write = function capturedStderrWrite (this: typeof process.stderr, chunk: string | Uint8Array): boolean {
      stderr.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
      return true
    } as typeof process.stderr.write

    try {
      await ensureHostSshKey(context, { progress })
      progress.completeStep('ssh-identity')
    } finally {
      process.stderr.write = originalStderrWrite
      progress.end()
    }

    assert.deepStrictEqual(stderr, [])
    assert.ok(existsSync(context.sshKeyPath))
    assert.ok(existsSync(context.sshPublicKeyPath))
    assert.deepStrictEqual(lines, [
      `stdout:${formatPromptTitle('Boxdown setup')}`,
      `stdout:${formatPromptEnd()}`
    ])
    assert.ok(!raw.join('').includes('Generating Boxdown SSH identity'))
    assert.ok(!raw.join('').includes('Writing Boxdown SSH public key'))
    assert.deepStrictEqual(raw
      .filter((entry) => entry.includes('Preparing SSH identity'))
      .map((entry) => {
        if (entry.includes(color('□', 'dim'))) {
          return 'pending'
        }

        if (entry.includes(color('◒', 'cyan'))) {
          return 'running'
        }

        if (entry.includes(color('✔', 'green'))) {
          return 'complete'
        }

        return 'unexpected'
      }), [
      'pending',
      'running',
      'complete'
    ])
  })

  test('verbose progress mode suppresses styled progress but keeps warnings visible', () => {
    const lines: string[] = []
    const progress = createProgress({
      mode: 'verbose',
      write: (target, message) => {
        lines.push(`${target}:${message}`)
      }
    })

    progress.section('Boxdown setup')
    progress.detail('Workspace: /tmp/demo')
    progress.item('Starting devcontainer')
    progress.warn('Could not refresh one or more coding-agent CLIs inside the devcontainer.')
    progress.end()

    assert.deepStrictEqual(lines, [
      'stdout:Warning: Could not refresh one or more coding-agent CLIs inside the devcontainer.'
    ])
    assert.deepStrictEqual({
      BOXDOWN_VERBOSE: progress.commandEnv().BOXDOWN_VERBOSE,
      BOXDOWN_PROGRESS: progress.commandEnv().BOXDOWN_PROGRESS
    }, {
      BOXDOWN_VERBOSE: '1',
      BOXDOWN_PROGRESS: '0'
    })
  })

  test('formats styled progress sections', () => {
    const lines: string[] = []
    const progress = createProgress({
      write: (target, message) => {
        lines.push(`${target}:${message}`)
      }
    })

    progress.section('Boxdown setup')
    progress.detail('Workspace: /tmp/demo')
    progress.item('Starting devcontainer')
    progress.warn('Could not refresh one or more coding-agent CLIs inside the devcontainer.')
    progress.end()

    assert.deepStrictEqual(lines, [
      `stdout:${formatPromptTitle('Boxdown setup')}`,
      `stdout:${promptRail()}  ${color('Workspace: /tmp/demo', 'dim')}`,
      `stdout:${promptRail()}  ${selectedMark()} Starting devcontainer`,
      `stdout:${promptRail()}  ${color('!', 'dim')} Could not refresh one or more coding-agent CLIs inside the devcontainer.`,
      `stdout:${formatPromptEnd()}`
    ])
  })

  test('renders live checklist state in place on a TTY', () => {
    const lines: string[] = []
    const raw: string[] = []
    const progress = createProgress({
      isTTY: true,
      spinnerFrames: ['◒', '◐'],
      spinnerIntervalMs: 60_000,
      write: (target, message) => {
        lines.push(`${target}:${message}`)
      },
      writeRaw: (target, message) => {
        raw.push(`${target}:${message}`)
      }
    })

    progress.section('Boxdown setup')
    progress.setSteps([
      { id: 'config', label: 'Writing generated devcontainer config' },
      { id: 'start', label: 'Starting devcontainer' },
      { id: 'install', label: 'Installing SSH alias' }
    ])
    progress.completeStep('config')
    progress.startStep('start')
    progress.tickSpinner()
    progress.completeStep('start')
    progress.failStep('install')
    progress.skipStep('install')
    progress.end()

    assert.deepStrictEqual(lines, [
      `stdout:${formatPromptTitle('Boxdown setup')}`,
      `stdout:${formatPromptEnd()}`
    ])

    const rendered = raw.join('')
    assert.ok(rendered.includes(`${color('□', 'dim')} Writing generated devcontainer config`))
    assert.ok(rendered.includes(`${color('✔', 'green')} Writing generated devcontainer config`))
    assert.ok(rendered.includes(`${color('◒', 'cyan')} Starting devcontainer`))
    assert.ok(rendered.includes(`${color('◐', 'cyan')} Starting devcontainer`))
    assert.ok(rendered.includes(`${color('✔', 'green')} Starting devcontainer`))
    assert.ok(rendered.includes(`${color('!', 'dim')} Installing SSH alias`))
    assert.ok(rendered.includes(`${color('□', 'dim')} ${color('Installing SSH alias', 'dim')}`))
    assert.match(rendered, /\u001B\[3A/)
  })

  test('captures raw command output while surfacing progress markers', async () => {
    const lines: string[] = []
    const progress = createProgress({
      write: (target, message) => {
        lines.push(`${target}:${message}`)
      }
    })
    const result = await runProgressCommand('demo command', 'bash', [
      '-c',
      [
        'printf "hidden stdout\\n"',
        'printf "BOXDOWN_PROGRESS: installing packages\\n"',
        'printf "hidden stderr\\n" >&2',
        'printf "BOXDOWN_PROGRESS: configuring runtime\\n" >&2',
        'printf "%s/%s\\n" "$BOXDOWN_PROGRESS" "$BOXDOWN_VERBOSE"'
      ].join('; ')
    ], { progress })

    assert.strictEqual(result.code, 0)
    assert.match(result.stdout, /hidden stdout/)
    assert.match(result.stderr, /hidden stderr/)
    assert.match(result.stdout, /1\/0/)
    assert.ok(lines.includes(`stdout:${promptRail()}  ${selectedMark()} installing packages`))
    assert.ok(lines.includes(`stdout:${promptRail()}  ${selectedMark()} configuring runtime`))
  })

  test('renders deterministic TTY spinner frames without timing', () => {
    const lines: string[] = []
    const raw: string[] = []
    const progress = createProgress({
      isTTY: true,
      spinnerFrames: ['◒', '◐'],
      spinnerIntervalMs: 60_000,
      write: (target, message) => {
        lines.push(`${target}:${message}`)
      },
      writeRaw: (target, message) => {
        raw.push(`${target}:${message}`)
      }
    })

    progress.startSpinner('Starting devcontainer')
    progress.tickSpinner()
    progress.item('Installing packages')
    progress.stopSpinner('complete')

    assert.deepStrictEqual(lines, [
      `stdout:${promptRail()}  ${selectedMark()} Installing packages`,
      `stdout:${promptRail()}  ${selectedMark()} Starting devcontainer`
    ])
    assert.deepStrictEqual(raw, [
      `stdout:\r\u001B[2K${promptRail()}  ${color('◒', 'cyan')} Starting devcontainer`,
      `stdout:\r\u001B[2K${promptRail()}  ${color('◐', 'cyan')} Starting devcontainer`,
      'stdout:\r\u001B[2K',
      `stdout:\r\u001B[2K${promptRail()}  ${color('◐', 'cyan')} Starting devcontainer`,
      'stdout:\r\u001B[2K'
    ])
  })

  test('progress commands use static spinner lines without a TTY', async () => {
    const lines: string[] = []
    const progress = createProgress({
      isTTY: false,
      write: (target, message) => {
        lines.push(`${target}:${message}`)
      }
    })
    const result = await runProgressCommand('demo command', 'bash', [
      '-c',
      'printf "done\\n"'
    ], {
      progress,
      spinnerLabel: 'Running demo command'
    })

    assert.strictEqual(result.code, 0)
    assert.match(result.stdout, /done/)
    assert.deepStrictEqual(lines, [
      `stdout:${promptRail()}  ${color('◒', 'cyan')} Running demo command`,
      `stdout:${promptRail()}  ${selectedMark()} Running demo command`
    ])
  })

  test('progress commands complete matching checklist steps', async () => {
    const lines: string[] = []
    const raw: string[] = []
    const progress = createProgress({
      isTTY: true,
      spinnerFrames: ['◒', '◐'],
      spinnerIntervalMs: 60_000,
      writeRaw: (target, message) => {
        raw.push(`${target}:${message}`)
      },
      write: (target, message) => {
        lines.push(`${target}:${message}`)
      }
    })

    progress.section('Boxdown setup')
    progress.setSteps([{ id: 'demo', label: 'Running demo command' }])
    const result = await runProgressCommand('demo command', 'bash', [
      '-c',
      'printf "done\\n"'
    ], {
      progress,
      spinnerLabel: 'Fallback spinner',
      stepId: 'demo'
    })
    progress.end()

    const rendered = raw.join('')
    assert.strictEqual(result.code, 0)
    assert.deepStrictEqual(lines, [
      `stdout:${formatPromptTitle('Boxdown setup')}`,
      `stdout:${formatPromptEnd()}`
    ])
    assert.match(result.stdout, /done/)
    assert.ok(rendered.includes(`${color('◒', 'cyan')} Running demo command`))
    assert.ok(rendered.includes(`${color('✔', 'green')} Running demo command`))
    assert.ok(!rendered.includes('Fallback spinner'))
  })

  test('progress commands fail matching checklist steps and keep failure tails concise', async () => {
    const lines: string[] = []
    const raw: string[] = []
    const progress = createProgress({
      isTTY: true,
      spinnerFrames: ['◒', '◐'],
      spinnerIntervalMs: 60_000,
      write: (target, message) => {
        lines.push(`${target}:${message}`)
      },
      writeRaw: (target, message) => {
        raw.push(`${target}:${message}`)
      }
    })

    progress.section('Boxdown setup')
    progress.setSteps([{ id: 'demo', label: 'Running failing command' }])
    const result = await runProgressCommand('demo command', 'bash', [
      '-c',
      [
        'printf "BOXDOWN_PROGRESS: hidden marker\\n"',
        'printf "stdout tail\\n"',
        'printf "stderr tail\\n" >&2',
        'exit 9'
      ].join('; ')
    ], {
      progress,
      stepId: 'demo'
    })
    progress.end()

    const rendered = raw.join('')
    const failure = formatCommandFailure('demo command', result, { tailLines: 5 })
    assert.strictEqual(result.code, 9)
    assert.deepStrictEqual(lines, [
      `stdout:${formatPromptTitle('Boxdown setup')}`,
      `stdout:${formatPromptEnd()}`
    ])
    assert.ok(rendered.includes(`${color('!', 'dim')} Running failing command`))
    assert.match(failure, /demo command failed with exit code 9\./)
    assert.match(failure, /stderr tail/)
    assert.match(failure, /stdout tail/)
    assert.doesNotMatch(failure, /hidden marker/)
  })

  test('hidden command helpers use friendly spinner labels', () => {
    const devcontainerSource = readFileSync(fileURLToPath(new URL('../src/devcontainer.ts', import.meta.url)), 'utf8')
    const sshKeySource = readFileSync(fileURLToPath(new URL('../src/ssh-key.ts', import.meta.url)), 'utf8')

    assert.match(devcontainerSource, /spinnerLabel: 'Starting devcontainer'/)
    assert.match(devcontainerSource, /spinnerLabel: 'Preparing container SSH runtime'/)
    assert.match(devcontainerSource, /spinnerLabel: 'Refreshing GitHub CLI auth inside the devcontainer'/)
    assert.match(devcontainerSource, /spinnerLabel: 'Verifying GitHub CLI auth inside the devcontainer'/)
    assert.strictEqual(devcontainerSource.match(/reportGitSigningPlan\(signingPlan/g)?.length, 2)
    assert.match(sshKeySource, /Generating Boxdown SSH identity/)
    assert.match(sshKeySource, /Writing Boxdown SSH public key/)
  })

  test('verbose progress commands do not emit marker summaries', async () => {
    const lines: string[] = []
    const progress = createProgress({
      verbose: true,
      write: (target, message) => {
        lines.push(`${target}:${message}`)
      }
    })
    const result = await runProgressCommand('demo command', 'bash', [
      '-c',
      'printf "BOXDOWN_PROGRESS: raw marker\\n"; printf "%s/%s\\n" "$BOXDOWN_PROGRESS" "$BOXDOWN_VERBOSE"'
    ], {
      progress,
      spinnerLabel: 'Running verbose demo command',
      verboseStdout: false,
      verboseStderr: false
    })

    assert.strictEqual(result.code, 0)
    assert.match(result.stdout, /BOXDOWN_PROGRESS: raw marker/)
    assert.match(result.stdout, /0\/1/)
    assert.deepStrictEqual(lines, [])
  })

  test('progress commands log raw output while surfacing markers', async () => {
    const workspace = tempDir('logger-progress-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('logger-progress-cache'),
        BOXDOWN_DATA_HOME: tempDir('logger-progress-data')
      },
      assetsDevcontainerDir
    })
    const lines: string[] = []
    const logger = createWorkspaceCommandLogger(context)
    const progress = createProgress({
      write: (target, message) => {
        lines.push(`${target}:${message}`)
      }
    })
    const result = await runProgressCommand('demo command', 'bash', [
      '-c',
      'printf "hidden stdout\\n"; printf "BOXDOWN_PROGRESS: configuring\\n" >&2'
    ], {
      logger,
      progress
    })
    const log = readFileSync(context.workspaceLogPath, 'utf8')

    assert.strictEqual(result.code, 0)
    assert.ok(lines.includes(`stdout:${promptRail()}  ${selectedMark()} configuring`))
    assert.match(log, /\[stdout\] hidden stdout/)
    assert.match(log, /\[stderr\] BOXDOWN_PROGRESS: configuring/)
  })

  test('interactive commands log metadata without capturing inherited bytes', async () => {
    const workspace = tempDir('logger-interactive-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('logger-interactive-cache'),
        BOXDOWN_DATA_HOME: tempDir('logger-interactive-data')
      },
      assetsDevcontainerDir
    })
    const logger = createWorkspaceCommandLogger(context)
    const code = await runInteractive('bash', ['-c', 'printf "%s\\n" "$BOXDOWN_TEST_INTERACTIVE_OUTPUT"'], {
      env: {
        BOXDOWN_TEST_INTERACTIVE_OUTPUT: 'interactive stdout'
      },
      logger
    })
    const log = readFileSync(context.workspaceLogPath, 'utf8')

    assert.strictEqual(code, 0)
    assert.match(log, /command start: \["bash","-c","printf/)
    assert.match(log, /command exit: 0/)
    assert.doesNotMatch(log, /interactive stdout/)
  })

  test('command logging does not record raw stdin and redacts echoed secrets', async () => {
    const workspace = tempDir('logger-secret-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('logger-secret-cache'),
        BOXDOWN_DATA_HOME: tempDir('logger-secret-data')
      },
      assetsDevcontainerDir
    })
    const logger = createWorkspaceCommandLogger(context)

    logger.addRedaction('secret-token')
    const result = await runBuffered('bash', ['-c', 'read token; printf "%s\\n" "$token"'], {
      input: 'secret-token\n',
      logger,
      mirrorStdout: false,
      mirrorStderr: false
    })
    const log = readFileSync(context.workspaceLogPath, 'utf8')

    assert.strictEqual(result.code, 0)
    assert.doesNotMatch(log, /secret-token/)
    assert.match(log, /\[stdout\] \[redacted\]/)
  })

  test('formats concise failure tails without progress marker lines', () => {
    const message = formatCommandFailure('demo command', {
      code: 42,
      stdout: 'stdout one\nBOXDOWN_PROGRESS: hidden marker\nstdout two\n',
      stderr: 'stderr one\nstderr two\n'
    })

    assert.match(message, /demo command failed with exit code 42\./)
    assert.match(message, /Rerun with --verbose/)
    assert.match(message, /stderr tail:/)
    assert.match(message, /stderr two/)
    assert.match(message, /stdout tail:/)
    assert.match(message, /stdout two/)
    assert.doesNotMatch(message, /hidden marker/)
  })
})

describe('devcontainer config generation', () => {
  test('adds an SSH-agent and public-key mount for an enabled signing plan', () => {
    const context = createWorkspaceContext({
      workspace: tempDir('git-signing-config-workspace'),
      env: { BOXDOWN_CACHE_HOME: tempDir('git-signing-config-cache'), BOXDOWN_DATA_HOME: tempDir('git-signing-config-data') },
      assetsDevcontainerDir
    })
    const signing: GitSigningPlan = {
      enabled: true,
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey comment',
      agentSocketSource: '/run/host-services/ssh-auth.sock'
    }

    const config = buildGeneratedDevcontainerConfig(context, signing)

    assert.ok(config.mounts?.includes(`type=bind,source=${signing.agentSocketSource},target=/run/boxdown/ssh-agent.sock`))
    assert.ok(config.mounts?.includes(`type=bind,source=${context.gitSigningStateDir},target=/opt/boxdown/state/git-signing,readonly`))
    assert.strictEqual(config.containerEnv?.SSH_AUTH_SOCK, '/run/boxdown/ssh-agent.sock')
  })

  test('propagates a disabled signing reason without diagnostic detail', () => {
    const context = createWorkspaceContext({
      workspace: tempDir('git-signing-disabled-config-workspace'),
      env: { BOXDOWN_CACHE_HOME: tempDir('git-signing-disabled-config-cache'), BOXDOWN_DATA_HOME: tempDir('git-signing-disabled-config-data') },
      assetsDevcontainerDir
    })
    const config = buildGeneratedDevcontainerConfig(context, {
      enabled: false,
      reason: 'agent-unavailable',
      detail: 'secret diagnostic detail'
    })

    assert.strictEqual(config.containerEnv?.BOXDOWN_GIT_SIGNING_ENABLED, '0')
    assert.strictEqual(config.containerEnv?.BOXDOWN_GIT_SIGNING_REASON, 'agent-unavailable')
    assert.doesNotMatch(JSON.stringify(config), /secret diagnostic detail/)
  })
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
    assert.match(config.initializeCommand ?? '', /BOXDOWN_HOST_GITCONFIG_PATH=/)
    assert.match(config.initializeCommand ?? '', /BOXDOWN_HOST_GITCONFIG_SNAPSHOT_PATH=/)
    assert.match(config.initializeCommand ?? '', /BOXDOWN_PROGRESS=/)
    assert.match(config.initializeCommand ?? '', /BOXDOWN_VERBOSE=/)
    assert.match(config.initializeCommand ?? '', /assets\/devcontainer\/hooks\/initialize\.sh/)
    assert.match(config.postCreateCommand, /BOXDOWN_PROGRESS=.*BOXDOWN_VERBOSE=.*bash '\/opt\/boxdown\/devcontainer\/hooks\/post-create\.sh'/)
    assert.match(config.postStartCommand, /BOXDOWN_PROGRESS=.*BOXDOWN_VERBOSE=.*bash '\/opt\/boxdown\/devcontainer\/hooks\/post-start\.sh'/)
    assert.ok(config.mounts?.some((mount) => mount.includes(`source=${assetsDevcontainerDir}`)))
    assert.ok(config.mounts?.some((mount) => mount.includes(`source=${context.sshPublicKeyRuntimeDir}`)))
    assert.ok(config.mounts?.includes(`type=bind,source=${context.hostGitconfigSnapshotDir},target=${BOXDOWN_CONTAINER_HOST_GITCONFIG_DIR},readonly`))
    assert.ok(!config.mounts?.some((mount) => mount.includes(`target=${BOXDOWN_CONTAINER_GITCONFIG_PATH}`)))
    assert.ok(!config.mounts?.some((mount) => mount.includes(`target=${BOXDOWN_CONTAINER_AGENTS_DIR}`)))
    assert.ok(!config.mounts?.some((mount) => mount.includes(`target=${BOXDOWN_CONTAINER_CODEX_AUTH_PATH}`)))
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

  test('mounts host Codex auth cache read-only when present', () => {
    const workspace = tempDir('codex-auth-config-workspace')
    const home = tempDir('codex-auth-config-home')
    const hostCodexDir = join(home, '.codex')
    const hostCodexAuthPath = join(hostCodexDir, 'auth.json')
    mkdirSync(hostCodexDir)
    writeFileSync(hostCodexAuthPath, '{}\n')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: home,
        BOXDOWN_CACHE_HOME: tempDir('codex-auth-config-cache'),
        BOXDOWN_DATA_HOME: tempDir('codex-auth-config-data')
      },
      assetsDevcontainerDir
    })

    const config = buildGeneratedDevcontainerConfig(context)

    assert.strictEqual(context.hostCodexAuthPath, hostCodexAuthPath)
    assert.ok(config.mounts?.includes(`type=bind,source=${hostCodexAuthPath},target=${BOXDOWN_CONTAINER_CODEX_AUTH_PATH},readonly`))
  })

  test('does not duplicate existing Codex config mounts', () => {
    const workspace = tempDir('codex-auth-duplicate-workspace')
    const home = tempDir('codex-auth-duplicate-home')
    const hostCodexDir = join(home, '.codex')
    mkdirSync(hostCodexDir)
    writeFileSync(join(hostCodexDir, 'auth.json'), '{}\n')

    for (const existingMount of [
      `type=bind,source=/tmp/codex,target=${BOXDOWN_CONTAINER_CODEX_DIR},readonly`,
      `type=bind,source=/tmp/auth.json,target=${BOXDOWN_CONTAINER_CODEX_AUTH_PATH},readonly`
    ]) {
      const customAssetsDir = tempDir('codex-auth-duplicate-assets')
      writeFileSync(join(customAssetsDir, 'devcontainer.json'), `${JSON.stringify({ mounts: [existingMount] })}\n`)
      const context = createWorkspaceContext({
        workspace,
        env: {
          HOME: home,
          BOXDOWN_CACHE_HOME: tempDir('codex-auth-duplicate-cache'),
          BOXDOWN_DATA_HOME: tempDir('codex-auth-duplicate-data')
        },
        assetsDevcontainerDir: customAssetsDir
      })

      const config = buildGeneratedDevcontainerConfig(context)

      assert.ok(config.mounts?.includes(existingMount))
      assert.ok(!config.mounts?.includes(`type=bind,source=${context.hostCodexAuthPath},target=${BOXDOWN_CONTAINER_CODEX_AUTH_PATH},readonly`))
    }
  })

  test('parses JSONC without stripping URLs inside strings', () => {
    const parsed = parseJsonc<{ url: string }>('{ "url": "https://example.com/path" // keep string URL\n }')
    assert.strictEqual(parsed.url, 'https://example.com/path')
  })
})

describe('git signing selection', () => {
  const first = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFirstKey first@example.com'
  const second = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISecondKey second@example.com'

  test('normalizes public keys without comments', () => {
    assert.strictEqual(parseSshPublicKey(first), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFirstKey')
  })

  test('selects a configured loaded key', () => {
    assert.deepStrictEqual(selectGitSigningKey([first, second], second), { key: parseSshPublicKey(second) })
  })

  test('does not fall back when an explicit configured key is invalid or not loaded', () => {
    assert.deepStrictEqual(selectGitSigningKey([first], 'not-a-public-key', [first]), { reason: 'configured-key-invalid' })
    assert.deepStrictEqual(selectGitSigningKey([first], second, [first]), { reason: 'configured-key-not-loaded' })
  })

  test('selects one GitHub identity but does not guess between ambiguous keys', () => {
    assert.deepStrictEqual(selectGitSigningKey([first, second], undefined, [second]), { key: parseSshPublicKey(second) })
    assert.deepStrictEqual(selectGitSigningKey([first, second]), { reason: 'ambiguous-identities' })
  })

  test('resolves inline and key-prefixed configured SSH public keys', () => {
    const workspace = tempDir('git-signing-inline-workspace')

    assert.deepStrictEqual(resolveConfiguredSshSigningKey(second, { workspaceFolder: workspace }), {
      key: parseSshPublicKey(second)
    })
    assert.deepStrictEqual(resolveConfiguredSshSigningKey(`key::${second}`, { workspaceFolder: workspace }), {
      key: parseSshPublicKey(second)
    })
  })

  test('resolves absolute, home-relative, and workspace-relative configured public-key paths', () => {
    const workspace = tempDir('git-signing-path-workspace')
    const home = tempDir('git-signing-path-home')
    const absolutePath = join(tempDir('git-signing-absolute-key'), 'signing.pub')
    const homePath = join(home, 'home-signing.pub')
    const relativePath = join(workspace, 'relative-signing.pub')
    writeFileSync(absolutePath, `${first}\n`)
    writeFileSync(homePath, `${second}\n`)
    writeFileSync(relativePath, `${first}\n`)

    assert.deepStrictEqual(resolveConfiguredSshSigningKey(absolutePath, { homeDir: home, workspaceFolder: workspace }), {
      key: parseSshPublicKey(first)
    })
    assert.deepStrictEqual(resolveConfiguredSshSigningKey('~/home-signing.pub', { homeDir: home, workspaceFolder: workspace }), {
      key: parseSshPublicKey(second)
    })
    assert.deepStrictEqual(resolveConfiguredSshSigningKey('relative-signing.pub', { homeDir: home, workspaceFolder: workspace }), {
      key: parseSshPublicKey(first)
    })
  })

  test('rejects unreadable, malformed, and private configured key files', () => {
    const workspace = tempDir('git-signing-invalid-workspace')
    const malformedPath = join(workspace, 'malformed.pub')
    const privatePath = join(workspace, 'private-key')
    writeFileSync(malformedPath, 'not an SSH public key\n')
    writeFileSync(privatePath, '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate material\n')

    assert.deepStrictEqual(resolveConfiguredSshSigningKey('key::not-an-ssh-public-key', { workspaceFolder: workspace }), {
      reason: 'configured-key-invalid',
      detail: 'configured inline value is not a valid SSH public key'
    })
    assert.deepStrictEqual(resolveConfiguredSshSigningKey('missing.pub', { workspaceFolder: workspace }), {
      reason: 'configured-key-unreadable',
      detail: 'configured public-key file could not be read'
    })
    assert.deepStrictEqual(resolveConfiguredSshSigningKey('malformed.pub', { workspaceFolder: workspace }), {
      reason: 'configured-key-invalid',
      detail: 'configured public-key file does not contain a valid SSH public key'
    })
    assert.deepStrictEqual(resolveConfiguredSshSigningKey('private-key', { workspaceFolder: workspace }), {
      reason: 'configured-key-invalid',
      detail: 'configured public-key file does not contain a valid SSH public key'
    })
  })

  test('reports every disabled signing reason concisely and logs structured detail', () => {
    const workspace = tempDir('git-signing-report-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('git-signing-report-cache'),
        BOXDOWN_DATA_HOME: tempDir('git-signing-report-data')
      },
      assetsDevcontainerDir
    })
    const logger = createWorkspaceCommandLogger(context)
    const warnings: string[] = []
    const reasons: GitSigningReason[] = [
      'agent-unavailable',
      'no-identities',
      'ambiguous-identities',
      'configured-key-unreadable',
      'configured-key-invalid',
      'configured-key-not-loaded',
      'agent-socket-unavailable',
      'docker-probe-image-unavailable',
      'agent-mount-unavailable'
    ]

    for (const reason of reasons) {
      reportGitSigningPlan({
        enabled: false,
        reason,
        detail: 'sanitized diagnostic'
      }, {
        logger,
        writeWarning: (message) => warnings.push(message)
      })
    }

    const log = readFileSync(context.workspaceLogPath, 'utf8')
    assert.strictEqual(warnings.length, reasons.length)
    assert.ok(warnings.every((warning) => warning.startsWith('boxdown: commit signing disabled: ')))
    assert.ok(warnings.every((warning) => warning.endsWith('; commits will remain unsigned.\n')))
    for (const reason of reasons) {
      assert.ok(log.includes(`reason=${reason}`))
    }
    assert.match(log, /detail=sanitized diagnostic/)
  })

  test('redacts SSH key and token-shaped values from signing diagnostic logs', () => {
    const workspace = tempDir('git-signing-redacted-report-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('git-signing-redacted-report-cache'),
        BOXDOWN_DATA_HOME: tempDir('git-signing-redacted-report-data')
      },
      assetsDevcontainerDir
    })
    const logger = createWorkspaceCommandLogger(context)
    const keyMaterial = 'AAAAC3NzaC1lZDI1NTE5AAAAISensitiveDiagnosticKey'
    const token = 'github_pat_sensitiveDiagnosticToken'

    reportGitSigningPlan({
      enabled: false,
      reason: 'agent-mount-unavailable',
      detail: `probe failed for ssh-ed25519 ${keyMaterial} using ${token}`
    }, { logger, quiet: true })

    const log = readFileSync(context.workspaceLogPath, 'utf8')
    assert.ok(!log.includes(keyMaterial))
    assert.ok(!log.includes(token))
    assert.match(log, /\[redacted-ssh-key\]/)
    assert.match(log, /\[redacted-token\]/)
  })

  test('keeps internal signing diagnostics log-only when quiet', () => {
    const workspace = tempDir('git-signing-quiet-report-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('git-signing-quiet-report-cache'),
        BOXDOWN_DATA_HOME: tempDir('git-signing-quiet-report-data')
      },
      assetsDevcontainerDir
    })
    const logger = createWorkspaceCommandLogger(context)
    const warnings: string[] = []

    reportGitSigningPlan({ enabled: false, reason: 'agent-unavailable' }, {
      logger,
      quiet: true,
      writeWarning: (message) => warnings.push(message)
    })

    assert.deepStrictEqual(warnings, [])
    assert.match(readFileSync(context.workspaceLogPath, 'utf8'), /reason=agent-unavailable/)
  })

  test('full preflight resolves an explicit public-key path without GitHub fallback', async () => {
    const workspace = tempDir('git-signing-preflight-workspace')
    const home = tempDir('git-signing-preflight-home')
    const signingKeyPath = join(home, 'signing.pub')
    writeFileSync(signingKeyPath, `${second}\n`)
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: home,
        BOXDOWN_CACHE_HOME: tempDir('git-signing-preflight-cache'),
        BOXDOWN_DATA_HOME: tempDir('git-signing-preflight-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []

    const plan = await resolveGitSigningPlan(context, {
      env: { HOME: home },
      platform: 'darwin',
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'ssh-add') return { code: 0, stdout: `${first}\n${second}\n`, stderr: '' }
        if (command === 'git' && args.includes('gpg.format')) return { code: 0, stdout: 'ssh\n', stderr: '' }
        if (command === 'git' && args.includes('user.signingkey')) return { code: 0, stdout: `${signingKeyPath}\n`, stderr: '' }
        if (command === 'docker' && args[0] === 'image') return { code: 0, stdout: 'example:latest\n', stderr: '' }
        if (command === 'docker' && args[0] === 'create') return { code: 0, stdout: 'probe-container\n', stderr: '' }
        if (command === 'docker' && args[0] === 'rm') return { code: 0, stdout: '', stderr: '' }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
      }
    })

    assert.deepStrictEqual(plan, {
      enabled: true,
      publicKey: parseSshPublicKey(second),
      agentSocketSource: '/run/host-services/ssh-auth.sock'
    })
    assert.ok(calls.every((call) => !call.startsWith('gh ')))
    assert.strictEqual(readFileSync(context.gitSigningPublicKeyPath, 'utf8'), `${parseSshPublicKey(second)}\n`)
  })

  test('full preflight preserves configured-key and Docker probe failure reasons', async () => {
    const workspace = tempDir('git-signing-preflight-failure-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('git-signing-preflight-failure-cache'),
        BOXDOWN_DATA_HOME: tempDir('git-signing-preflight-failure-data')
      },
      assetsDevcontainerDir
    })
    const unreadableCalls: string[] = []
    const unreadable = await resolveGitSigningPlan(context, {
      platform: 'darwin',
      runCommand: async (command, args) => {
        unreadableCalls.push(`${command} ${args.join(' ')}`)
        if (command === 'ssh-add') return { code: 0, stdout: `${first}\n`, stderr: '' }
        if (command === 'git' && args.includes('gpg.format')) return { code: 0, stdout: 'ssh\n', stderr: '' }
        if (command === 'git' && args.includes('user.signingkey')) return { code: 0, stdout: 'missing.pub\n', stderr: '' }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
      }
    })

    assert.deepStrictEqual(unreadable, {
      enabled: false,
      reason: 'configured-key-unreadable',
      detail: 'configured public-key file could not be read'
    })
    assert.ok(unreadableCalls.every((call) => !call.startsWith('gh ') && !call.startsWith('docker ')))

    const noImage = await resolveGitSigningPlan(context, {
      platform: 'darwin',
      runCommand: async (command, args) => {
        if (command === 'ssh-add') return { code: 0, stdout: `${first}\n`, stderr: '' }
        if (command === 'git') return { code: 1, stdout: '', stderr: '' }
        if (command === 'docker' && args[0] === 'image') return { code: 0, stdout: '', stderr: '' }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
      }
    })

    assert.deepStrictEqual(noImage, {
      enabled: false,
      reason: 'docker-probe-image-unavailable',
      detail: 'no tagged local Docker image was found'
    })
  })
})

describe('devcontainer git config hooks', () => {
  test('initialize snapshots host gitconfig and removes stale snapshot when host file is absent', () => {
    const initializePath = join(assetsDevcontainerDir, 'hooks', 'initialize.sh')
    const workspace = tempDir('initialize-gitconfig-workspace')
    const home = tempDir('initialize-gitconfig-home')
    const hostGitconfigPath = join(home, '.gitconfig')
    const snapshotPath = join(tempDir('initialize-gitconfig-state'), '.gitconfig')

    writeFileSync(hostGitconfigPath, '[user]\n\tname = Liran\n')

    execFileSync('bash', [initializePath], {
      env: {
        ...process.env,
        BOXDOWN_WORKSPACE_FOLDER: workspace,
        BOXDOWN_HOST_GITCONFIG_PATH: hostGitconfigPath,
        BOXDOWN_HOST_GITCONFIG_SNAPSHOT_PATH: snapshotPath
      }
    })

    assert.strictEqual(readFileSync(snapshotPath, 'utf8'), '[user]\n\tname = Liran\n')

    execFileSync('bash', [initializePath], {
      env: {
        ...process.env,
        BOXDOWN_WORKSPACE_FOLDER: workspace,
        BOXDOWN_HOST_GITCONFIG_PATH: join(home, 'missing-gitconfig'),
        BOXDOWN_HOST_GITCONFIG_SNAPSHOT_PATH: snapshotPath
      }
    })

    assert.strictEqual(existsSync(snapshotPath), false)
  })

  test('git config bootstrap copies and sanitizes the container global config', () => {
    const bootstrapPath = join(assetsDevcontainerDir, 'utils', 'git-config-bootstrap.sh')
    const sourcePath = join(tempDir('gitconfig-bootstrap-source'), '.gitconfig')
    const targetPath = join(tempDir('gitconfig-bootstrap-target'), '.gitconfig')

    writeFileSync(sourcePath, [
      '[url "git@github.com:"]',
      '\tinsteadOf = https://github.com/',
      '[url "ssh://git@github.com/"]',
      '\tinsteadOf = https://github.com/',
      '[credential]',
      '\thelper = /opt/homebrew/bin/gh auth git-credential',
      '\thelper = cache',
      '[credential "https://github.com"]',
      '\thelper = /Applications/GitHub Desktop.app/Contents/Resources/app/git-credential-helper',
      '\thelper = osxkeychain',
      '[commit]',
      '\tgpgsign = true',
      '[tag]',
      '\tgpgsign = true',
      ''
    ].join('\n'))

    execFileSync('bash', [bootstrapPath], {
      env: {
        ...process.env,
        BOXDOWN_GITCONFIG_SOURCE_PATH: sourcePath,
        BOXDOWN_GITCONFIG_TARGET_PATH: targetPath
      }
    })

    assert.strictEqual(readGitConfig(targetPath, 'url.git@github.com:.insteadOf'), undefined)
    assert.strictEqual(readGitConfig(targetPath, 'url.ssh://git@github.com/.insteadOf'), undefined)
    assert.deepStrictEqual(readGitConfigAll(targetPath, 'credential.helper'), ['cache'])
    assert.deepStrictEqual(readGitConfigAll(targetPath, 'credential.https://github.com.helper'), ['', '!gh auth git-credential'])
    assert.strictEqual(readGitConfig(targetPath, 'commit.gpgsign'), 'true')
    assert.strictEqual(readGitConfig(targetPath, 'tag.gpgsign'), 'true')
  })

  test('git config bootstrap succeeds without a host snapshot', () => {
    const bootstrapPath = join(assetsDevcontainerDir, 'utils', 'git-config-bootstrap.sh')
    const targetPath = join(tempDir('gitconfig-bootstrap-empty-target'), '.gitconfig')

    execFileSync('bash', [bootstrapPath], {
      env: {
        ...process.env,
        BOXDOWN_GITCONFIG_SOURCE_PATH: join(tempDir('gitconfig-bootstrap-missing-source'), '.gitconfig'),
        BOXDOWN_GITCONFIG_TARGET_PATH: targetPath
      }
    })

    assert.strictEqual(existsSync(targetPath), true)
    assert.deepStrictEqual(readGitConfigAll(targetPath, 'credential.https://github.com.helper'), ['', '!gh auth git-credential'])
  })

  test('post-create local git config is idempotent with multiple GitHub helpers', () => {
    const postCreatePath = join(assetsDevcontainerDir, 'hooks', 'post-create.sh')
    const workspace = tempDir('post-create-local-git')

    execFileSync('git', ['init'], { cwd: workspace })
    execFileSync('git', ['config', '--local', '--add', 'credential.https://github.com.helper', ''], { cwd: workspace })
    execFileSync('git', ['config', '--local', '--add', 'credential.https://github.com.helper', '!gh auth git-credential'], { cwd: workspace })

    execFileSync('bash', ['-c', 'source "$1"; configure_local_git', 'bash', postCreatePath], { cwd: workspace })

    const helpers = execFileSync('git', ['config', '--local', '--get-all', 'credential.https://github.com.helper'], { cwd: workspace })
      .toString('utf8')
      .replace(/\r?\n$/, '')
      .split(/\r?\n/)

    assert.deepStrictEqual(helpers, ['', '!gh auth git-credential'])
    assert.strictEqual(readGitConfig(join(workspace, '.git', 'config'), 'commit.gpgsign'), undefined)
    assert.strictEqual(execFileSync('git', ['config', '--local', '--get', 'core.pager'], { cwd: workspace }).toString('utf8').trim(), 'less -R')
  })

  test('git signing bootstrap falls back to unsigned commits without an agent', () => {
    const bootstrapPath = join(assetsDevcontainerDir, 'utils', 'git-signing-bootstrap.sh')
    const targetPath = join(tempDir('git-signing-target'), '.gitconfig')
    writeFileSync(targetPath, '[gpg]\n\tprogram = /opt/homebrew/bin/gpg\n[commit]\n\tgpgsign = true\n')

    execFileSync('bash', [bootstrapPath], {
      env: { ...process.env, BOXDOWN_GITCONFIG_TARGET_PATH: targetPath, BOXDOWN_GIT_SIGNING_ENABLED: '0' }
    })

    assert.strictEqual(readGitConfig(targetPath, 'commit.gpgsign'), 'false')
    assert.strictEqual(readGitConfig(targetPath, 'gpg.program'), undefined)
  })

  test('git signing bootstrap reports the host preflight reason', () => {
    const bootstrapPath = join(assetsDevcontainerDir, 'utils', 'git-signing-bootstrap.sh')
    const targetPath = join(tempDir('git-signing-host-reason-target'), '.gitconfig')
    const result = spawnSync('bash', [bootstrapPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BOXDOWN_GITCONFIG_TARGET_PATH: targetPath,
        BOXDOWN_GIT_SIGNING_ENABLED: '0',
        BOXDOWN_GIT_SIGNING_REASON: 'agent-socket-unavailable'
      }
    })

    assert.strictEqual(result.status, 0)
    assert.match(result.stderr, /reason: agent-socket-unavailable/)
    assert.strictEqual(readGitConfig(targetPath, 'commit.gpgsign'), 'false')
  })

  test('git signing bootstrap distinguishes missing keys and unavailable agent identities', () => {
    const bootstrapPath = join(assetsDevcontainerDir, 'utils', 'git-signing-bootstrap.sh')
    const testRoot = tempDir('git-signing-container-inputs')
    const targetPath = join(testRoot, '.gitconfig')
    const missingKey = spawnSync('bash', [bootstrapPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BOXDOWN_GITCONFIG_TARGET_PATH: targetPath,
        BOXDOWN_GIT_SIGNING_ENABLED: '1',
        BOXDOWN_GIT_SIGNING_KEY_PATH: join(testRoot, 'missing.pub')
      }
    })
    assert.strictEqual(missingKey.status, 0)
    assert.match(missingKey.stderr, /reason: container-key-unavailable/)

    const binDir = join(testRoot, 'bin')
    mkdirSync(binDir)
    const sshAddPath = join(binDir, 'ssh-add')
    writeFileSync(sshAddPath, '#!/usr/bin/env bash\nexit 2\n')
    chmodSync(sshAddPath, 0o755)
    const keyPath = join(testRoot, 'signing.pub')
    writeFileSync(keyPath, 'ssh-ed25519 AAAAC3NzaContainerSigningKey test\n')
    const unavailableAgent = spawnSync('bash', [bootstrapPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        BOXDOWN_GITCONFIG_TARGET_PATH: targetPath,
        BOXDOWN_GIT_SIGNING_ENABLED: '1',
        BOXDOWN_GIT_SIGNING_KEY_PATH: keyPath
      }
    })
    assert.strictEqual(unavailableAgent.status, 0)
    assert.match(unavailableAgent.stderr, /reason: container-agent-unavailable/)

    writeFileSync(sshAddPath, '#!/usr/bin/env bash\nprintf "%s\\n" "ssh-ed25519 AAAAC3NzaDifferentKey other"\n')
    chmodSync(sshAddPath, 0o755)
    const unloadedKey = spawnSync('bash', [bootstrapPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        BOXDOWN_GITCONFIG_TARGET_PATH: targetPath,
        BOXDOWN_GIT_SIGNING_ENABLED: '1',
        BOXDOWN_GIT_SIGNING_KEY_PATH: keyPath
      }
    })
    assert.strictEqual(unloadedKey.status, 0)
    assert.match(unloadedKey.stderr, /reason: container-key-not-loaded/)
  })

  test('git signing bootstrap distinguishes failed and successful signing probes', () => {
    const bootstrapPath = join(assetsDevcontainerDir, 'utils', 'git-signing-bootstrap.sh')
    const testRoot = tempDir('git-signing-container-probe')
    const binDir = join(testRoot, 'bin')
    mkdirSync(binDir)
    const publicKey = 'ssh-ed25519 AAAAC3NzaContainerSigningKey test'
    const keyPath = join(testRoot, 'signing.pub')
    writeFileSync(keyPath, `${publicKey}\n`)
    const sshAddPath = join(binDir, 'ssh-add')
    writeFileSync(sshAddPath, `#!/usr/bin/env bash\nprintf '%s\\n' '${publicKey}'\n`)
    chmodSync(sshAddPath, 0o755)
    const gitPath = join(binDir, 'git')
    writeFileSync(gitPath, [
      '#!/usr/bin/env bash',
      'if [[ "${1:-}" == "commit" ]]; then',
      '  exit "${BOXDOWN_TEST_GIT_COMMIT_EXIT:-0}"',
      'fi',
      'exec "${BOXDOWN_TEST_REAL_GIT}" "$@"',
      ''
    ].join('\n'))
    chmodSync(gitPath, 0o755)
    const commonEnv = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      BOXDOWN_TEST_REAL_GIT: execFileSync('which', ['git']).toString('utf8').trim(),
      BOXDOWN_GIT_SIGNING_ENABLED: '1',
      BOXDOWN_GIT_SIGNING_KEY_PATH: keyPath
    }

    const failedTarget = join(testRoot, 'failed.gitconfig')
    const failed = spawnSync('bash', [bootstrapPath], {
      encoding: 'utf8',
      env: {
        ...commonEnv,
        BOXDOWN_TEST_GIT_COMMIT_EXIT: '1',
        BOXDOWN_GITCONFIG_TARGET_PATH: failedTarget
      }
    })
    assert.strictEqual(failed.status, 0)
    assert.match(failed.stderr, /reason: container-signing-probe-failed/)
    assert.strictEqual(readGitConfig(failedTarget, 'commit.gpgsign'), 'false')

    const successfulTarget = join(testRoot, 'successful.gitconfig')
    const successful = spawnSync('bash', [bootstrapPath], {
      encoding: 'utf8',
      env: {
        ...commonEnv,
        BOXDOWN_TEST_GIT_COMMIT_EXIT: '0',
        BOXDOWN_GITCONFIG_TARGET_PATH: successfulTarget
      }
    })
    assert.strictEqual(successful.status, 0)
    assert.doesNotMatch(successful.stderr, /commit signing unavailable/)
    assert.strictEqual(readGitConfig(successfulTarget, 'commit.gpgsign'), 'true')
    assert.strictEqual(readGitConfig(successfulTarget, 'gpg.format'), 'ssh')
    assert.strictEqual(readGitConfig(successfulTarget, 'user.signingkey'), keyPath)
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

    assert.match(script, /infocmp "\$\{TERM:-xterm-256color\}"/)
    assert.match(script, /export TERM=xterm-256color/)
    assert.match(script, /stty size/)
    assert.match(script, /stty cols "\$max_columns"/)
    assert.match(script, /BOXDOWN_TTY_NORMALIZE/)
    assert.match(script, /exec bash -i/)
  })

  test('normalizes unknown TERM values before interactive commands', () => {
    const script = interactiveCommandScript()

    assert.match(script, /infocmp "\$\{TERM:-xterm-256color\}"/)
    assert.match(script, /export TERM=xterm-256color/)
    assert.match(script, /export COLORTERM="\$\{COLORTERM:-truecolor\}"/)
    assert.match(script, /exec "\$@"/)
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

  test('builds SSH local tunnel args against remote localhost', () => {
    assert.deepStrictEqual(sshTunnelArgs('demo-devcontainer', [
      {
        localPort: 3030,
        remotePort: 3030
      },
      {
        localPort: 8080,
        remotePort: 3031
      }
    ]), [
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      '127.0.0.1:3030:localhost:3030',
      '-L',
      '127.0.0.1:8080:localhost:3031',
      'demo-devcontainer'
    ])
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

  test('repairs accumulated blank lines in an SSH config containing only managed blocks', () => {
    const workspace = tempDir('ssh-replace-blank-lines-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-replace-blank-lines-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-replace-blank-lines-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const otherAlias = 'npq-devcontainer'
    const fixture = `${'\n'.repeat(140)}${buildSshConfigBlock(context, alias)}\n${buildSshConfigBlock(context, otherAlias)}`

    const replaced = replaceSshConfigBlock(fixture, alias, buildSshConfigBlock(context, alias))

    assert.strictEqual(replaced.startsWith('\n'), false)
    assert.strictEqual(replaced.includes('\n\n\n'), false)
    assert.strictEqual(replaced.split(`# BEGIN ${alias} boxdown`).length - 1, 1)
    assert.strictEqual(replaced.split(`# BEGIN ${otherAlias} boxdown`).length - 1, 1)
  })

  test('removes accumulated leading blank lines when uninstalling a managed SSH block', () => {
    const workspace = tempDir('ssh-remove-blank-lines-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-remove-blank-lines-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-remove-blank-lines-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const otherAlias = 'npq-devcontainer'
    const fixture = `${'\n'.repeat(140)}${buildSshConfigBlock(context, alias)}\n${buildSshConfigBlock(context, otherAlias)}`

    const removed = removeSshConfigBlock(fixture, alias)

    assert.strictEqual(removed.startsWith('\n'), false)
    assert.strictEqual(removed.includes('\n\n'), false)
    assert.strictEqual(removed, buildSshConfigBlock(context, otherAlias))
  })

  test('preserves leading blank lines before unmanaged SSH config', () => {
    const workspace = tempDir('ssh-preserve-unmanaged-blank-lines-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-preserve-unmanaged-blank-lines-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-preserve-unmanaged-blank-lines-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const existing = `\n\nHost github.com\n  User git\n`

    const replaced = replaceSshConfigBlock(existing, alias, buildSshConfigBlock(context, alias))

    assert.strictEqual(replaced.startsWith(existing), true)
  })

  test('replaces legacy managed block when installing current SSH config', () => {
    const workspace = tempDir('ssh-replace-legacy-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-replace-legacy-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-replace-legacy-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const block = buildSshConfigBlock(context, alias)
    const existing = [
      'Host github.com',
      '  User git',
      `# BEGIN ${alias} devcontainer ssh`,
      `Host ${alias}`,
      '  User node',
      `# END ${alias} devcontainer ssh`,
      ''
    ].join('\n')
    const replaced = replaceSshConfigBlock(existing, alias, block)

    assert.match(replaced, /Host github.com/)
    assert.strictEqual(replaced.includes(`# BEGIN ${alias} devcontainer ssh`), false)
    assert.strictEqual(replaced.split(`# BEGIN ${alias} boxdown`).length - 1, 1)
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

  test('removes legacy managed block without touching unrelated SSH config', () => {
    const workspace = tempDir('ssh-remove-legacy-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-remove-legacy-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-remove-legacy-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const existing = [
      'Host github.com',
      '  User git',
      `# BEGIN ${alias} devcontainer ssh`,
      `Host ${alias}`,
      '  User node',
      `# END ${alias} devcontainer ssh`,
      ''
    ].join('\n')

    assert.strictEqual(removeSshConfigBlock(existing, alias), 'Host github.com\n  User git\n')
  })

  test('removes only the selected managed SSH config alias', () => {
    const workspace = tempDir('ssh-remove-selected-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-remove-selected-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-remove-selected-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const otherAlias = 'lirantaldotcom-devcontainer'
    const prefixAlias = `${alias}-old`
    const existing = [
      'Host github.com',
      '  User git',
      buildSshConfigBlock(context, otherAlias).trimEnd(),
      buildSshConfigBlock(context, alias).trimEnd(),
      buildSshConfigBlock(context, prefixAlias).trimEnd(),
      'Host anti-trojan-source-devcontainer',
      '  HostName anti-trojan-source-devcontainer',
      ''
    ].join('\n')
    const removed = removeSshConfigBlock(existing, alias)

    assert.strictEqual(removed.includes(`# BEGIN ${alias} boxdown devcontainer ssh`), false)
    assert.strictEqual(removed.includes(`# BEGIN ${otherAlias} boxdown devcontainer ssh`), true)
    assert.strictEqual(removed.includes(`# BEGIN ${prefixAlias} boxdown devcontainer ssh`), true)
    assert.match(removed, /Host github\.com/)
    assert.match(removed, /Host anti-trojan-source-devcontainer/)
  })

  test('preserves unmanaged Host entries for the same alias on uninstall', () => {
    const workspace = tempDir('ssh-unmanaged-same-alias-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-unmanaged-same-alias-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-unmanaged-same-alias-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const unmanaged = [
      `Host ${alias}`,
      '  HostName manually-managed.example.test',
      '  User deploy',
      ''
    ].join('\n')

    assert.strictEqual(removeSshConfigBlock(unmanaged, alias), unmanaged)
  })

  test('refuses to rewrite overlapping managed SSH config blocks', async () => {
    const workspace = tempDir('ssh-overlap-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-overlap-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-overlap-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const otherAlias = 'lirantaldotcom-devcontainer'
    const block = buildSshConfigBlock(context, alias)
    const sshConfigPath = join(tempDir('ssh-overlap-config'), 'config')
    const overlapping = [
      'Host github.com',
      '  User git',
      `# BEGIN ${alias} boxdown devcontainer ssh`,
      `Host ${alias}`,
      `# BEGIN ${otherAlias} boxdown devcontainer ssh`,
      `Host ${otherAlias}`,
      `# END ${alias} boxdown devcontainer ssh`,
      `# END ${otherAlias} boxdown devcontainer ssh`,
      ''
    ].join('\n')

    assert.throws(() => replaceSshConfigBlock(overlapping, alias, block), /overlapping/)
    assert.throws(() => removeSshConfigBlock(overlapping, alias), /overlapping/)

    writeFileSync(sshConfigPath, overlapping)
    await assert.rejects(async () => installSshConfig(context, alias, { quiet: true, configPath: sshConfigPath }), /overlapping/)
    assert.throws(() => uninstallSshConfig(alias, { quiet: true, configPath: sshConfigPath }), /overlapping/)
    assert.strictEqual(readFileSync(sshConfigPath, 'utf8'), overlapping)
  })

  test('refuses mismatched managed SSH config marker variants', () => {
    const workspace = tempDir('ssh-mismatched-marker-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-mismatched-marker-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-mismatched-marker-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const block = buildSshConfigBlock(context, alias)
    const mismatched = [
      `# BEGIN ${alias} boxdown devcontainer ssh`,
      `Host ${alias}`,
      `# END ${alias} devcontainer ssh`,
      `# END ${alias} boxdown devcontainer ssh`,
      ''
    ].join('\n')

    assert.throws(() => replaceSshConfigBlock(mismatched, alias, block), /overlapping/)
    assert.throws(() => removeSshConfigBlock(mismatched, alias), /overlapping/)
  })

  test('refuses to rewrite malformed managed SSH config blocks', async () => {
    const workspace = tempDir('ssh-malformed-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-malformed-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-malformed-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const block = buildSshConfigBlock(context, alias)
    const sshConfigPath = join(tempDir('ssh-malformed-config'), 'config')
    const malformed = [
      'Host github.com',
      '  User git',
      `# BEGIN ${alias} boxdown devcontainer ssh`,
      `Host ${alias}`,
      '  User node',
      'Host lirantaldotcom',
      '  User deploy',
      ''
    ].join('\n')

    assert.throws(() => replaceSshConfigBlock(malformed, alias, block), /without matching/)
    assert.throws(() => removeSshConfigBlock(malformed, alias), /without matching/)

    writeFileSync(sshConfigPath, malformed)
    assert.throws(() => uninstallSshConfig(alias, { quiet: true, configPath: sshConfigPath }), /without matching/)
    assert.strictEqual(readFileSync(sshConfigPath, 'utf8'), malformed)
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
    assert.strictEqual(canonicalCodexRemotePathForWorkspace(context), `/workspaces/${context.workspaceBasename}`)
    assert.strictEqual(legacyCodexRemotePathForWorkspace(context), `/home/node/${context.workspaceBasename}`)
    assert.deepStrictEqual(codexProjectEntryForWorkspace(context, 'demo-devcontainer'), {
      sshAlias: 'demo-devcontainer',
      remotePath: `/workspaces/${context.workspaceBasename}`,
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

  test('canonicalizes legacy Codex app projects during install', () => {
    const config = parseCodexAppConfig({
      version: 1,
      remoteConnections: [
        {
          sshAlias: 'demo-devcontainer',
          projects: [
            {
              remotePath: '/home/node/demo/',
              label: 'Old demo'
            },
            {
              remotePath: '/workspaces/demo',
              label: 'Duplicate demo'
            },
            {
              remotePath: '/home/node/other',
              label: 'Other'
            }
          ]
        }
      ]
    })

    assert.deepStrictEqual(mergeCodexAppProject(config, {
      sshAlias: 'demo-devcontainer',
      remotePath: '/workspaces/demo',
      label: 'Demo'
    }, {
      legacyRemotePaths: ['/home/node/demo']
    }).remoteConnections[0]?.projects, [
      {
        remotePath: '/workspaces/demo',
        label: 'Demo'
      },
      {
        remotePath: '/home/node/other',
        label: 'Other'
      }
    ])
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

  test('uninstalls canonical and legacy Codex project config entries together', () => {
    const config = parseCodexAppConfig({
      version: 1,
      remoteConnections: [
        {
          sshAlias: 'demo-devcontainer',
          projects: [
            {
              remotePath: '/workspaces/demo',
              label: 'Demo'
            },
            {
              remotePath: '/home/node/demo',
              label: 'Legacy demo'
            },
            {
              remotePath: '/home/node/other',
              label: 'Other'
            }
          ]
        }
      ]
    })

    assert.deepStrictEqual(removeCodexAppProject(config, {
      sshAlias: 'demo-devcontainer',
      remotePath: '/workspaces/demo',
      label: 'Demo'
    }, {
      additionalRemotePaths: ['/home/node/demo']
    }).remoteConnections, [
      {
        sshAlias: 'demo-devcontainer',
        projects: [
          {
            remotePath: '/home/node/other',
            label: 'Other'
          }
        ]
      }
    ])
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

  test('canonicalizes matching Codex global sidebar state and preserves project identity', () => {
    const statePath = join(tempDir('codex-state-normalize'), '.codex-global-state.json')
    const entry = {
      sshAlias: 'demo-devcontainer',
      remotePath: '/workspaces/demo',
      label: 'Demo'
    }
    const hostId = codexDiscoveredRemoteHostId(entry.sshAlias)
    const otherHostId = codexDiscoveredRemoteHostId('other-devcontainer')
    const state = {
      'project-order': ['demo-project-id', 'duplicate-project-id', 'other-project-id'],
      'sidebar-collapsed-groups': {
        'demo-project-id': true,
        'duplicate-project-id': true,
        'other-project-id': true
      },
      'remote-projects': [
        {
          id: 'demo-project-id',
          hostId,
          remotePath: '/home/node/demo',
          label: 'Demo'
        },
        {
          id: 'duplicate-project-id',
          hostId,
          remotePath: '/workspaces/demo',
          label: 'Duplicate Demo'
        },
        {
          id: 'other-project-id',
          hostId: otherHostId,
          remotePath: '/home/node/demo',
          label: 'Other'
        }
      ]
    }

    writeFileSync(statePath, `${JSON.stringify(state)}\n`)

    const pure = normalizeCodexGlobalStateProject(state, entry, {
      legacyRemotePaths: ['/home/node/demo']
    })
    const result = installCodexGlobalStateProject(entry, {
      statePath,
      legacyRemotePaths: ['/home/node/demo'],
      now: new Date('2026-01-01T00:00:00.000Z')
    })
    const nextState = JSON.parse(readFileSync(statePath, 'utf8'))

    assert.deepStrictEqual(pure, nextState)
    assert.strictEqual(result.changed, true)
    assert.strictEqual(result.backupPath, `${statePath}.2026-01-01T00-00-00-000Z.bak`)
    assert.deepStrictEqual(nextState['remote-projects'], [
      {
        id: 'demo-project-id',
        hostId,
        remotePath: '/workspaces/demo',
        label: 'Demo'
      },
      {
        id: 'other-project-id',
        hostId: otherHostId,
        remotePath: '/home/node/demo',
        label: 'Other'
      }
    ])
    assert.deepStrictEqual(nextState['project-order'], ['demo-project-id', 'other-project-id'])
    assert.deepStrictEqual(nextState['sidebar-collapsed-groups'], {
      'demo-project-id': true,
      'other-project-id': true
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
      remotePath: `/workspaces/${context.workspaceBasename}`,
      label: context.workspaceBasename
    })
  })
})

describe('Claude SSH config injection', () => {
  test('builds the default config path and workspace SSH entry', () => {
    const workspace = tempDir('claude-entry-workspace')
    const home = tempDir('claude-entry-home')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: home,
        BOXDOWN_CACHE_HOME: tempDir('claude-entry-cache'),
        BOXDOWN_DATA_HOME: tempDir('claude-entry-data')
      },
      assetsDevcontainerDir
    })

    assert.strictEqual(defaultClaudeSshConfigsPath({ HOME: home }, 'darwin'), join(home, 'Library', 'Application Support', 'Claude', 'ssh_configs.json'))
    assert.strictEqual(defaultClaudeSshConfigsPath({ HOME: home, BOXDOWN_CLAUDE_SSH_CONFIGS: '/tmp/claude.json' }, 'darwin'), '/tmp/claude.json')
    assert.deepStrictEqual(claudeSshConfigEntryForWorkspace(context, 'demo-devcontainer'), {
      name: context.workspaceBasename,
      sshHost: 'demo-devcontainer'
    })
  })

  test('merges by SSH host, preserves IDs, and trusts the host', () => {
    const config = parseClaudeSshConfigs({
      unknown: true,
      configs: [
        {
          name: 'Old demo',
          sshHost: 'demo-devcontainer',
          id: 'existing-id',
          source: 'desktop',
          unknown: true
        },
        {
          name: 'Other',
          sshHost: 'other-devcontainer',
          id: 'other-id',
          source: 'desktop'
        }
      ],
      trustedHosts: ['other-devcontainer']
    })

    const first = mergeClaudeSshConfigHost(config, {
      name: 'Demo',
      sshHost: 'demo-devcontainer'
    }, () => 'unused-id')
    const second = mergeClaudeSshConfigHost(first, {
      name: 'New demo',
      sshHost: 'new-demo-devcontainer'
    }, () => 'new-id')

    assert.strictEqual(first.unknown, true)
    assert.deepStrictEqual(first.configs[0], {
      name: 'Demo',
      sshHost: 'demo-devcontainer',
      id: 'existing-id',
      source: 'desktop',
      unknown: true
    })
    assert.deepStrictEqual(second.configs[2], {
      name: 'New demo',
      sshHost: 'new-demo-devcontainer',
      id: 'new-id',
      source: 'desktop'
    })
    assert.deepStrictEqual(second.trustedHosts, [
      'other-devcontainer',
      'demo-devcontainer',
      'new-demo-devcontainer'
    ])
  })

  test('removes by SSH host and untrusts the host', () => {
    const config = parseClaudeSshConfigs({
      configs: [
        {
          name: 'Demo',
          sshHost: 'demo-devcontainer',
          id: 'demo-id',
          source: 'desktop'
        },
        {
          name: 'Other',
          sshHost: 'other-devcontainer',
          id: 'other-id',
          source: 'desktop'
        }
      ],
      trustedHosts: ['demo-devcontainer', 'other-devcontainer']
    })

    assert.deepStrictEqual(removeClaudeSshConfigHost(config, {
      name: 'Demo',
      sshHost: 'demo-devcontainer'
    }), {
      configs: [
        {
          name: 'Other',
          sshHost: 'other-devcontainer',
          id: 'other-id',
          source: 'desktop'
        }
      ],
      trustedHosts: ['other-devcontainer']
    })
  })

  test('creates and updates Claude SSH config with backups', () => {
    const configPath = join(tempDir('claude-create'), 'Claude', 'ssh_configs.json')
    const first = installClaudeSshConfigHost({
      name: 'Demo',
      sshHost: 'demo-devcontainer'
    }, {
      configPath,
      now: new Date('2026-01-01T00:00:00.000Z'),
      createId: () => 'demo-id'
    })
    const second = installClaudeSshConfigHost({
      name: 'Demo',
      sshHost: 'demo-devcontainer'
    }, {
      configPath,
      now: new Date('2026-01-02T00:00:00.000Z'),
      createId: () => 'unused-id'
    })

    assert.deepStrictEqual(first, {
      configPath,
      changed: true
    })
    assert.deepStrictEqual(second, {
      configPath,
      changed: false
    })
    assert.deepStrictEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      configs: [
        {
          name: 'Demo',
          sshHost: 'demo-devcontainer',
          id: 'demo-id',
          source: 'desktop'
        }
      ],
      trustedHosts: ['demo-devcontainer']
    })

    const renamed = installClaudeSshConfigHost({
      name: 'Renamed demo',
      sshHost: 'demo-devcontainer'
    }, {
      configPath,
      now: new Date('2026-01-03T00:00:00.000Z')
    })

    assert.strictEqual(renamed.changed, true)
    assert.strictEqual(renamed.backupPath, `${configPath}.2026-01-03T00-00-00-000Z.bak`)
    assert.strictEqual(existsSync(renamed.backupPath), true)
    assert.strictEqual(parseClaudeSshConfigs(JSON.parse(readFileSync(configPath, 'utf8'))).configs[0]?.id, 'demo-id')
  })

  test('uninstalls Claude SSH config and writes a backup', () => {
    const configPath = join(tempDir('claude-uninstall'), 'ssh_configs.json')
    writeFileSync(configPath, `${JSON.stringify({
      configs: [
        {
          name: 'Demo',
          sshHost: 'demo-devcontainer',
          id: 'demo-id',
          source: 'desktop'
        }
      ],
      trustedHosts: ['demo-devcontainer']
    }, null, 2)}\n`)

    const result = uninstallClaudeSshConfigHost({
      name: 'Demo',
      sshHost: 'demo-devcontainer'
    }, {
      configPath,
      now: new Date('2026-01-01T00:00:00.000Z')
    })
    const second = uninstallClaudeSshConfigHost({
      name: 'Demo',
      sshHost: 'demo-devcontainer'
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
      configs: [],
      trustedHosts: []
    })
  })

  test('fails without rewriting invalid Claude SSH configs', () => {
    const invalidJsonPath = join(tempDir('claude-invalid-json'), 'ssh_configs.json')
    writeFileSync(invalidJsonPath, '{ invalid json')

    assert.throws(() => installClaudeSshConfigHost({
      name: 'Demo',
      sshHost: 'demo-devcontainer'
    }, { configPath: invalidJsonPath }), /Invalid Claude SSH config JSON/)
    assert.strictEqual(readFileSync(invalidJsonPath, 'utf8'), '{ invalid json')

    const invalidShapePath = join(tempDir('claude-invalid-shape'), 'ssh_configs.json')
    writeFileSync(invalidShapePath, '{"configs":[{"name":"Demo","sshHost":"demo-devcontainer"}],"trustedHosts":[]}\n')

    assert.throws(() => installClaudeSshConfigHost({
      name: 'Demo',
      sshHost: 'demo-devcontainer'
    }, { configPath: invalidShapePath }), /id must be a nonempty string/)
    assert.strictEqual(readFileSync(invalidShapePath, 'utf8'), '{"configs":[{"name":"Demo","sshHost":"demo-devcontainer"}],"trustedHosts":[]}\n')
  })
})

describe('packaged assets', () => {
  test('does not include generated SSH key material', () => {
    assert.strictEqual(existsSync(join(assetsDevcontainerDir, '.ssh')), false)
  })

  test('legacy shell SSH installer refuses malformed managed blocks', () => {
    const stateDir = tempDir('legacy-ssh-installer-state')
    const configPath = join(stateDir, 'config')
    const keyPath = join(stateDir, 'id_ed25519')
    const alias = 'legacy-demo-devcontainer'
    const malformed = [
      'Host github.com',
      '  User git',
      `# BEGIN ${alias} devcontainer ssh`,
      `Host ${alias}`,
      '  User node',
      'Host lirantaldotcom',
      '  User deploy',
      ''
    ].join('\n')

    writeFileSync(configPath, malformed)

    const result = spawnSync('bash', [
      join(assetsDevcontainerDir, 'ssh-config-install.sh'),
      '--alias',
      alias,
      '--config',
      configPath,
      '--quiet'
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEVCONTAINER_SSH_KEY_DIR: stateDir,
        DEVCONTAINER_SSH_KEY_PATH: keyPath
      }
    })

    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /without matching/)
    assert.strictEqual(readFileSync(configPath, 'utf8'), malformed)
  })

  test('legacy shell SSH installer refuses overlapping managed blocks', () => {
    const stateDir = tempDir('legacy-ssh-installer-overlap-state')
    const configPath = join(stateDir, 'config')
    const keyPath = join(stateDir, 'id_ed25519')
    const alias = 'legacy-demo-devcontainer'
    const otherAlias = 'lirantaldotcom-devcontainer'
    const overlapping = [
      'Host github.com',
      '  User git',
      `# BEGIN ${alias} devcontainer ssh`,
      `Host ${alias}`,
      `# BEGIN ${otherAlias} boxdown devcontainer ssh`,
      `Host ${otherAlias}`,
      `# END ${alias} devcontainer ssh`,
      `# END ${otherAlias} boxdown devcontainer ssh`,
      ''
    ].join('\n')

    writeFileSync(configPath, overlapping)

    const result = spawnSync('bash', [
      join(assetsDevcontainerDir, 'ssh-config-install.sh'),
      '--alias',
      alias,
      '--config',
      configPath,
      '--quiet'
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEVCONTAINER_SSH_KEY_DIR: stateDir,
        DEVCONTAINER_SSH_KEY_PATH: keyPath
      }
    })

    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /overlapping/)
    assert.strictEqual(readFileSync(configPath, 'utf8'), overlapping)
  })

  test('refreshes coding-agent CLIs from lifecycle hooks through updater utility', () => {
    const postCreate = readFileSync(join(assetsDevcontainerDir, 'hooks', 'post-create.sh'), 'utf8')
    const postStart = readFileSync(join(assetsDevcontainerDir, 'hooks', 'post-start.sh'), 'utf8')
    const gitConfigBootstrap = readFileSync(join(assetsDevcontainerDir, 'utils', 'git-config-bootstrap.sh'), 'utf8')
    const updater = readFileSync(join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh'), 'utf8')
    const codexWrapper = readFileSync(join(assetsDevcontainerDir, 'utils', 'codex-cli-update.sh'), 'utf8')

    assert.match(postCreate, /configure_global_git/)
    assert.ok(postCreate.indexOf('configure_global_git') < postCreate.indexOf('install_or_update_coding_agent_clis'))
    assert.match(postCreate, /git-config-bootstrap\.sh/)
    assert.match(postCreate, /install_or_update_coding_agent_clis/)
    assert.match(postCreate, /coding-agent-cli-update\.sh" install/)
    assert.match(postCreate, /BOXDOWN_PROGRESS: %s\\n/)
    assert.match(postCreate, /run_step "Installing coding-agent CLIs"/)
    assert.match(postStart, /coding-agent-cli-update\.sh" maybe-update/)
    assert.match(postStart, /run_step "Refreshing coding-agent CLIs"/)
    assert.match(gitConfigBootstrap, /url\.git@github\.com:\.insteadOf/)
    assert.match(gitConfigBootstrap, /credential\.https:\/\/github\.com\.helper/)
    assert.match(gitConfigBootstrap, /Preparing writable Git config/)
    assert.match(updater, /DEFAULT_AGENTS=\(codex claude\)/)
    assert.match(updater, /BOXDOWN_PROGRESS: %s\\n/)
    assert.match(updater, /codex update/)
    assert.match(updater, /opencode upgrade --method curl/)
    assert.match(updater, /link_opencode_binary/)
    assert.match(updater, /ln -sfn "\$\{source_path\}" "\$\{target_dir\}\/opencode"/)
    assert.match(updater, /claude update/)
    assert.match(updater, /antigravity\.google\/cli\/install\.sh/)
    assert.match(updater, /ensure_agent\(\)/)
    assert.doesNotMatch(updater, /--skip-path/)
    assert.match(codexWrapper, /coding-agent-cli-update\.sh" "\$\{1:-maybe-update\}" codex/)
  })

  test('legacy start script supports concise and verbose startup output', () => {
    const startScript = readFileSync(join(assetsDevcontainerDir, 'start.sh'), 'utf8')

    assert.match(startScript, /--verbose\s+Stream raw devcontainer, Docker, and hook output\./)
    assert.match(startScript, /BOXDOWN_PROGRESS=1/)
    assert.match(startScript, /print_progress_markers/)
    assert.match(startScript, /progress_section "Boxdown start"/)
    assert.match(startScript, /progress_set_steps/)
    assert.match(startScript, /progress_start_step/)
    assert.match(startScript, /progress_complete_step/)
    assert.match(startScript, /progress_fail_step/)
    assert.match(startScript, /progress_skip_step/)
    assert.match(startScript, /"devcontainer-start:Starting devcontainer"/)
    assert.match(startScript, /"ssh-runtime:Preparing container SSH runtime"/)
    assert.match(startScript, /"gh-auth-refresh:Refreshing GitHub CLI auth inside the devcontainer"/)
    assert.match(startScript, /elif ! supports_progress_tty/)
    assert.match(startScript, /progress_item "\$\{line#BOXDOWN_PROGRESS: \}"/)
    assert.match(startScript, /progress_end/)
    assert.match(startScript, /Rerun with --verbose to see full command output\./)
    assert.match(startScript, /stdout is reserved for SSH traffic/)
  })

  test('downloads the APM installer before executing it', () => {
    const postCreate = readFileSync(join(assetsDevcontainerDir, 'hooks', 'post-create.sh'), 'utf8')

    assert.match(postCreate, /install_apm\(\)/)
    assert.match(postCreate, /curl -fsSL https:\/\/aka\.ms\/apm-unix -o "\$\{installer\}"/)
    assert.match(postCreate, /could not download APM installer; skipping APM/)
    assert.doesNotMatch(postCreate, /curl -sSL https:\/\/aka\.ms\/apm-unix \| sh/)
  })

  test('installs baseline Python from apt instead of the Python feature', () => {
    const pythonFeatureRef = 'ghcr.io/devcontainers/features/python@sha256:fbcad6955caeecc5ad3f7886baf652e25cba5225a6c4c2287c536de2e5607511'
    const devcontainerJson = readFileSync(join(assetsDevcontainerDir, 'devcontainer.json'), 'utf8')
    const devcontainerConfig = parseJsonc<{
      features?: Record<string, unknown>
      overrideFeatureInstallOrder?: string[]
    }>(devcontainerJson)
    const postCreate = readFileSync(join(assetsDevcontainerDir, 'hooks', 'post-create.sh'), 'utf8')
    const pythonBootstrap = readFileSync(join(assetsDevcontainerDir, 'utils', 'python-bootstrap.sh'), 'utf8')

    assert.match(devcontainerJson, /roughly 900MB/)
    assert.match(devcontainerJson, /heavy Dev Containers Python feature layer/)
    assert.ok(!Object.keys(devcontainerConfig.features ?? {}).includes(pythonFeatureRef))
    assert.ok(!(devcontainerConfig.overrideFeatureInstallOrder ?? []).includes(pythonFeatureRef))
    assert.match(postCreate, /install_python_runtime/)
    assert.ok(postCreate.indexOf('install_openssh_server') < postCreate.indexOf('install_python_runtime'))
    assert.ok(postCreate.indexOf('install_python_runtime') < postCreate.indexOf('install_1password_cli'))
    assert.match(postCreate, /python-bootstrap\.sh" install/)
    assert.match(pythonBootstrap, /python3 python3-venv python3-pip pipx/)
    assert.match(pythonBootstrap, /apt-get install -y --no-install-recommends/)
  })

  test('installs only eager coding-agent CLIs by default', () => {
    const updaterPath = join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh')
    const stateDir = tempDir('eager-agent-update-state')
    const home = tempDir('eager-agent-home')
    const codexHome = join(home, '.codex')
    const codexInstallerPath = join(tempDir('eager-codex-installer'), 'install.sh')
    const claudeInstallerPath = join(tempDir('eager-claude-installer'), 'install.sh')
    const failInstallerPath = join(tempDir('lazy-agent-fail-installer'), 'install.sh')

    writeFileSync(codexInstallerPath, [
      '#!/usr/bin/env sh',
      'set -e',
      'mkdir -p "${CODEX_HOME}/packages/standalone/current/bin"',
      'touch "${CODEX_HOME}/packages/standalone/current/bin/codex"'
    ].join('\n'))
    writeFileSync(claudeInstallerPath, [
      '#!/usr/bin/env bash',
      'set -e',
      'mkdir -p "${HOME}/.local/bin"',
      'touch "${HOME}/.local/bin/claude"'
    ].join('\n'))
    writeFileSync(failInstallerPath, [
      '#!/usr/bin/env bash',
      'exit 37'
    ].join('\n'))

    execFileSync('bash', [updaterPath, 'install'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        CODEX_HOME: codexHome,
        BOXDOWN_CODEX_INSTALL_URL: `file://${codexInstallerPath}`,
        BOXDOWN_CLAUDE_INSTALL_URL: `file://${claudeInstallerPath}`,
        BOXDOWN_OPENCODE_INSTALL_URL: `file://${failInstallerPath}`,
        BOXDOWN_ANTIGRAVITY_INSTALL_URL: `file://${failInstallerPath}`,
        BOXDOWN_CODING_AGENT_UPDATE_STATE_DIR: stateDir
      },
      stdio: 'pipe'
    })

    assert.strictEqual(existsSync(join(stateDir, 'codex.stamp')), true)
    assert.strictEqual(existsSync(join(stateDir, 'claude.stamp')), true)
    assert.strictEqual(existsSync(join(stateDir, 'opencode.stamp')), false)
    assert.strictEqual(existsSync(join(stateDir, 'antigravity.stamp')), false)
  })

  test('runs Antigravity installer without unsupported path flags', () => {
    const updaterPath = join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh')
    const stateDir = tempDir('antigravity-update-state')
    const installerPath = join(tempDir('antigravity-installer'), 'install.sh')
    const argsPath = join(tempDir('antigravity-args'), 'args.txt')
    const cacheDir = tempDir('antigravity-cache')

    writeFileSync(installerPath, [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$#" > "${BOXDOWN_FAKE_ANTIGRAVITY_ARGS_FILE}"',
      'if [ "$#" -gt 0 ]; then',
      '  printf "%s\\n" "$@" >> "${BOXDOWN_FAKE_ANTIGRAVITY_ARGS_FILE}"',
      'fi',
      'mkdir -p "${BOXDOWN_ANTIGRAVITY_CACHE_DIR}/staging"'
    ].join('\n'))

    execFileSync('bash', [updaterPath, 'update-now', 'antigravity'], {
      env: {
        ...process.env,
        BOXDOWN_ANTIGRAVITY_INSTALL_URL: `file://${installerPath}`,
        BOXDOWN_ANTIGRAVITY_CACHE_DIR: cacheDir,
        BOXDOWN_CODING_AGENT_UPDATE_STATE_DIR: stateDir,
        BOXDOWN_FAKE_ANTIGRAVITY_ARGS_FILE: argsPath
      },
      stdio: 'pipe'
    })

    assert.strictEqual(readFileSync(argsPath, 'utf8'), '0\n')
    assert.strictEqual(existsSync(join(cacheDir, 'staging')), false)
    assert.strictEqual(existsSync(join(stateDir, 'antigravity.stamp')), true)
  })

  test('prepares Codex home before running the Codex installer', () => {
    const updaterPath = join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh')
    const stateDir = tempDir('codex-home-update-state')
    const codexHome = join(tempDir('codex-home'), '.codex')
    const installerPath = join(tempDir('codex-installer'), 'install.sh')
    const resultPath = join(tempDir('codex-installer-result'), 'result.txt')

    writeFileSync(installerPath, [
      '#!/usr/bin/env sh',
      'test -d "${CODEX_HOME}"',
      'test -w "${CODEX_HOME}"',
      'printf "%s\\n" "${CODEX_HOME}" > "${BOXDOWN_FAKE_CODEX_HOME_RESULT}"'
    ].join('\n'))

    execFileSync('bash', [updaterPath, 'update-now', 'codex'], {
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        CODEX_HOME: codexHome,
        BOXDOWN_CODEX_INSTALL_URL: `file://${installerPath}`,
        BOXDOWN_CODING_AGENT_UPDATE_STATE_DIR: stateDir,
        BOXDOWN_FAKE_CODEX_HOME_RESULT: resultPath
      },
      stdio: 'pipe'
    })

    assert.strictEqual(readFileSync(resultPath, 'utf8'), `${codexHome}\n`)
    assert.strictEqual(existsSync(join(stateDir, 'codex.stamp')), true)
  })

  test('prunes old Codex standalone releases after install', () => {
    const updaterPath = join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh')
    const stateDir = tempDir('codex-prune-update-state')
    const codexHome = join(tempDir('codex-prune-home'), '.codex')
    const installerPath = join(tempDir('codex-prune-installer'), 'install.sh')

    writeFileSync(installerPath, [
      '#!/usr/bin/env sh',
      'set -e',
      'standalone="${CODEX_HOME}/packages/standalone"',
      'mkdir -p "${standalone}/releases/0.142.2-aarch64-unknown-linux-musl"',
      'mkdir -p "${standalone}/releases/0.142.3-aarch64-unknown-linux-musl"',
      'mkdir -p "${standalone}/releases/0.142.4-aarch64-unknown-linux-musl"',
      'mkdir -p "${standalone}/releases/0.142.5-aarch64-unknown-linux-musl"',
      'ln -sfn "releases/0.142.5-aarch64-unknown-linux-musl" "${standalone}/current"'
    ].join('\n'))

    execFileSync('bash', [updaterPath, 'update-now', 'codex'], {
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        CODEX_HOME: codexHome,
        BOXDOWN_CODEX_INSTALL_URL: `file://${installerPath}`,
        BOXDOWN_CODING_AGENT_UPDATE_STATE_DIR: stateDir
      },
      stdio: 'pipe'
    })

    const releasesDir = join(codexHome, 'packages', 'standalone', 'releases')

    assert.strictEqual(existsSync(join(releasesDir, '0.142.5-aarch64-unknown-linux-musl')), true)
    assert.strictEqual(existsSync(join(releasesDir, '0.142.4-aarch64-unknown-linux-musl')), false)
    assert.strictEqual(existsSync(join(releasesDir, '0.142.3-aarch64-unknown-linux-musl')), false)
    assert.strictEqual(existsSync(join(releasesDir, '0.142.2-aarch64-unknown-linux-musl')), false)
    assert.strictEqual(existsSync(join(stateDir, 'codex.stamp')), true)
  })

  test('prunes old Claude Code versions after install', () => {
    const updaterPath = join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh')
    const stateDir = tempDir('claude-prune-update-state')
    const home = tempDir('claude-prune-home')
    const installerPath = join(tempDir('claude-prune-installer'), 'install.sh')

    writeFileSync(installerPath, [
      '#!/usr/bin/env bash',
      'set -e',
      'versions_dir="${HOME}/.local/share/claude/versions"',
      'mkdir -p "${versions_dir}/2.1.195"',
      'mkdir -p "${versions_dir}/2.1.196"',
      'mkdir -p "${versions_dir}/2.1.197"',
      'mkdir -p "${HOME}/.local/bin"',
      'ln -sfn "${versions_dir}/2.1.197" "${HOME}/.local/bin/claude"'
    ].join('\n'))

    execFileSync('bash', [updaterPath, 'update-now', 'claude'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        BOXDOWN_CLAUDE_INSTALL_URL: `file://${installerPath}`,
        BOXDOWN_CODING_AGENT_UPDATE_STATE_DIR: stateDir
      },
      stdio: 'pipe'
    })

    const versionsDir = join(home, '.local', 'share', 'claude', 'versions')

    assert.strictEqual(existsSync(join(versionsDir, '2.1.197')), true)
    assert.strictEqual(existsSync(join(versionsDir, '2.1.196')), false)
    assert.strictEqual(existsSync(join(versionsDir, '2.1.195')), false)
    assert.strictEqual(existsSync(join(stateDir, 'claude.stamp')), true)
  })

  test('removes OpenCode installer temp directories after install', () => {
    const updaterPath = join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh')
    const stateDir = tempDir('opencode-clean-update-state')
    const home = tempDir('opencode-clean-home')
    const tmpParent = tempDir('opencode-clean-tmp')
    const installerPath = join(tempDir('opencode-clean-installer'), 'install.sh')

    writeFileSync(installerPath, [
      '#!/usr/bin/env bash',
      'set -e',
      'mkdir -p "${HOME}/.opencode/bin"',
      'touch "${HOME}/.opencode/bin/opencode"',
      'chmod +x "${HOME}/.opencode/bin/opencode"',
      'mkdir -p "${BOXDOWN_OPENCODE_INSTALL_TMP_PARENT}/opencode_install_123"',
      'mkdir -p "${BOXDOWN_OPENCODE_INSTALL_TMP_PARENT}/opencode_install_456"'
    ].join('\n'))

    execFileSync('bash', [updaterPath, 'update-now', 'opencode'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        BOXDOWN_OPENCODE_INSTALL_URL: `file://${installerPath}`,
        BOXDOWN_OPENCODE_INSTALL_TMP_PARENT: tmpParent,
        BOXDOWN_CODING_AGENT_UPDATE_STATE_DIR: stateDir
      },
      stdio: 'pipe'
    })

    assert.strictEqual(existsSync(join(tmpParent, 'opencode_install_123')), false)
    assert.strictEqual(existsSync(join(tmpParent, 'opencode_install_456')), false)
    assert.strictEqual(readlinkSync(join(home, '.local', 'bin', 'opencode')), join(home, '.opencode', 'bin', 'opencode'))
    assert.strictEqual(existsSync(join(stateDir, 'opencode.stamp')), true)
  })

  test('ensures lazy OpenCode install even when the update stamp is fresh', () => {
    const updaterPath = join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh')
    const stateDir = tempDir('opencode-ensure-state')
    const home = tempDir('opencode-ensure-home')
    const installerPath = join(tempDir('opencode-ensure-installer'), 'install.sh')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'opencode.stamp'), '')

    writeFileSync(installerPath, [
      '#!/usr/bin/env bash',
      'set -e',
      'mkdir -p "${HOME}/.opencode/bin"',
      'printf "#!/usr/bin/env bash\\nexit 0\\n" > "${HOME}/.opencode/bin/opencode"',
      'chmod +x "${HOME}/.opencode/bin/opencode"'
    ].join('\n'))

    execFileSync('bash', [updaterPath, 'ensure', 'opencode'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        BOXDOWN_OPENCODE_INSTALL_URL: `file://${installerPath}`,
        BOXDOWN_CODING_AGENT_UPDATE_STATE_DIR: stateDir,
        BOXDOWN_CODING_AGENT_UPDATE_INTERVAL_SECONDS: '999999'
      },
      stdio: 'pipe'
    })

    assert.strictEqual(existsSync(join(home, '.opencode', 'bin', 'opencode')), true)
    assert.strictEqual(readlinkSync(join(home, '.local', 'bin', 'opencode')), join(home, '.opencode', 'bin', 'opencode'))
    assert.strictEqual(existsSync(join(stateDir, 'opencode.stamp')), true)
  })

  test('allows lazy OpenCode launch when update fails but the binary exists', () => {
    const updaterPath = join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh')
    const stateDir = tempDir('opencode-ensure-existing-state')
    const home = tempDir('opencode-ensure-existing-home')
    const installerPath = join(tempDir('opencode-ensure-fail-installer'), 'install.sh')
    const opencodeBinDir = join(home, '.opencode', 'bin')
    const opencodeBin = join(opencodeBinDir, 'opencode')
    mkdirSync(opencodeBinDir, { recursive: true })
    writeFileSync(opencodeBin, [
      '#!/usr/bin/env bash',
      'exit 42'
    ].join('\n'))
    chmodSync(opencodeBin, 0o755)
    writeFileSync(installerPath, [
      '#!/usr/bin/env bash',
      'exit 37'
    ].join('\n'))

    execFileSync('bash', [updaterPath, 'ensure', 'opencode'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        BOXDOWN_OPENCODE_INSTALL_URL: `file://${installerPath}`,
        BOXDOWN_CODING_AGENT_UPDATE_STATE_DIR: stateDir,
        BOXDOWN_CODING_AGENT_UPDATE_INTERVAL_SECONDS: '0'
      },
      stdio: 'pipe'
    })

    assert.strictEqual(existsSync(opencodeBin), true)
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
