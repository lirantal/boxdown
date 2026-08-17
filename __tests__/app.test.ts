import assert from 'node:assert'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { claudeSshConfigEntryForWorkspace, defaultClaudeSshConfigsPath, installClaudeSshConfigHost, mergeClaudeSshConfigHost, parseClaudeSshConfigs, removeClaudeSshConfigHost, uninstallClaudeSshConfigHost } from '../src/claude-app-config.ts'
import { canonicalCodexRemotePathForWorkspace, codexDiscoveredRemoteHostId, codexProjectEntryForWorkspace, defaultCodexAppConfigPath, defaultCodexGlobalStatePath, installCodexAppConfigProject, installCodexGlobalStateProject, legacyCodexRemotePathForWorkspace, mergeCodexAppProject, normalizeCodexGlobalStateProject, parseCodexAppConfig, removeCodexAppProject, removeCodexGlobalStateProject, uninstallCodexAppConfigProject, uninstallCodexGlobalStateProject } from '../src/codex-app-config.ts'
import { cursorIntegrationPath, installCursorSshTarget } from '../src/cursor-app-config.ts'
import { codingAgentBinary, codingAgentFromCommand, type CodingAgentCli } from '../src/coding-agents.ts'
import { AGENT_PROFILES, agentProfileMarker, isAgentProfile, parseAgentProfileMarker, resolveAgentProfile, type AgentProfile, type ContainerAgentProfile } from '../src/agent-profile.ts'
import { color, formatPromptEnd, formatPromptTitle, promptRail, selectedMark } from '../src/cli-style.ts'
import { buildGeneratedDevcontainerConfig, publishContainerPortFromConfig, readGeneratedAgentProfile, sourcePathIsInside, writeGeneratedDevcontainerConfig } from '../src/config.ts'
import { BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_AGENTS_DIR, BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CLAUDE_CREDENTIALS_PATH, BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CODEX_AUTH_PATH, BOXDOWN_CONTAINER_AGENTS_DIR, BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH, BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH, BOXDOWN_CONTAINER_CLAUDE_DIR, BOXDOWN_CONTAINER_CODEX_AUTH_PATH, BOXDOWN_CONTAINER_CODEX_DIR, BOXDOWN_CONTAINER_DEVCONTAINER_DIR, BOXDOWN_CONTAINER_GITCONFIG_PATH, BOXDOWN_CONTAINER_HOST_GITCONFIG_DIR, BOXDOWN_CONTAINER_SECRET_ENV_BOOTSTRAP, BOXDOWN_CONTAINER_SECRET_ENV_DIR, BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH, BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR, BOXDOWN_CONTAINER_TOOLCHAINS_DIR, DEVCONTAINER_CLI_VERSION } from '../src/constants.ts'
import { codingAgentDevcontainerExecArgs, findDockerImageConsumers, inspectContainerAgentProfile, isPublishedBoxdownImage, parseDockerInspectImage, removeDockerImageIfUnused, sshdProxyDockerArgs, sshTunnelArgs, startDevcontainer, type DockerCommandRunner } from '../src/devcontainer.ts'
import { resolveDevcontainerCli } from '../src/devcontainer-cli.ts'
import { doctorHasFailures, formatDoctorText, runDoctorChecks, type DoctorCommandResult, type DoctorCommandRunner } from '../src/doctor.ts'
import { parseSshPublicKey, reportGitSigningPlan, resolveConfiguredSshSigningKey, resolveGitSigningPlan, selectGitSigningKey, type GitSigningPlan, type GitSigningReason } from '../src/git-signing.ts'
import { canonicalGithubRemoteUrl, configureWorkspaceGithubGitAuth } from '../src/github-git-auth.ts'
import { parseJsonc } from '../src/jsonc.ts'
import { createWorkspaceListEntries, formatWorkspaceListDetailsText, formatWorkspaceListText } from '../src/list.ts'
import { createWorkspaceCommandLogger, redactKnownSecretEnvironmentAssignments, withLoggedProcessOutput } from '../src/logging.ts'
import { commandRequiresContainerRuntime, commandWritesWorkspaceMetadata, parseCliArgs, parseTunnelPort, parseTunnelPortList, prepareContainerLifecycle, runCli, runContainerRuntimePreflight, setupWorkspace, USAGE, type BoxdownCommand } from '../src/main.ts'
import { listWorkspaceMetadata, readWorkspaceMetadata, recordLegacyImageMigrationNotice, recordWorkspaceDockerImage, workspaceMetadataPath, writeWorkspaceMetadata } from '../src/metadata.ts'
import { readPackageVersion } from '../src/package-info.ts'
import { createWorkspaceContext, defaultHostClaudeCredentialsPath, defaultHostClaudeDir, defaultHostCodexDir } from '../src/paths.ts'
import { createPurgePlan, formatPurgePlanText } from '../src/purge.ts'
import { promptConfirm, promptMultiSelect, promptSelect, promptText, type PromptInput, type PromptOutput } from '../src/interactive-prompts.ts'
import { buildHostToolPath, runBuffered, runInteractive } from '../src/process.ts'
import { createProgress, formatCommandFailure, resolveProgressMode, runProgressCommand } from '../src/progress.ts'
import { DEFAULT_TTY_MAX_COLUMNS, interactiveCommandScript, interactiveShellEnvArgs, interactiveShellScript } from '../src/shell.ts'
import { buildSshConfigBlock, defaultSshAlias, defaultSshConfigPath, installSshConfig, removeSshConfigBlock, replaceSshConfigBlock, uninstallSshConfig } from '../src/ssh-config.ts'
import type { AppInstallResult, RemoteAccessInstallReport, SshAliasInstallResult } from '../src/ssh-install-result.ts'
import { installSshInstallTarget, uninstallSshInstallTarget, uninstallWorkspaceSshInstallTarget } from '../src/ssh-install-targets.ts'
import { createStatusInfo, formatStatusText, inspectSshConfigStatus, parseDockerPsJsonLines, statusIsHealthy } from '../src/status.ts'
import { ensureHostSshKey } from '../src/ssh-key.ts'
import { resolveSetupToolchains } from '../src/setup-toolchains.ts'
import { detectToolchains } from '../src/toolchains/detect.ts'
import { parseToolchainSelector, readToolchainPlan, resolveToolchainPlan, writeToolchainPlan } from '../src/toolchains/plan.ts'
import type { ToolchainPlan } from '../src/toolchains/types.ts'

const assetsDevcontainerDir = fileURLToPath(new URL('../assets/devcontainer', import.meta.url))
const copiedAuthContainerProfile: ContainerAgentProfile = { profile: 'auth', mode: 'copy' }
const legacyFullContainerProfile: ContainerAgentProfile = { profile: 'full', mode: 'legacy' }
const liveFullContainerProfile: ContainerAgentProfile = { profile: 'full', mode: 'live' }

function tempDir (name: string): string {
  return mkdtempSync(join(tmpdir(), `boxdown-${name}-`))
}

function setupSshResult (alias = 'demo-devcontainer'): SshAliasInstallResult {
  return {
    kind: 'ssh',
    disposition: 'installed',
    summary: 'SSH alias configured',
    alias,
    configPath: '/Users/demo/.ssh/config',
    identityPath: '/Users/demo/.local/share/boxdown/id_ed25519',
    validationCommand: `ssh ${alias} 'whoami && pwd'`,
    details: [
      { label: 'SSH alias', value: alias },
      { label: 'SSH config', value: '/Users/demo/.ssh/config' },
      { label: 'Identity file', value: '/Users/demo/.local/share/boxdown/id_ed25519' }
    ]
  }
}

function setupAppResult (target: 'codex' | 'cursor'): AppInstallResult {
  if (target === 'codex') {
    return {
      kind: 'app',
      target,
      appLabel: 'ChatGPT',
      disposition: 'installed',
      summary: 'ChatGPT configured',
      warnings: [],
      action: { label: 'Restart ChatGPT, then open the remote project demo.' },
      details: []
    }
  }

  return {
    kind: 'app',
    target,
    appLabel: 'Cursor',
    disposition: 'installed',
    summary: 'Cursor configured',
    warnings: [],
    action: {
      label: 'Open this project in Cursor:',
      command: "cursor --folder-uri 'vscode-remote://ssh-remote+demo-devcontainer/workspaces/demo'"
    },
    details: [
      { label: 'Cursor settings', value: '/Users/demo/Library/Application Support/Cursor/User/settings.json' },
      { label: 'Cursor remote folder URI', value: 'vscode-remote://ssh-remote+demo-devcontainer/workspaces/demo' }
    ]
  }
}

function setupCursorWarningReport (): RemoteAccessInstallReport {
  const cursor = setupAppResult('cursor')
  cursor.warnings.push({
    message: 'Could not verify Cursor Remote SSH.',
    remediation: {
      label: 'Install the Cursor Remote SSH extension:',
      command: 'cursor --install-extension anysphere.remote-ssh'
    }
  })
  return {
    ssh: setupSshResult(),
    apps: [cursor],
    failures: [],
    skipped: [],
    notices: []
  }
}

function toolchainPlanFor (context: ReturnType<typeof createWorkspaceContext>, selector = 'node'): ToolchainPlan {
  return resolveToolchainPlan({
    workspaceId: context.workspaceId,
    detections: [],
    selectors: [parseToolchainSelector(selector)],
    selectionSource: 'cli'
  })
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
  agentProfileMarker?: string
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
    '    while IFS="$(printf \'\\t\')" read -r folder id container_state remove_exit_code image_id image_name inspect_exit_code image_remove_exit_code agent_profile_marker; do',
    '      printf \'{"ID":"%s","Names":"%s","State":"%s","Status":"%s","Labels":"devcontainer.local_folder=%s"}\\n\' "$id" "$id" "$container_state" "$container_state" "$folder"',
    '    done < "${BOXDOWN_FAKE_DOCKER_STATE}"',
    '    exit 0',
    '  fi',
    '  if [[ "$filter" == ancestor=* ]]; then',
    '    if [ "${BOXDOWN_FAKE_DOCKER_ANCESTOR_EXIT_CODE:-0}" != "0" ]; then',
    '      exit "${BOXDOWN_FAKE_DOCKER_ANCESTOR_EXIT_CODE}"',
    '    fi',
    '    image_id="${filter#ancestor=}"',
    '    while IFS="$(printf \'\\t\')" read -r folder id container_state remove_exit_code recorded_image_id image_name inspect_exit_code image_remove_exit_code agent_profile_marker; do',
    '      if [ "$recorded_image_id" = "$image_id" ]; then',
    '        printf \'%s\\n\' "$id"',
    '      fi',
    '    done < "${BOXDOWN_FAKE_DOCKER_STATE}"',
    '    exit 0',
    '  fi',
    '  workspace="${filter#label=devcontainer.local_folder=}"',
    '  if [ "$workspace" = "$filter" ]; then',
    '    exit 0',
    '  fi',
    '  include_stopped=0',
    '  for arg in "$@"; do',
    '    if [ "$arg" = "-a" ]; then',
    '      include_stopped=1',
    '    fi',
    '  done',
    '  while IFS="$(printf \'\\t\')" read -r folder id container_state remove_exit_code image_id image_name inspect_exit_code image_remove_exit_code agent_profile_marker; do',
    '    if [ "$folder" = "$workspace" ]; then',
    '      if [ "$include_stopped" = "0" ] && [ "$container_state" != "running" ]; then',
    '        continue',
    '      fi',
    '      if [[ "$*" == *\'{{.ID}}\'* ]]; then',
    '        printf \'%s\\n\' "$id"',
    '        exit 0',
    '      fi',
    '      printf \'{"ID":"%s","Names":"%s","State":"%s","Status":"%s","Labels":"devcontainer.local_folder=%s"}\\n\' "$id" "$id" "$container_state" "$container_state" "$folder"',
    '      exit 0',
    '    fi',
    '  done < "${BOXDOWN_FAKE_DOCKER_STATE}"',
    '  exit 0',
    'fi',
    'if [ "${1:-}" = "inspect" ]; then',
    '  id="${@: -1}"',
    '  while IFS="$(printf \'\\t\')" read -r folder container_id container_state remove_exit_code image_id image_name inspect_exit_code image_remove_exit_code agent_profile_marker; do',
    '    if [ "$container_id" = "$id" ]; then',
    '      if [ "${inspect_exit_code:-0}" != "0" ]; then',
    '        exit "$inspect_exit_code"',
    '      fi',
    "      if [[ \"$*\" == *'{{json .Id}}|{{json .Name}}|{{json .Image}}'* ]]; then",
    "        printf '\"%s\"|\"/%s\"|\"%s\"\\n' \"$container_id\" \"$container_id\" \"${image_id:-sha256:${container_id}-image}\"",
    '      else',
    "        printf '\"%s\"|\"%s\"\\n' \"${image_id:-sha256:${container_id}-image}\" \"${image_name:-boxdown-test:${container_id}}\"",
    '      fi',
    '      exit 0',
    '    fi',
    '  done < "${BOXDOWN_FAKE_DOCKER_STATE}"',
    '  exit 1',
    'fi',
    'if [ "${1:-}" = "exec" ] && [ "${3:-}" = "cat" ] && [ "${4:-}" = "/opt/boxdown/state/agent-profile" ]; then',
    '  id="${2:-}"',
    '  while IFS="$(printf \'\\t\')" read -r folder container_id container_state remove_exit_code image_id image_name inspect_exit_code image_remove_exit_code agent_profile_marker; do',
    '    if [ "$container_id" = "$id" ]; then',
    '      if [ "$container_state" != "running" ]; then',
    '        exit 1',
    '      fi',
    '      if [ "${agent_profile_marker:--}" = "-" ]; then',
    '        exit 1',
    '      fi',
    '      printf \'%s\\n\' "$agent_profile_marker"',
    '      exit 0',
    '    fi',
    '  done < "${BOXDOWN_FAKE_DOCKER_STATE}"',
    '  exit 1',
    'fi',
    'if [ "${1:-}" = "rm" ]; then',
    '  id="${@: -1}"',
    '  while IFS="$(printf \'\\t\')" read -r folder container_id container_state remove_exit_code image_id image_name inspect_exit_code image_remove_exit_code agent_profile_marker; do',
    '    if [ "$container_id" = "$id" ]; then',
    '      exit "${remove_exit_code:-0}"',
    '    fi',
    '  done < "${BOXDOWN_FAKE_DOCKER_STATE}"',
    '  exit 0',
    'fi',
    'if [ "${1:-}" = "image" ] && [ "${2:-}" = "rm" ]; then',
    '  image_id="${@: -1}"',
    '  while IFS="$(printf \'\\t\')" read -r folder container_id container_state remove_exit_code recorded_image_id image_name inspect_exit_code image_remove_exit_code agent_profile_marker; do',
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
    String(workspace.imageRemoveExitCode ?? 0),
    workspace.agentProfileMarker ?? '-'
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

function sequenceDockerRunner (
  results: Array<{ code: number, stdout: string, stderr: string }>,
  calls: string[][]
): DockerCommandRunner {
  return async (args) => {
    calls.push(args)
    const result = results.shift()
    assert.ok(result !== undefined, `Unexpected Docker call: ${args.join(' ')}`)
    return result
  }
}

test('finds only containers using the exact Docker image ID', async () => {
  const calls: string[][] = []
  const runCommand = sequenceDockerRunner([
    { code: 0, stdout: 'exact-container\ndescendant-container\n', stderr: '' },
    {
      code: 0,
      stdout: '"exact-container"|"/exact-name"|"sha256:shared"\n',
      stderr: ''
    },
    {
      code: 0,
      stdout: '"descendant-container"|"/descendant-name"|"sha256:child"\n',
      stderr: ''
    }
  ], calls)

  assert.deepStrictEqual(await findDockerImageConsumers('sha256:shared', {
    excludeContainerIds: ['excluded-container'],
    runCommand
  }), [
    { id: 'exact-container', name: 'exact-name' }
  ])
  assert.deepStrictEqual(calls[0], [
    'ps', '-aq', '--filter', 'ancestor=sha256:shared'
  ])
})

test('removes an unused Docker image without force', async () => {
  const calls: string[][] = []
  const result = await removeDockerImageIfUnused('sha256:unused', {
    runCommand: sequenceDockerRunner([
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: 'Deleted: sha256:unused\n', stderr: '' }
    ], calls)
  })

  assert.deepStrictEqual(result, { status: 'removed' })
  assert.deepStrictEqual(calls[1], ['image', 'rm', 'sha256:unused'])
})

test('retains a Docker image already used by another container', async () => {
  const calls: string[][] = []
  const result = await removeDockerImageIfUnused('sha256:shared', {
    runCommand: sequenceDockerRunner([
      { code: 0, stdout: 'consumer-1\n', stderr: '' },
      { code: 0, stdout: '"consumer-1"|"/peer"|"sha256:shared"\n', stderr: '' }
    ], calls)
  })

  assert.deepStrictEqual(result, {
    status: 'retained-in-use',
    consumers: [{ id: 'consumer-1', name: 'peer' }]
  })
  assert.strictEqual(calls.some(args => args[0] === 'image'), false)
})

test('classifies a race-time image consumer after removal fails', async () => {
  const calls: string[][] = []
  const result = await removeDockerImageIfUnused('sha256:raced', {
    runCommand: sequenceDockerRunner([
      { code: 0, stdout: '', stderr: '' },
      { code: 1, stdout: '', stderr: 'conflict' },
      { code: 0, stdout: 'late-container\n', stderr: '' },
      { code: 0, stdout: '"late-container"|"/late-peer"|"sha256:raced"\n', stderr: '' }
    ], calls)
  })

  assert.deepStrictEqual(result, {
    status: 'retained-in-use',
    consumers: [{ id: 'late-container', name: 'late-peer' }]
  })
})

test('does not attempt image removal when usage discovery fails', async () => {
  const calls: string[][] = []
  await assert.rejects(
    removeDockerImageIfUnused('sha256:unknown', {
      runCommand: sequenceDockerRunner([
        { code: 1, stdout: '', stderr: 'daemon error' }
      ], calls)
    }),
    /Could not find Docker containers using image sha256:unknown/
  )
  assert.strictEqual(calls.some(args => args[0] === 'image'), false)
})

test('treats an already absent unused Docker image as success', async () => {
  const calls: string[][] = []
  const result = await removeDockerImageIfUnused('sha256:absent', {
    runCommand: sequenceDockerRunner([
      { code: 0, stdout: '', stderr: '' },
      { code: 1, stdout: '', stderr: 'Error: No such image: sha256:absent' }
    ], calls)
  })

  assert.deepStrictEqual(result, { status: 'absent' })
})

test('does not classify an unrelated not-found image removal failure as absent', async () => {
  const calls: string[][] = []
  await assert.rejects(
    removeDockerImageIfUnused('sha256:content-store-error', {
      runCommand: sequenceDockerRunner([
        { code: 0, stdout: '', stderr: '' },
        { code: 1, stdout: '', stderr: 'content store: blob not found' },
        { code: 0, stdout: '', stderr: '' }
      ], calls)
    }),
    /Could not remove Docker image sha256:content-store-error/
  )
})

test('fails an unrelated Docker image-removal error with no consumers', async () => {
  const calls: string[][] = []
  await assert.rejects(
    removeDockerImageIfUnused('sha256:broken', {
      runCommand: sequenceDockerRunner([
        { code: 0, stdout: '', stderr: '' },
        { code: 1, stdout: '', stderr: 'unexpected daemon failure' },
        { code: 0, stdout: '', stderr: '' }
      ], calls)
    }),
    /Could not remove Docker image sha256:broken/
  )
})

function fakeCursorCli (extensions = 'anysphere.remote-ssh', exitCode = 0): {
  env: NodeJS.ProcessEnv
  logPath: string
} {
  const binDir = tempDir('fake-cursor-bin')
  const logPath = join(tempDir('fake-cursor-log'), 'calls.log')
  const cursorPath = join(binDir, 'cursor')
  const script = [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "${BOXDOWN_FAKE_CURSOR_LOG}"',
    'if [ "${1:-}" = "--list-extensions" ]; then',
    '  printf "%s\\n" "${BOXDOWN_FAKE_CURSOR_EXTENSIONS:-}"',
    '  exit "${BOXDOWN_FAKE_CURSOR_EXIT_CODE:-0}"',
    'fi',
    'exit 88'
  ].join('\n')

  writeFileSync(cursorPath, script)
  chmodSync(cursorPath, 0o755)

  return {
    env: {
      BOXDOWN_HOST_PATH_PREFIX: binDir,
      BOXDOWN_FAKE_CURSOR_LOG: logPath,
      BOXDOWN_FAKE_CURSOR_EXTENSIONS: extensions,
      BOXDOWN_FAKE_CURSOR_EXIT_CODE: String(exitCode)
    },
    logPath
  }
}

function fakeCursorCalls (logPath: string): string[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').trim().split(/\r?\n/u).filter((line) => line.length > 0)
}

function cursorRemotePlatforms (settingsPath: string): Record<string, string> {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
  return settings['remote.SSH.remotePlatform'] as Record<string, string>
}

async function inspectFakeContainerAgentProfile (containerId: string): Promise<ContainerAgentProfile | undefined> {
  return inspectContainerAgentProfile(containerId)
}

function updateFakeDockerContainer (
  env: NodeJS.ProcessEnv,
  containerId: string,
  updates: { workspace?: string, containerState?: string, agentProfileMarker?: string }
): void {
  const statePath = env.BOXDOWN_FAKE_DOCKER_STATE
  assert.notStrictEqual(statePath, undefined)
  const lines = readFileSync(statePath as string, 'utf8').trimEnd().split('\n')
  const updated = lines.map((line) => {
    const fields = line.split('\t')
    if (fields[1] !== containerId) return line
    if (updates.workspace !== undefined) fields[0] = realpathSync(updates.workspace)
    if (updates.containerState !== undefined) fields[2] = updates.containerState
    if (updates.agentProfileMarker !== undefined) fields[8] = updates.agentProfileMarker
    return fields.join('\t')
  })
  writeFileSync(statePath as string, `${updated.join('\n')}\n`)
}

function recordProgressStepEvents (
  progress: ReturnType<typeof createProgress>,
  stepId: string
): string[] {
  const events: string[] = []
  const startStep = progress.startStep.bind(progress)
  const completeStep = progress.completeStep.bind(progress)
  const failStep = progress.failStep.bind(progress)

  progress.startStep = (id) => {
    if (id === stepId) events.push(`start:${id}`)
    startStep(id)
  }
  progress.completeStep = (id) => {
    if (id === stepId) events.push(`complete:${id}`)
    completeStep(id)
  }
  progress.failStep = (id) => {
    if (id === stepId) events.push(`fail:${id}`)
    failStep(id)
  }

  return events
}

function createTerminalOutputModel (): {
  write: (message: string) => void
  text: () => string
} {
  const lines = ['']
  let row = 0
  let column = 0

  function ensureRow (): void {
    while (lines.length <= row) lines.push('')
  }

  function write (message: string): void {
    for (let index = 0; index < message.length;) {
      const control = message.slice(index).match(/^\u001B\[([0-9;?]*)([A-Za-z])/u)
      if (control !== null) {
        const parameters = control[1] ?? ''
        const command = control[2]
        if (command === 'A') row = Math.max(0, row - (Number.parseInt(parameters, 10) || 1))
        if (command === 'K') {
          ensureRow()
          lines[row] = ''
        }
        index += control[0].length
        continue
      }

      const character = message[index] ?? ''
      if (character === '\r') {
        column = 0
      } else if (character === '\n') {
        row += 1
        column = 0
        ensureRow()
      } else {
        ensureRow()
        const current = lines[row] ?? ''
        const padded = current.padEnd(column, ' ')
        lines[row] = `${padded.slice(0, column)}${character}${padded.slice(column + 1)}`
        column += 1
      }
      index += 1
    }
  }

  return {
    write,
    text: () => lines.map(line => line.trimEnd()).join('\n').replace(/\n+$/u, '')
  }
}

function recordProgressSpinnerEvents (progress: ReturnType<typeof createProgress>): string[] {
  const events: string[] = []
  const startSpinner = progress.startSpinner.bind(progress)
  const stopSpinner = progress.stopSpinner.bind(progress)

  progress.startSpinner = (message) => {
    events.push(`start:${message}`)
    startSpinner(message)
  }
  progress.stopSpinner = (status = 'clear') => {
    events.push(`stop:${status}`)
    stopSpinner(status)
  }

  return events
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

function compactPromptText (value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]|[│\s]/gu, '')
}

test('setup toolchain selection preselects detected runtimes and persists the choice', async () => {
  const workspace = tempDir('setup-toolchains-prompt')
  const context = createWorkspaceContext({
    workspace,
    env: {HOME: workspace, BOXDOWN_DATA_HOME: join(workspace, 'data')}
  })
  const {input, output, outputText} = fakePromptStreams()
  writeFileSync(join(workspace, '.nvmrc'), '24.17.0\n')

  const resultPromise = resolveSetupToolchains({
    context,
    selectors: [],
    input,
    output,
    env: {CI: 'false'}
  })

  input.write('\r')
  const result = await resultPromise

  assert.deepStrictEqual(result.plan?.selected.map(item => item.id), ['node'])
  assert.ok(existsSync(context.toolchainPlanPath))
  assert.match(outputText(), /Node\.js/)
  assert.match(outputText(), /\u001B\[32m■\u001B\[0m/)
})

test('setup toolchain selection offers supported defaults when nothing is detected', async () => {
  const workspace = tempDir('setup-toolchains-supported-defaults')
  const context = createWorkspaceContext({
    workspace,
    env: {HOME: workspace, BOXDOWN_DATA_HOME: join(workspace, 'data')}
  })
  const {input, output, outputText} = fakePromptStreams()

  const resultPromise = resolveSetupToolchains({
    context,
    selectors: [],
    input,
    output,
    env: {CI: 'false'}
  })

  const initialOutput = outputText()
  assert.strictEqual((initialOutput.match(/□/g) ?? []).length, 4)
  assert.match(initialOutput, /■.*No toolchains/s)

  input.write('\u001B[A')
  input.write(' ')
  input.write('\r')
  const result = await resultPromise

  assert.deepStrictEqual(result.detected, [])
  assert.deepStrictEqual(result.plan?.selected, [{
    id: 'rust',
    version: '1.97.1',
    selectionSource: 'interactive',
    resolutionSource: 'boxdown-default',
    evidence: []
  }])
  assert.match(outputText(), /Node\.js.*Boxdown default 24\.17\.0/s)
  assert.match(outputText(), /Python.*Boxdown default 3\.14\.6/s)
  assert.match(outputText(), /Go.*Boxdown default 1\.26\.5/s)
  assert.match(outputText(), /Rust.*Boxdown default 1\.97\.1/s)
})

test('setup toolchain selection leaves incompatible and unresolved detections unchecked', async () => {
  const workspace = tempDir('setup-toolchains-unchecked-detections')
  const context = createWorkspaceContext({
    workspace,
    env: {HOME: workspace, BOXDOWN_DATA_HOME: join(workspace, 'data')}
  })
  const {input, output, outputText} = fakePromptStreams()
  writeFileSync(join(workspace, '.nvmrc'), '24.17.0\n')
  writeFileSync(join(workspace, 'pyproject.toml'), '[project]\nrequires-python = "<3.12"\n')
  writeFileSync(join(workspace, 'go.mod'), 'module example.com/app\n\ngo bananas\n')

  const resultPromise = resolveSetupToolchains({
    context,
    selectors: [],
    input,
    output,
    env: {CI: 'false'}
  })

  input.write('\r')
  const result = await resultPromise

  assert.deepStrictEqual(result.plan?.selected.map(item => item.id), ['node'])
  const rendered = outputText()
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]|[│\r\n]/gu, ' ')
    .replace(/\s+/gu, ' ')
  assert.match(rendered, /Boxdown default 3\.14\.6 is incompatible with <3\.12/)
  assert.match(rendered, /version needs review before automatic selection/)
})

test('non-interactive setup toolchain detection does not write an implicit plan', async () => {
  const workspace = tempDir('setup-toolchains-non-interactive')
  const context = createWorkspaceContext({
    workspace,
    env: {HOME: workspace, BOXDOWN_DATA_HOME: join(workspace, 'data')}
  })
  const input = new PassThrough() as PassThrough & PromptInput
  const output = new PassThrough() as PassThrough & PromptOutput
  input.isTTY = false
  output.isTTY = false
  writeFileSync(join(workspace, '.nvmrc'), '24.17.0\n')

  const result = await resolveSetupToolchains({context, selectors: [], input, output, env: {CI: 'false'}})

  assert.deepStrictEqual(result.detected.map(item => item.id), ['node'])
  assert.strictEqual(result.plan, undefined)
  assert.strictEqual(existsSync(context.toolchainPlanPath), false)
})

test('mounts a supplied toolchain plan read-only and result state read-write', () => {
  const workspace = tempDir('toolchain-config-mounts')
  const context = createWorkspaceContext({
    workspace,
    env: {HOME: workspace, BOXDOWN_DATA_HOME: join(workspace, 'data')},
    assetsDevcontainerDir
  })
  const plan = toolchainPlanFor(context)

  writeToolchainPlan(context, plan)

  assert.ok(!buildGeneratedDevcontainerConfig(context).mounts?.some((mount) => mount.includes(BOXDOWN_CONTAINER_TOOLCHAINS_DIR)))

  const config = buildGeneratedDevcontainerConfig(context, undefined, undefined, plan)
  const planMount = `type=bind,source=${context.toolchainsDir},target=${BOXDOWN_CONTAINER_TOOLCHAINS_DIR}/plan,readonly`
  assert.ok(config.mounts?.includes(planMount))
  assert.ok(config.mounts?.includes(`type=bind,source=${context.toolchainResultDir},target=${BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR}`))
  assert.strictEqual(
    join(`${BOXDOWN_CONTAINER_TOOLCHAINS_DIR}/plan`, relative(context.toolchainsDir, context.toolchainPlanPath)),
    BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH
  )
})

test('does not mount toolchain state for a legacy workspace but mounts an explicit none plan', () => {
  const workspace = tempDir('toolchain-config-no-mounts')
  const context = createWorkspaceContext({
    workspace,
    env: {HOME: workspace, BOXDOWN_DATA_HOME: join(workspace, 'data')},
    assetsDevcontainerDir
  })

  assert.ok(!buildGeneratedDevcontainerConfig(context).mounts?.some((mount) => mount.includes(BOXDOWN_CONTAINER_TOOLCHAINS_DIR)))

  const nonePlan = toolchainPlanFor(context, 'none')
  writeToolchainPlan(context, nonePlan)
  const config = buildGeneratedDevcontainerConfig(context, undefined, undefined, nonePlan)
  assert.ok(config.mounts?.includes(
    `type=bind,source=${context.toolchainsDir},target=${BOXDOWN_CONTAINER_TOOLCHAINS_DIR}/plan,readonly`
  ))
  assert.ok(config.mounts?.includes(
    `type=bind,source=${context.toolchainResultDir},target=${BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR}`
  ))
})

test('toolchain bootstrap disables mise config and records retryable failures', () => {
  const bootstrap = readFileSync(join(assetsDevcontainerDir, 'utils', 'toolchains-bootstrap.sh'), 'utf8')
  const postCreate = readFileSync(join(assetsDevcontainerDir, 'hooks', 'post-create.sh'), 'utf8')
  const postStart = readFileSync(join(assetsDevcontainerDir, 'hooks', 'post-start.sh'), 'utf8')

  assert.match(bootstrap, /MISE_NO_CONFIG=1/)
  assert.match(bootstrap, /mise --no-config install/)
  assert.match(bootstrap, /toolchain-results\/result\.json/)
  assert.match(bootstrap, /state.*failed/)
  assert.match(postCreate, /run_step "Preparing workspace toolchains" configure_toolchains/)
  assert.match(postStart, /configure_toolchains_if_needed/)
})

test('setup resolves explicit toolchain selectors before invoking the workspace setup', async () => {
  const workspace = tempDir('setup-toolchain-cli')
  const env = {
    CI: '1',
    BOXDOWN_CACHE_HOME: tempDir('setup-toolchain-cli-cache'),
    BOXDOWN_DATA_HOME: tempDir('setup-toolchain-cli-data')
  }
  const context = createWorkspaceContext({workspace, env, assetsDevcontainerDir})
  let setupCalled = false
  const stdout: string[] = []
  const originalStdoutWrite = process.stdout.write
  writeFileSync(join(workspace, 'pyproject.toml'), '[project]\nrequires-python = "<3.12"\n')
  writeFileSync(join(workspace, 'go.mod'), 'module example.com/app\n\ngo bananas\n')

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    return true
  }) as typeof process.stdout.write

  let code: number
  try {
    code = await withProcessEnv(env, async () => runCli([
      'setup', '--workspace', workspace,
      '--toolchain', 'python@3.14.6',
      '--toolchain', 'go@1.27.0'
    ], {
      env,
      waitForContainerRuntime: async () => ({state: 'ready', mode: 'buildx', warnings: []}),
      runDoctorChecks: async () => [],
      setupWorkspace: async (receivedContext) => {
        setupCalled = true
        assert.strictEqual(receivedContext.toolchainPlanPath, context.toolchainPlanPath)
        assert.deepStrictEqual(readToolchainPlan(receivedContext)?.selected.map((item) => [item.id, item.version]), [
          ['python', '3.14.6'],
          ['go', '1.27.0']
        ])
      }
    }))
  } finally {
    process.stdout.write = originalStdoutWrite
  }

  assert.strictEqual(code, 0)
  assert.strictEqual(setupCalled, true)
  assert.strictEqual(readWorkspaceMetadata(context)?.toolchainPlanUpdatedAt, readToolchainPlan(context)?.updatedAt)
  assert.match(stdout.join(''), /Selected toolchains:\n {2}Python 3\.14\.6 \(CLI override\)\n {4}Explicit Python 3\.14\.6 override conflicts with pyproject\.toml requires-python <3\.12\.\n {2}Go 1\.27\.0 \(CLI override\)\n {4}Explicit Go 1\.27\.0 override compatibility could not be verified against go\.mod go bananas: Malformed Go version directive\.\n/u)
})

test('direct start preserves a stored plan and only writes explicit selectors', async () => {
  const workspace = tempDir('start-toolchain-plan')
  const env = {
    CI: '1',
    BOXDOWN_CACHE_HOME: tempDir('start-toolchain-plan-cache'),
    BOXDOWN_DATA_HOME: tempDir('start-toolchain-plan-data')
  }
  const context = createWorkspaceContext({workspace, env, assetsDevcontainerDir})
  const storedPlan = toolchainPlanFor(context)
  writeToolchainPlan(context, storedPlan)
  const startOptions = {
    prepareContainerLifecycle: async () => {},
    startDevcontainer: async () => 'toolchain-container',
    printPortHint: async () => {},
    openShell: async () => 0
  }

  const reusedCode = await withProcessEnv(env, async () => runCli(['start', '--workspace', workspace], {
    env,
    ...startOptions
  }))
  assert.strictEqual(reusedCode, 0)
  assert.deepStrictEqual(readToolchainPlan(context), storedPlan)

  const explicitCode = await withProcessEnv(env, async () => runCli([
    'start', '--workspace', workspace, '--toolchain', 'go@1.27.0'
  ], {
    env,
    ...startOptions
  }))
  assert.strictEqual(explicitCode, 0)
  assert.deepStrictEqual(readToolchainPlan(context)?.selected.map((item) => [item.id, item.version]), [['go', '1.27.0']])
})

test('direct start rejects an unconfigured workspace without starting a container', async () => {
  const workspace = tempDir('start-toolchain-unconfigured')
  const env = {
    CI: '1',
    BOXDOWN_CACHE_HOME: tempDir('start-toolchain-unconfigured-cache'),
    BOXDOWN_DATA_HOME: tempDir('start-toolchain-unconfigured-data')
  }
  let lifecycleCalled = false

  const code = await withProcessEnv(env, async () => runCli(['start', '--workspace', workspace], {
    env,
    prepareContainerLifecycle: async () => { lifecycleCalled = true },
    startDevcontainer: async () => 'unexpected-container',
    printPortHint: async () => {},
    openShell: async () => 0
  }))

  assert.strictEqual(code, 1)
  assert.strictEqual(lifecycleCalled, false)
})

test('direct coding-agent launch rejects an unconfigured workspace before container lifecycle', async () => {
  const workspace = tempDir('coding-agent-toolchain-unconfigured')
  const env = {
    CI: '1',
    BOXDOWN_CACHE_HOME: tempDir('coding-agent-toolchain-unconfigured-cache'),
    BOXDOWN_DATA_HOME: tempDir('coding-agent-toolchain-unconfigured-data')
  }
  let lifecycleCalled = false

  const code = await withProcessEnv(env, async () => runCli(['codex', '--workspace', workspace], {
    env,
    prepareContainerLifecycle: async () => { lifecycleCalled = true },
    startDevcontainer: async () => 'unexpected-container',
    ensureContainerCodingAgentCli: async () => {},
    openCodingAgentCli: async () => 0
  }))

  assert.strictEqual(code, 1)
  assert.strictEqual(lifecycleCalled, false)
})

test('rejects incompatible setup toolchain selectors before preflight', async () => {
  for (const toolchains of [
    ['none', 'node'],
    ['node@24.17.0', 'node@25.0.0']
  ]) {
    const workspace = tempDir(`setup-toolchain-invalid-${toolchains.join('-')}`)
    const env = {
      CI: '1',
      BOXDOWN_CACHE_HOME: tempDir(`setup-toolchain-invalid-${toolchains.join('-')}-cache`),
      BOXDOWN_DATA_HOME: tempDir(`setup-toolchain-invalid-${toolchains.join('-')}-data`)
    }
    let preflightCalled = false

    const code = await withProcessEnv(env, async () => runCli([
      'setup', '--workspace', workspace, ...toolchains.flatMap((toolchain) => ['--toolchain', toolchain])
    ], {
      env,
      waitForContainerRuntime: async () => {
        preflightCalled = true
        return {state: 'ready', mode: 'buildx', warnings: []}
      },
      runDoctorChecks: async () => [],
      setupWorkspace: async () => {}
    }))

    assert.strictEqual(code, 1, toolchains.join(', '))
    assert.strictEqual(preflightCalled, false, toolchains.join(', '))
  }
})

test('non-interactive setup without selectors leaves an unconfigured workspace untouched', async () => {
  const workspace = tempDir('setup-toolchain-noninteractive')
  const env = {
    CI: '1',
    BOXDOWN_CACHE_HOME: tempDir('setup-toolchain-noninteractive-cache'),
    BOXDOWN_DATA_HOME: tempDir('setup-toolchain-noninteractive-data')
  }
  const context = createWorkspaceContext({workspace, env, assetsDevcontainerDir})
  const stdout: string[] = []
  const originalStdoutWrite = process.stdout.write
  writeFileSync(join(workspace, '.nvmrc'), '24.17.0\n')

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    return true
  }) as typeof process.stdout.write

  let code: number
  try {
    code = await withProcessEnv(env, async () => runCli(['setup', '--workspace', workspace], {
      env,
      waitForContainerRuntime: async () => ({state: 'ready', mode: 'buildx', warnings: []}),
      runDoctorChecks: async () => [],
      setupWorkspace: async () => {}
    }))
  } finally {
    process.stdout.write = originalStdoutWrite
  }

  assert.strictEqual(code, 0)
  assert.strictEqual(existsSync(context.toolchainPlanPath), false)
  assert.match(stdout.join(''), /Detected toolchains: Node\.js 24\.17\.0 \(\.nvmrc\)\n/u)
})

async function waitForPromptOutput (outputText: () => string, pattern: RegExp): Promise<void> {
  const deadline = Date.now() + 5000

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
  test('resolves agent profiles by explicit, recorded, and default precedence', () => {
    assert.deepStrictEqual(resolveAgentProfile('full', 'none'), {
      value: 'full',
      source: 'explicit'
    })
    assert.deepStrictEqual(resolveAgentProfile(undefined, 'none'), {
      value: 'none',
      source: 'metadata'
    })
    assert.deepStrictEqual(resolveAgentProfile(undefined, undefined), {
      value: 'auth',
      source: 'default'
    })
  })

  test('recognizes exactly the public agent profile values', () => {
    assert.deepStrictEqual(AGENT_PROFILES, ['none', 'auth', 'full'])
    for (const profile of AGENT_PROFILES) assert.strictEqual(isAgentProfile(profile), true)
    for (const value of ['', 'bare', 'portable', 'other', 'AUTH', 'full ']) assert.strictEqual(isAgentProfile(value), false)
  })

  test('models full-profile live container markers while accepting legacy markers', () => {
    assert.deepStrictEqual(parseAgentProfileMarker('full:live'), {
      profile: 'full',
      mode: 'live'
    })
    assert.deepStrictEqual(parseAgentProfileMarker('full'), {
      profile: 'full',
      mode: 'legacy'
    })
    assert.strictEqual(agentProfileMarker('full'), 'full:live')
  })

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

  test('parses repeatable toolchain selectors only for setup and start', () => {
    assert.deepStrictEqual(
      parseCliArgs(['setup', '--toolchain', 'node', '--toolchain', 'go@1.27.0']).toolchains,
      ['node', 'go@1.27.0']
    )
    assert.deepStrictEqual(parseCliArgs(['start', '--toolchain', 'none']).toolchains, ['none'])
    assert.throws(
      () => parseCliArgs(['status', '--toolchain', 'node']),
      /--toolchain is only supported with setup and start/
    )
    assert.throws(
      () => parseCliArgs(['setup', '--toolchain', 'node@latest']),
      /Unsupported toolchain selector: node@latest/
    )
  })

  test('parses each agent profile on every container-creating command', () => {
    const commands: Array<{ argv: string[], command: BoxdownCommand }> = [
      { argv: ['setup'], command: 'setup' },
      { argv: ['start'], command: 'start' },
      { argv: ['codex'], command: 'coding-agent' }
    ]

    for (const { argv, command } of commands) {
      for (const profile of AGENT_PROFILES) {
        const before = parseCliArgs(['--agent-profile', profile, ...argv])
        const after = parseCliArgs([...argv, '--agent-profile', profile])

        assert.strictEqual(before.command, command)
        assert.strictEqual(before.agentProfile, profile)
        assert.strictEqual(after.agentProfile, profile)
      }
    }
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
    assert.deepStrictEqual(parseCliArgs(['ssh', 'install', '--target', 'cursor', '--target', 'cursor']), {
      command: 'ssh-install',
      workspace: undefined,
      alias: undefined,
      targets: ['cursor'],
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
    assert.deepStrictEqual(parseCliArgs([
      'ssh', 'uninstall', '--target', 'codex', '--target', 'claude', '--target', 'codex'
    ]), {
      command: 'ssh-uninstall',
      workspace: undefined,
      alias: undefined,
      targets: ['codex', 'claude'],
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
    assert.throws(() => parseCliArgs(['refresh-gh-token-running']), /Unknown command: refresh-gh-token-running/)
    assert.throws(() => parseCliArgs(['ssh-config', 'install']), /Unknown command: ssh-config install/)
    assert.throws(() => parseCliArgs(['codex', 'repair']), /Unknown command: codex repair/)
    assert.throws(() => parseCliArgs(['ssh', 'remove']), /Unknown ssh command: remove/)
    assert.throws(() => parseCliArgs(['ssh', 'install', 'extra']), /Unknown ssh command: install extra/)
    assert.throws(() => parseCliArgs(['ssh', 'uninstall', 'extra']), /Unknown ssh command: uninstall extra/)
    assert.throws(() => parseCliArgs(['install-ssh-config']), /Unknown command/)
    assert.throws(() => parseCliArgs(['start', '--json']), /--json is only supported with status and list/)
    assert.throws(() => parseCliArgs(['ssh', 'install', '--target', 'other']), /Unsupported ssh install target: other/)
    assert.throws(
      () => parseCliArgs(['start', '--target', 'codex']),
      /--target is only supported with setup, ssh install, and ssh uninstall/
    )
    assert.throws(() => parseCliArgs(['start', '--port', '3030']), /--port is only supported with tunnel/)
    assert.throws(
      () => parseCliArgs(['codex', '--target', 'claude']),
      /--target is only supported with setup, ssh install, and ssh uninstall/
    )
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
    assert.throws(() => parseCliArgs(['setup', '--agent-profile']), /--agent-profile requires a value/)
    assert.throws(() => parseCliArgs(['setup', '--agent-profile', 'other']), /Unsupported agent profile: other/)
    assert.throws(() => parseCliArgs(['setup', '--agent-profile', 'none', '--agent-profile', 'full']), /--agent-profile can only be provided once/)
    assert.throws(() => parseCliArgs(['codex', '--toolchain', 'node']), /--toolchain is only supported with setup and start/)

    for (const command of [
      'status', 'list', 'stop', 'down', 'purge', 'doctor', 'ssh', 'ssh uninstall'
    ]) {
      assert.throws(
        () => parseCliArgs([...command.split(' '), '--agent-profile', 'auth']),
        /--agent-profile is only supported with setup, start, ssh-proxy, tunnel, refresh-gh-token, and coding-agent/
      )
    }
  })

  test('help describes available commands', () => {
    const usageLines = USAGE.split(/\r?\n/)

    assert.match(USAGE, /Commands:/)
    assert.match(USAGE, /boxdown setup \[--workspace <path>\] \[--alias <name>\] \[--recreate\] \[--agent-profile <tier>\] \[--toolchain <selector>\]\.\.\. \[--target <name>\]\.\.\. \[--verbose\]/)
    assert.match(USAGE, /boxdown start \[--workspace <path>\] \[--recreate\] \[--agent-profile <tier>\] \[--toolchain <selector>\]\.\.\. \[--verbose\]/)
    assert.match(USAGE, /boxdown codex \[--workspace <path>\] \[--recreate\] \[--agent-profile <tier>\] \[--verbose\] \[-- <codex args\.\.\.>\]/)
    assert.match(USAGE, /boxdown claude \[--workspace <path>\] \[--recreate\] \[--agent-profile <tier>\] \[--verbose\] \[-- <claude args\.\.\.>\]/)
    assert.match(USAGE, /boxdown opencode \[--workspace <path>\] \[--recreate\] \[--agent-profile <tier>\] \[--verbose\] \[-- <opencode args\.\.\.>\]/)
    assert.match(USAGE, /boxdown antigravity \[--workspace <path>\] \[--recreate\] \[--agent-profile <tier>\] \[--verbose\] \[-- <agy args\.\.\.>\]/)
    assert.match(USAGE, /boxdown tunnel \[--port <port>\] \[--port <local:remote>\] \[--workspace <path>\] \[--alias <name>\] \[--agent-profile <tier>\] \[--verbose\]/)
    assert.match(USAGE, /boxdown ssh uninstall \[--workspace <path>\] \[--alias <name>\] \[--target <name>\]\.\.\./)
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
    assert.match(
      USAGE,
      /purge\s+Remove the workspace devcontainer, its Docker image\s+when unused/
    )
    assert.match(USAGE, /boxdown purge \[--workspace <path\|ssh-alias\|repo>\] \[--alias <name>\]/)
    assert.match(USAGE, /--workspace <path>\s+Target project directory[\s\S]*Repeatable with down\. With purge, also accepts PATH,/)
    assert.match(USAGE, /SSH ALIAS, or an unambiguous REPO from boxdown list\./)
    assert.match(USAGE, /Without --workspace, purge only targets the current[\s\S]*interactive[\s\S]*terminals prompt for tracked workspaces\./)
    assert.match(USAGE, /--json\s+Print JSON output\. Supported by status and list\./)
    assert.match(USAGE, /--format json\s+Print JSON output\. Equivalent to --json\./)
    assert.match(USAGE, /--details\s+Print detailed human list output\. Supported by list\./)
    assert.match(USAGE, /--verbose\s+Show a detailed lifecycle trace in an interactive terminal\.[\s\S]*Streams raw Docker, devcontainer, and hook output in CI\s+or non-interactive output\./)
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
    assert.match(USAGE, /boxdown ssh install \[--workspace <path>\] \[--alias <name>\] \[--target <name>\]\.\.\. \[--verbose\]/)
    assert.match(USAGE, /ssh uninstall\s+Remove Boxdown's managed SSH host alias/)
    assert.doesNotMatch(USAGE, /ssh-config/)
    assert.match(USAGE, /--target <name>\s+Optional SSH integration target/)
    assert.match(USAGE, /Repeatable\. Supported by[\s\S]*setup, ssh install, and ssh uninstall: codex, claude, cursor\./)
    assert.match(USAGE, /ssh-proxy\s+Internal command used by the generated SSH/)
    assert.match(USAGE, /tunnel\s+Start or reuse the devcontainer/)
    assert.match(USAGE, /boxdown tunnel \[--port <port>\]/)
    assert.match(USAGE, /--agent-profile <tier>/)
    assert.match(USAGE, /none, auth, full/)
    assert.match(USAGE, /Defaults to auth/)
    assert.match(USAGE, /auth copies into container-local storage/i)
    assert.match(USAGE, /full profile uses live, read-write host mounts/i)
    assert.match(USAGE, /--port <port>\s+Tunnel a local port/)
    assert.match(USAGE, /refresh-gh-token\s+Start or reuse the devcontainer/)
    assert.doesNotMatch(USAGE, /refresh-gh-token-running/)
  })

  test('README documents Boxdown resource ownership and verbosity modes', () => {
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
    assert.match(readme, /## What Boxdown manages/)
    assert.match(readme, /outside the target repository/)
    assert.match(readme, /interactive `--verbose`.*detailed lifecycle trace/is)
    assert.match(readme, /CI and non-interactive contexts stream\s+raw managed-command output/)
    assert.match(readme, /metadata, SSH keys, and redacted command log live under its data\s+roots/)
    assert.match(readme, /per-workspace runtime root for runtime-secret state/)
    assert.match(readme, /host checkout.*\/workspaces\/<repo-name>.*writable/is)
    assert.match(readme, /packaged assets, public SSH key, host Git-config\s+snapshot, and runtime-secret directory read-only/is)
    assert.match(readme, /host Git-config\s+snapshot.*writable `\/home\/node\/\.gitconfig`/is)
    assert.match(readme, /Agent profiles/is)
    assert.match(readme, /`auth`.*copy.*container creation/is)
    assert.match(readme, /`full`.*live, read-write host mounts/is)
    assert.match(readme, /SSH-agent socket.*`\/run\/boxdown\/ssh-agent\.sock`.*signing-key state.*read-only/is)
    assert.match(readme, /Recreate the container.*--agent-profile.*full-profile mount\s+configuration.*copied `auth` sources/is)
    assert.match(readme, /Changes to live `full`\s+profiles are already visible to a running container\./)
    assert.match(readme, /`boxdown down` removes the\s+container.*runtime-secret\s+state/is)
    assert.match(readme, /retains persistent cache\/data state/)
    assert.match(readme, /`stop`.*`down`.*`purge`/is)
    assert.doesNotMatch(readme, /refresh-gh-token-running/)
  })

  test('lifecycle docs preserve down cleanup and context-sensitive verbosity semantics', () => {
    const lifecycle = readFileSync(fileURLToPath(new URL('../docs/features/lifecycle.md', import.meta.url)), 'utf8')

    assert.match(lifecycle, /`down` removes the workspace devcontainer.*per-workspace runtime-secret state/is)
    assert.match(lifecycle, /does not remove.*cache.*generated config.*data directories.*SSH keys/is)
    assert.match(lifecycle, /interactive.*`--verbose`.*detailed lifecycle trace/is)
    assert.match(lifecycle, /CI.*non-TTY.*raw .*output/is)
  })

  test('feature docs distinguish interactive detailed traces from non-interactive raw streaming', () => {
    const docs = [
      '../docs/features/setup.md',
      '../docs/features/start-and-shell.md',
      '../docs/features/github-auth-refresh.md'
    ].map((relativePath) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'))

    for (const document of docs) {
      assert.match(document, /interactive.*`--verbose`.*detailed lifecycle trace/is)
      assert.match(document, /CI|non-interactive/is)
      assert.match(document, /raw .*output/is)
    }
  })

  test('feature docs distinguish GitHub auth refresh container reuse from startup fallback', () => {
    const githubAuth = readFileSync(join(process.cwd(), 'docs/features/github-auth-refresh.md'), 'utf8')

    assert.match(githubAuth, /only GitHub CLI auth-refresh command/)
    assert.match(githubAuth, /refreshes.*running.*container.*in place/is)
    assert.match(githubAuth, /no.*running.*container.*starts/is)
    assert.doesNotMatch(githubAuth, /refresh-gh-token-running/)
  })

  test('help aligns wrapped command descriptions', () => {
    const usageLines = USAGE.split(/\r?\n/)
    const commandsStart = usageLines.indexOf('Commands:')
    const optionsStart = usageLines.indexOf('Options:')
    const commandLines = usageLines.slice(commandsStart + 1, optionsStart)
    const setupLine = commandLines.find((line) => line.startsWith('  setup'))
    const setupContinuationLine = commandLines[commandLines.findIndex((line) => line.startsWith('  setup')) + 1]
    const longestCommandLine = commandLines.find((line) => line.startsWith('  refresh-gh-token'))

    assert.ok(setupLine !== undefined)
    assert.ok(setupContinuationLine !== undefined)
    assert.ok(longestCommandLine !== undefined)

    const descriptionColumn = longestCommandLine.indexOf('Start')
    assert.strictEqual(setupLine.indexOf('Prepare'), descriptionColumn)
    assert.strictEqual(setupContinuationLine.indexOf('integration'), descriptionColumn)
  })
})

test('documents agent profile tiers', () => {
  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
  const stateDocs = readFileSync(join(process.cwd(), 'docs/features/generated-config-and-state.md'), 'utf8')
  const startDocs = readFileSync(join(process.cwd(), 'docs/features/start-and-shell.md'), 'utf8')
  const lifecycleDocs = readFileSync(join(process.cwd(), 'docs/features/lifecycle.md'), 'utf8')
  const setupDocs = readFileSync(join(process.cwd(), 'docs/features/setup.md'), 'utf8')
  const testingDocs = readFileSync(join(process.cwd(), 'docs/testing.md'), 'utf8')
  const architecture = readFileSync(join(process.cwd(), 'docs/architecture.md'), 'utf8')
  const assetDocs = readFileSync(join(process.cwd(), 'assets/devcontainer/README.md'), 'utf8')
  const devcontainerTemplate = readFileSync(join(process.cwd(), 'assets/devcontainer/devcontainer.json'), 'utf8')

  assert.match(readme, /\| `none` \| no host user-scoped agent profile or Claude API key \|/)
  assert.match(readme, /\| `auth` \| file-backed auth, Claude API key, complete `~\/\.agents` \|/)
  assert.match(readme, /\| `full` \| live, read-write host Codex\/Claude homes plus `~\/\.agents` \|/)
  assert.match(readme, /`auth` is the default/is)
  assert.match(readme, /--agent-profile none\|auth\|full/)
  assert.match(readme, /`auth`.*read-only staging.*container-local writable cop(?:y|ies)/is)
  assert.match(readme, /changes.*inside the container.*host profile.*immediately/is)
  assert.match(readme, /repository-scoped.*remains? visible/is)
  assert.match(readme, /macOS.*Keychain.*not copied/is)
  assert.match(readme, /sensitive.*host.*immediately.*untrusted/is)
  assert.match(readme, /custom mount.*canonical.*externally managed/is)
  assert.match(readme, /changes the previous forwarding model.*Codex\s+config.*Claude MCP projection.*writable host mount/is)
  assert.match(readme, /portable user-scoped.*MCP.*repository.*untrusted/is)
  assert.match(
    readme,
    /setup.*app target.*agent profile.*--agent-profile.*suppress/is
  )

  assert.match(setupDocs, /--agent-profile <tier>/)
  assert.match(
    setupDocs,
    /at least one.*Codex.*Claude.*--agent-profile.*not supplied/is
  )
  assert.match(setupDocs, /boxdown setup --target codex --agent-profile auth/)
  assert.match(
    testingDocs,
    /profile selector.*fully explicit.*non-interactive/is
  )
  assert.match(startDocs, /--agent-profile <tier>/)
  assert.match(startDocs, /start --recreate.*agent-profile full/is)
  assert.match(stateDocs, /`auth`.*read-only staging.*container-local writable cop(?:y|ies)/is)
  assert.match(stateDocs, /`full`.*live, read-write host mounts/is)
  assert.ok(stateDocs.includes(String.raw`%USERPROFILE%\.claude\.credentials.json`))
  assert.ok(!stateDocs.includes(String.raw`%USERPROFILE%\.claude.credentials.json`))
  assert.match(lifecycleDocs, /stop.*preserves.*profile/is)
  assert.match(lifecycleDocs, /container-local `auth` profile.*down.*recreate.*discard that copy/is)
  assert.match(architecture, /`auth`.*read-only staging.*container-local writable cop(?:y|ies)/is)
  assert.match(architecture, /`full`.*live, read-write.*host/is)
  assert.match(architecture, /full:live/)
  assert.doesNotMatch(architecture, /It never mounts a\s+Boxdown-selected host source directly/)
  assert.match(architecture, /mismatch.*recreation/is)
  assert.match(assetDocs, /staging tree/is)
  assert.match(assetDocs, /bootstrap.*marker/is)
  assert.match(assetDocs, /non-root\s+remote user/is)
  assert.match(assetDocs, /source-file.*failure.*non-fatal/is)
  for (const document of [stateDocs, assetDocs]) {
    assert.match(
      document,
      /static symlinks.*(?:reproduced|copied)\s+as links.*final-component regular\s+file.*fails\s+closed/is
    )
    assert.match(
      document,
      /concurrent host\s+replacement.*traversed parent\s+directory.*outside the isolation guarantee.*(?:fail|copy)\s+best-effort/is
    )
    assert.match(
      document,
      /malformed CSV string mount.*unresolved.*string mount.*all canonical profile destinations/is
    )
    assert.match(
      document,
      /structured mount.*present serialized `type`, `src`\/`source`, and\s+`dst`\/`target`\/`destination`/is
    )
    assert.match(
      document,
      /non-string value, unresolved.*comma, double quote, carriage return, line feed, or NUL makes all\s+canonical profile destinations/is
    )
    assert.match(document, /includes substitutions\s+confined to the type or source fields/is)
    assert.match(document, /opaque unknown fields.*not interpreted\s+as mount grammar/is)
    assert.doesNotMatch(document, /structured mount.*source.*does not claim a destination/is)
    assert.match(
      document,
      /original mount.*preserved unchanged.*status.*canonical.*never.*substitution values/is
    )
  }
  assert.match(devcontainerTemplate, /only `auth` profile sources are staged read-only.*container-local writable copies/is)
  assert.match(devcontainerTemplate, /`full` is not staged.*host writes are intentional/is)
  assert.doesNotMatch(devcontainerTemplate, /Codex auth\.json is mounted automatically|host-owned writable credential mounts/i)
})

test('feature docs document Cursor SSH support boundaries', () => {
  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
  const setupDocs = readFileSync(join(process.cwd(), 'docs/features/setup.md'), 'utf8')
  const sshDocs = readFileSync(join(process.cwd(), 'docs/features/ssh-config-and-proxy.md'), 'utf8')
  const stateDocs = readFileSync(join(process.cwd(), 'docs/features/generated-config-and-state.md'), 'utf8')
  const developmentDocs = readFileSync(join(process.cwd(), 'docs/development.md'), 'utf8')
  const lifecycleDocs = readFileSync(join(process.cwd(), 'docs/features/lifecycle.md'), 'utf8')

  assert.match(setupDocs, /boxdown setup --target cursor/)
  assert.match(setupDocs, /Cursor alone.*does not.*agent-profile/is)
  assert.match(setupDocs, /default.*complete.*open command.*standalone URI.*--verbose/is)
  assert.match(sshDocs, /remote\.SSH\.remotePlatform/)
  assert.match(sshDocs, /cursor --folder-uri/)
  assert.match(sshDocs, /default result.*standalone URI.*verbose/is)
  assert.doesNotMatch(sshDocs, /prints the raw URI and an open command/)
  assert.match(sshDocs, /anysphere\.remote-ssh/)
  assert.match(sshDocs, /does not.*(?:SQLite|workspaceStorage)/is)
  assert.match(stateDocs, /BOXDOWN_CURSOR_SETTINGS/)
  assert.match(stateDocs, /cursor-integration\.json/)
  assert.match(readme, /SSH aliases and\s+Codex\/Claude\/Cursor application integrations/)
  assert.match(developmentDocs, /--target cursor/)
  assert.match(sshDocs, /`codex`, `claude`, and `cursor` can be installed/)
  assert.match(lifecycleDocs, /SSH\/Codex\/Claude\/Cursor entries/)
  assert.match(stateDocs, /integration cleanup fails.*retains.*workspace data/is)
})

test('documents interactive container reuse lifecycle', () => {
  const startDocs = readFileSync(join(process.cwd(), 'docs/features/start-and-shell.md'), 'utf8')
  const setupDocs = readFileSync(join(process.cwd(), 'docs/features/setup.md'), 'utf8')

  assert.match(startDocs, /reuse an already-running workspace devcontainer/i)
  assert.match(startDocs, /--recreate.*bypasses reuse/i)
  assert.match(setupDocs, /explicit provisioning/i)
})

describe('interactive install target prompt', () => {
  describe('single-choice prompt', () => {
    const profilePromptChoices = [
      { value: 'none', label: 'No agent profile', description: 'Copy no host user-scoped agent data.' },
      { value: 'auth', label: 'Authentication and ~/.agents', description: 'Copy agent authentication and ~/.agents; Boxdown default.' },
      { value: 'full', label: 'Full agent profiles', description: 'Mount live read-write Codex, Claude, and ~/.agents host profiles.' }
    ] as const

    test('focuses and selects each raw single-choice default with Enter', async () => {
      for (const entry of profilePromptChoices) {
        const { input, output, outputText } = fakePromptStreams()
        const resultPromise = promptSelect({
          title: 'How much host agent data should Boxdown use in the container?',
          choices: profilePromptChoices,
          defaultValue: entry.value,
          summaryLabel: 'Agent profile',
          input,
          output,
          env: { CI: 'false' }
        })

        assert.ok(outputText().includes(`${selectedMark()} ${color(entry.label, 'bold')}`))
        input.write('\r')

        assert.deepStrictEqual(await resultPromise, { status: 'selected', value: entry.value })
        assert.ok(outputText().includes(`Agent profile: ${entry.label}`))
      }
    })

    test('keeps a raw single-choice description inline when it fits', async () => {
      const { input, output, outputText } = fakePromptStreams({ columns: 120 })
      const resultPromise = promptSelect({
        title: 'Agent profile?',
        choices: [{ value: 'auth', label: 'Authentication and ~/.agents', description: 'Copy agent authentication and ~/.agents; Boxdown default.' }],
        defaultValue: 'auth',
        input,
        output,
        env: { CI: 'false' }
      })

      assert.match(outputText(), /Authentication and ~\/\.agents.* - Copy agent authentication and ~\/\.agents; Boxdown default\./)
      input.write('\r')
      assert.deepStrictEqual(await resultPromise, { status: 'selected', value: 'auth' })
    })

    test('NO_COLOR removes SGR styling from a raw single-choice prompt', async () => {
      const { input, output, outputText } = fakePromptStreams({ columns: 36 })
      const resultPromise = promptSelect({
        title: 'Agent profile?',
        choices: [{
          value: 'auth',
          label: 'Authentication and ~/.agents',
          description: 'Copy agent authentication and ~/.agents; Boxdown default.'
        }],
        defaultValue: 'auth',
        input,
        output,
        env: { CI: 'false', NO_COLOR: '1' }
      })

      assert.doesNotMatch(outputText(), /\u001B\[[0-9;]*m/u)
      assert.match(outputText(), /\u001B\[2K/u)
      input.write('\r')
      assert.deepStrictEqual(await resultPromise, { status: 'selected', value: 'auth' })
    })

    test('indents wrapped raw single-choice descriptions below their option', async () => {
      const { input, output, outputText } = fakePromptStreams({ columns: 36 })
      const resultPromise = promptSelect({
        title: 'Agent profile?',
        choices: [{ value: 'full', label: 'Full agent profiles', description: 'Copy complete Codex, Claude, and ~/.agents profiles; may include sensitive data.' }],
        defaultValue: 'full',
        input,
        output,
        env: { CI: 'false' }
      })

      const rendered = outputText().replace(/\u001B\[[0-?]*[ -/]*[@-~]|\r/gu, '')
      assert.match(rendered, /■ Full agent profiles\n│ {4}Copy complete Codex, Claude,/)
      assert.match(rendered, /\n│ {4}and ~\/\.agents profiles; may\n│ {4}include sensitive data\./)
      assert.doesNotMatch(rendered, /\nCopy complete|\nand ~\/\.agents|\ninclude sensitive/)
      input.write('\r')
      assert.deepStrictEqual(await resultPromise, { status: 'selected', value: 'full' })
    })

    test('moves and wraps a raw single-choice prompt', async () => {
      for (const entry of [
        { keys: '\u001B[B\r', expected: 'full' },
        { keys: 'j\r', expected: 'full' },
        { keys: '\u001B[A\r', expected: 'none' },
        { keys: 'k\r', expected: 'none' },
        { keys: '\u001B[B\u001B[B\r', expected: 'none' }
      ] as const) {
        const { input, output } = fakePromptStreams()
        const resultPromise = promptSelect({
          title: 'Agent profile?',
          choices: profilePromptChoices,
          defaultValue: 'auth',
          input,
          output,
          env: { CI: 'false' }
        })

        input.write(entry.keys)
        assert.deepStrictEqual(await resultPromise, {
          status: 'selected',
          value: entry.expected
        })
      }
    })

    test('cancels a raw single-choice prompt and restores terminal state', async () => {
      for (const key of ['\u001B', '\u0003', '\u0004']) {
        const rawModes: boolean[] = []
        const { input, output, outputText } = fakePromptStreams()
        input.setRawMode = (mode) => {
          rawModes.push(mode)
        }
        const resultPromise = promptSelect({
          title: 'Agent profile?',
          choices: profilePromptChoices,
          defaultValue: 'auth',
          input,
          output,
          env: { CI: 'false' }
        })

        input.write(key)
        assert.deepStrictEqual(await resultPromise, { status: 'cancelled' })
        assert.deepStrictEqual(rawModes, [true, false])
        assert.match(outputText(), /\u001B\[\?25l/)
        assert.match(outputText(), /\u001B\[\?25h/)
      }
    })

    test('ignores trailing raw input after selection or cancellation', async () => {
      for (const entry of [
        { keys: '\rj', expected: { status: 'selected', value: 'auth' } },
        { keys: '\u0003j', expected: { status: 'cancelled' } }
      ] as const) {
        const { input, output, outputText } = fakePromptStreams()
        const resultPromise = promptSelect({
          title: 'Agent profile?',
          choices: profilePromptChoices,
          defaultValue: 'auth',
          input,
          output,
          env: { CI: 'false' }
        })

        input.write(entry.keys)

        assert.deepStrictEqual(await resultPromise, entry.expected)
        assert.match(outputText(), /Selection: (?:Authentication and ~\/\.agents|canceled)\n$/)
      }
    })

    test('restores terminal state before raw-mode failure falls back to line mode', async () => {
      const { input, output, outputText } = fakePromptStreams()
      input.setRawMode = (mode) => {
        if (mode) throw new Error('raw mode unavailable')
      }
      const resultPromise = promptSelect({
        title: 'Agent profile?',
        choices: profilePromptChoices,
        defaultValue: 'auth',
        input,
        output,
        env: { CI: 'false' }
      })

      await waitForPromptOutput(outputText, /1\) No agent profile/)
      input.write('\n')

      assert.deepStrictEqual(await resultPromise, { status: 'selected', value: 'auth' })
      assert.match(outputText(), /\u001B\[\?25l/)
      assert.match(outputText(), /\u001B\[\?25h/)
    })

    test('selects by number, value, and blank default in line mode', async () => {
      for (const entry of [
        { answer: '3\n', expected: 'full' },
        { answer: 'none\n', expected: 'none' },
        { answer: '\n', expected: 'auth' }
      ] as const) {
        const { input, output } = fakePromptStreams({ rawMode: false })
        const resultPromise = promptSelect({
          title: 'Agent profile?',
          choices: profilePromptChoices,
          defaultValue: 'auth',
          input,
          output,
          env: { CI: 'false' }
        })

        input.write(entry.answer)
        assert.deepStrictEqual(await resultPromise, {
          status: 'selected',
          value: entry.expected
        })
      }
    })

    test('retries invalid line input and cancels on EOF', async () => {
      const retry = fakePromptStreams({ rawMode: false })
      const retryPromise = promptSelect({
        title: 'Agent profile?',
        choices: profilePromptChoices,
        defaultValue: 'auth',
        input: retry.input,
        output: retry.output,
        env: { CI: 'false' }
      })
      retry.input.write('other\nfull\n')
      assert.deepStrictEqual(await retryPromise, { status: 'selected', value: 'full' })
      assert.match(retry.outputText(), /Unknown selection: other/)

      const eof = fakePromptStreams({ rawMode: false })
      const eofPromise = promptSelect({
        title: 'Agent profile?',
        choices: profilePromptChoices,
        defaultValue: 'auth',
        input: eof.input,
        output: eof.output,
        env: { CI: 'false' }
      })
      eof.input.end()
      assert.deepStrictEqual(await eofPromise, { status: 'cancelled' })
    })

    test('is silent when single-choice prompting is unavailable', async () => {
      const input = new PassThrough() as PassThrough & PromptInput
      const output = new PassThrough() as PassThrough & PromptOutput
      const outputChunks: Buffer[] = []
      input.isTTY = false
      output.isTTY = false
      output.on('data', (chunk: Buffer) => outputChunks.push(chunk))

      assert.deepStrictEqual(await promptSelect({
        title: 'Agent profile?',
        choices: profilePromptChoices,
        defaultValue: 'auth',
        input,
        output,
        env: { CI: 'false' }
      }), { status: 'non-interactive' })
      assert.strictEqual(Buffer.concat(outputChunks).toString('utf8'), '')
    })

    test('rejects a default that is not a choice', async () => {
      await assert.rejects(promptSelect({
        title: 'Agent profile?',
        choices: profilePromptChoices,
        defaultValue: 'other',
        env: { CI: '1' }
      }), /Select prompt default is not one of its choices: other/)
    })
  })

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

  test('NO_COLOR removes SGR styling but keeps raw prompt cursor control', async () => {
    const { input, output, outputText } = fakePromptStreams()
    const resultPromise = promptMultiSelect({
      title: 'Install optional SSH targets?',
      choices: [codexPromptChoice],
      skipLabel: 'Skip optional targets',
      input,
      output,
      env: { CI: 'false', NO_COLOR: '1' }
    })

    input.write('\r')

    assert.deepStrictEqual(await resultPromise, { status: 'skipped', values: [] })
    assert.doesNotMatch(outputText(), /\u001B\[[0-9;]*m/u)
    assert.match(outputText(), /\u001B\[\?25l/u)
    assert.match(outputText(), /\u001B\[2K/u)
    assert.match(outputText(), /\u001B\[\?25h/u)
  })

  test('wraps narrow multi-select titles, descriptions, and skip labels under the prompt rail', async () => {
    const { input, output, outputText } = fakePromptStreams({ columns: 32 })
    const resultPromise = promptMultiSelect({
      title: 'Add this project to an AI coding app? (Select any)',
      choices: [{
        value: 'codex',
        label: 'ChatGPT app',
        description: 'Connect ChatGPT to this project.'
      }],
      skipLabel: 'Not now — Finish setup without adding the project to an app.',
      input,
      output,
      env: { CI: 'false' }
    })

    const rendered = outputText().replace(/\u001B\[[0-?]*[ -/]*[@-~]|\r/gu, '')
    assert.match(rendered, /◆ {2}Add this project to an AI\n│ {2}coding app\? \(Select any\)/)
    assert.match(rendered, /□ ChatGPT app\n│ {4}Connect ChatGPT to this\n│ {4}project\./)
    assert.match(rendered, /■ Not now — Finish setup\n│ {4}without adding the project/)
    for (const line of rendered.split('\n').filter(Boolean)) {
      assert.ok(Array.from(line).length <= 32, line)
    }

    input.write('\r')
    assert.deepStrictEqual(await resultPromise, { status: 'skipped', values: [] })
  })

  test('hard-wraps a focused colored multi-select path without losing its styles', async () => {
    const { input, output, outputText } = fakePromptStreams({ columns: 24 })
    const path = '/tmp/a-very-long-workspace-path'
    const resultPromise = promptMultiSelect({
      title: 'Purge workspaces?',
      choices: [{
        value: 'running',
        label: 'demo',
        description: `(running) ${path}`,
        focusedDescription: [
          { text: '(running)', color: 'green' },
          { text: ` ${path}`, color: 'dim' }
        ]
      }],
      skipLabel: 'Cancel',
      initialValues: ['running'],
      input,
      output,
      env: { CI: 'false' }
    })

    assert.match(outputText(), /\u001B\[32m\(running\)\u001B\[0m/)
    const rendered = outputText().replace(/\u001B\[[0-?]*[ -/]*[@-~]|\r/gu, '')
    assert.ok(rendered.replace(/[\n│ ]/gu, '').includes(`(running)${path}`))
    for (const line of rendered.split('\n').filter(Boolean)) {
      assert.ok(Array.from(line).length <= 24, line)
    }

    input.write('\r')
    assert.deepStrictEqual(await resultPromise, {
      status: 'selected',
      values: ['running']
    })
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

  test('submits raw-mode initial selections when Enter is pressed', async () => {
    const { input, output } = fakePromptStreams()
    const resultPromise = promptMultiSelect({
      title: 'Select workspace toolchains?',
      choices: [codexPromptChoice],
      initialValues: ['codex'],
      skipLabel: 'No toolchains',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('\r')

    assert.deepStrictEqual(await resultPromise, {
      status: 'selected',
      values: ['codex']
    })
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

  test('NO_COLOR removes SGR styling from the line-mode target prompt', async () => {
    const { input, output, outputText } = fakePromptStreams({ rawMode: false })
    const resultPromise = promptMultiSelect({
      title: 'Install optional SSH targets?',
      choices: [codexPromptChoice],
      skipLabel: 'Skip optional targets',
      input,
      output,
      env: { CI: 'false', NO_COLOR: '1' }
    })

    input.write('1\n')

    assert.deepStrictEqual(await resultPromise, { status: 'selected', values: ['codex'] })
    assert.doesNotMatch(outputText(), /\u001B\[[0-9;]*m/u)
    assert.doesNotMatch(outputText(), /\u001B\[/u)
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

  test('text prompt consumes a corrected retry from the same input chunk', async () => {
    const { input, output } = fakePromptStreams({ rawMode: false })
    const resultPromise = promptText({
      title: 'Tunnel port(s) to forward?',
      summaryLabel: 'Tunnel ports',
      validate: (value) => value === 'valid' ? undefined : 'Enter valid',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('invalid\nvalid\n')

    assert.deepStrictEqual(await resultPromise, {
      status: 'submitted',
      value: 'valid'
    })
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

  test('confirm prompt consumes a corrected retry from the same input chunk', async () => {
    const { input, output } = fakePromptStreams({ rawMode: false })
    const resultPromise = promptConfirm({
      title: 'Purge Boxdown workspace?',
      confirmLabel: 'Purge',
      cancelLabel: 'Cancel',
      summaryLabel: 'Purge',
      input,
      output,
      env: { CI: 'false' }
    })

    input.write('maybe\ny\n')

    assert.deepStrictEqual(await resultPromise, { status: 'confirmed' })
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
  test('doctor command returns zero for the unavailable GPG signing warning', async () => {
    const workspace = tempDir('doctor-command-gpg-warning-workspace')
    const code = await withProcessEnv({
      BOXDOWN_DATA_HOME: tempDir('doctor-command-gpg-warning-data'),
      BOXDOWN_CACHE_HOME: tempDir('doctor-command-gpg-warning-cache'),
      CI: '1'
    }, async () => await withCwd(workspace, async () => runCli(['doctor'], {
      env: { CI: '1' },
      runDoctorChecks: async () => [{
        name: 'git-signing-agent',
        level: 'warn',
        message: 'GPG commit signing is configured, but the default Boxdown image does not provide GnuPG or GPG-agent forwarding; commits in this container may fail to sign'
      }]
    })))

    assert.strictEqual(code, 0)
  })

  test('setup interactive output explains generated state outside this repository', async () => {
    const workspace = tempDir('setup-ownership-workspace')
    const dataHome = tempDir('setup-ownership-data')
    const cacheHome = tempDir('setup-ownership-cache')
    const stdout: string[] = []
    const originalWrite = process.stdout.write
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
      return true
    }) as typeof process.stdout.write
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })

    try {
      const code = await withProcessEnv({
        BOXDOWN_DATA_HOME: dataHome,
        BOXDOWN_CACHE_HOME: cacheHome,
        CI: 'false'
      }, async () => await withCwd(workspace, async () => runCli(['setup'], {
          env: { CI: 'false', BOXDOWN_DATA_HOME: dataHome, BOXDOWN_CACHE_HOME: cacheHome },
          waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
          runDoctorChecks: async () => [],
          setupWorkspace: async () => {}
        })))

      assert.strictEqual(code, 0)
    } finally {
      process.stdout.write = originalWrite
      if (originalIsTTY === undefined) {
        delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY
      } else {
        Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
      }
    }

    assert.ok(stdout.join('').includes('Boxdown keeps generated state outside this repository.'))
    assert.ok(stdout.join('').includes('Run `boxdown status` to inspect managed paths and the command log.'))
  })

  test('successful detailed setup prints the concrete workspace command log path', async () => {
    const workspace = tempDir('setup-detailed-log-workspace')
    const dataHome = tempDir('setup-detailed-log-data')
    const cacheHome = tempDir('setup-detailed-log-cache')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_DATA_HOME: dataHome,
        BOXDOWN_CACHE_HOME: cacheHome
      },
      assetsDevcontainerDir
    })
    const stdout: string[] = []
    const originalWrite = process.stdout.write
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
      return true
    }) as typeof process.stdout.write
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })

    try {
      const code = await withProcessEnv({
        BOXDOWN_DATA_HOME: dataHome,
        BOXDOWN_CACHE_HOME: cacheHome,
        CI: 'false'
      }, async () => await withCwd(workspace, async () => runCli(['setup', '--target', 'codex', '--verbose'], {
          env: { CI: 'false', BOXDOWN_DATA_HOME: dataHome, BOXDOWN_CACHE_HOME: cacheHome },
          waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
          runDoctorChecks: async () => [],
          setupWorkspace: async () => {}
        })))

      assert.strictEqual(code, 0)
    } finally {
      process.stdout.write = originalWrite
      if (originalIsTTY === undefined) {
        delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY
      } else {
        Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
      }
    }

    assert.ok(stdout.join('').includes(`Command log: ${context.workspaceLogPath}`))
  })

  test('setup renders a Cursor warning and handoff once inside the active rail', async () => {
    const workspace = tempDir('setup-cursor-result-workspace')
    const env = {
      BOXDOWN_DATA_HOME: tempDir('setup-cursor-result-data'),
      BOXDOWN_CACHE_HOME: tempDir('setup-cursor-result-cache'),
      CI: 'false',
      NO_COLOR: '1'
    }
    const terminal = createTerminalOutputModel()
    const originalWrite = process.stdout.write
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

    process.stdout.write = ((chunk: string | Uint8Array) => {
      terminal.write(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
      return true
    }) as typeof process.stdout.write
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })

    let code: number
    try {
      code = await withProcessEnv(env, async () => runCli([
        'setup', '--workspace', workspace, '--toolchain', 'none', '--target', 'cursor', '--agent-profile', 'auth'
      ], {
        env,
        waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
        runDoctorChecks: async () => [],
        setupWorkspace: async (_context, _alias, setupOptions) => {
          for (const stepId of [
            'ssh-identity',
            'devcontainer-config',
            'devcontainer-start',
            'ssh-alias',
            'ssh-target:cursor'
          ]) {
            setupOptions.progress?.startStep(stepId)
            setupOptions.progress?.completeStep(stepId)
          }
          return setupCursorWarningReport()
        }
      }))
    } finally {
      process.stdout.write = originalWrite
      if (originalIsTTY === undefined) {
        delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY
      } else {
        Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
      }
    }

    const output = terminal.text()
    const outcome = 'Setup complete with warnings'
    const remediation = 'cursor --install-extension anysphere.remote-ssh'
    const action = "cursor --folder-uri 'vscode-remote://ssh-remote+demo-devcontainer/workspaces/demo'"
    assert.strictEqual(code, 0)
    for (const line of [outcome, remediation, action]) {
      assert.strictEqual(output.split(line).length - 1, 1, line)
    }
    assert.ok(output.indexOf(outcome) < output.indexOf(remediation))
    assert.ok(output.indexOf(remediation) < output.indexOf(action))
    assert.ok(output.indexOf(action) < output.lastIndexOf('└'))
    assert.doesNotMatch(output, /Cursor settings:/)
    assert.doesNotMatch(output, /Cursor remote folder URI:/)
    assert.doesNotMatch(output, /SSH connection not tested/)
  })

  test('setup continues app configuration after a partial failure and returns failure status', async () => {
    const workspace = tempDir('setup-partial-result-workspace')
    const env = {
      BOXDOWN_DATA_HOME: tempDir('setup-partial-result-data'),
      BOXDOWN_CACHE_HOME: tempDir('setup-partial-result-cache'),
      CI: 'false',
      NO_COLOR: '1'
    }
    const terminal = createTerminalOutputModel()
    const originalWrite = process.stdout.write
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    const targetCalls: string[] = []

    process.stdout.write = ((chunk: string | Uint8Array) => {
      terminal.write(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
      return true
    }) as typeof process.stdout.write
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })

    let code: number
    try {
      code = await withProcessEnv(env, async () => runCli([
        'setup', '--workspace', workspace, '--toolchain', 'none', '--target', 'codex', '--target', 'cursor', '--agent-profile', 'auth'
      ], {
        env,
        waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
        runDoctorChecks: async () => [],
        setupWorkspace: async (context, alias, setupOptions) => setupWorkspace(context, alias, {
          ...setupOptions,
          start: async () => {
            for (const stepId of ['ssh-identity', 'devcontainer-config', 'devcontainer-start']) {
              setupOptions.progress?.startStep(stepId)
              setupOptions.progress?.completeStep(stepId)
            }
            return 'setup-container'
          },
          installSsh: async () => setupSshResult(alias),
          installTarget: async (_context, _alias, target) => {
            targetCalls.push(target)
            if (target === 'codex') throw new Error('invalid ChatGPT config')
            if (target === 'cursor') return setupAppResult(target)
            throw new Error(`Unexpected target: ${target}`)
          }
        })
      }))
    } finally {
      process.stdout.write = originalWrite
      if (originalIsTTY === undefined) {
        delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY
      } else {
        Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
      }
    }

    const output = terminal.text()
    assert.strictEqual(code, 1)
    assert.deepStrictEqual(targetCalls, ['codex', 'cursor'])
    assert.match(output, /✖ Configuring ChatGPT app/)
    assert.match(output, /✔ Configuring Cursor/)
    assert.match(output, /Setup incomplete/)
    assert.match(output, /boxdown ssh install --target codex/)
    assert.match(output, /Open this project in Cursor:/)
    assert.doesNotMatch(output, /Restart ChatGPT/)
  })

  test('setup preflight stops before prompts or state writes when runtime readiness fails', async () => {
    const workspace = tempDir('setup-preflight-failure-workspace')
    const dataHome = tempDir('setup-preflight-failure-data')
    const cacheHome = tempDir('setup-preflight-failure-cache')
    const calls: string[] = []
    const { input, output, outputText } = fakePromptStreams()

    const code = await withProcessEnv({
      BOXDOWN_DATA_HOME: dataHome,
      BOXDOWN_CACHE_HOME: cacheHome,
      CI: 'false'
    }, async () => runCli(['setup', '--workspace', workspace], {
      env: { CI: 'false', BOXDOWN_DATA_HOME: dataHome, BOXDOWN_CACHE_HOME: cacheHome },
      promptInput: input,
      promptOutput: output,
      waitForContainerRuntime: async () => {
        calls.push('runtime')
        return {
          state: 'failed',
          failure: {
            reason: 'docker-daemon-unavailable',
            command: ['docker', 'info'],
            detail: 'Cannot connect'
          },
          timedOut: true,
          timeoutMs: 60_000
        }
      },
      runDoctorChecks: async () => {
        calls.push('doctor')
        return []
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
    assert.deepStrictEqual(calls, ['runtime'])
    assert.strictEqual(existsSync(context.workspaceDataDir), false)
    assert.strictEqual(existsSync(context.sshKeyPath), false)
    assert.strictEqual(existsSync(context.generatedConfigPath), false)
    assert.doesNotMatch(outputText(), /Add this project to an AI coding app/)
    assert.doesNotMatch(outputText(), /How much host agent data should Boxdown use/)
  })

  test('prompts for an agent profile after an explicit setup target', async () => {
    const workspace = tempDir('setup-profile-explicit-target-workspace')
    const env = {
      CI: 'false',
      BOXDOWN_CACHE_HOME: tempDir('setup-profile-explicit-target-cache'),
      BOXDOWN_DATA_HOME: tempDir('setup-profile-explicit-target-data')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const { input, output, outputText } = fakePromptStreams()
    let receivedProfile: AgentProfile | undefined

    const runPromise = withProcessEnv(env, async () => runCli([
      'setup', '--workspace', workspace, '--target', 'codex'
    ], {
      env,
      promptInput: input,
      promptOutput: output,
      waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
      runDoctorChecks: async () => [],
      setupWorkspace: async (_context, _alias, setupOptions) => {
        receivedProfile = setupOptions.agentProfile
      }
    }))

    await waitForPromptOutput(outputText, /Select workspace toolchains\?/)
    input.write('\r')
    await waitForPromptOutput(
      outputText,
      /How much host agent data should Boxdown use in the container\?/
    )
    input.write('\u001B[B\r')

    assert.strictEqual(await runPromise, 0)
    assert.strictEqual(receivedProfile, 'full')
    assert.strictEqual(readWorkspaceMetadata(context)?.agentProfile, 'full')
  })

  test('prompts for profile after a prompt-selected app target', async () => {
    const workspace = tempDir('setup-profile-sequential-workspace')
    const env = {
      CI: 'false',
      BOXDOWN_CACHE_HOME: tempDir('setup-profile-sequential-cache'),
      BOXDOWN_DATA_HOME: tempDir('setup-profile-sequential-data')
    }
    const { input, output, outputText } = fakePromptStreams()
    let receivedProfile: AgentProfile | undefined

    const runPromise = withProcessEnv(env, async () => runCli([
      'setup', '--workspace', workspace
    ], {
      env,
      promptInput: input,
      promptOutput: output,
      waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
      runDoctorChecks: async () => [],
      setupWorkspace: async (_context, _alias, setupOptions) => {
        receivedProfile = setupOptions.agentProfile
      }
    }))

    await waitForPromptOutput(outputText, /Select workspace toolchains\?/)
    input.write('\r')
    await waitForPromptOutput(outputText, /Add this project to an AI coding app/)
    input.write('\u001B[A\u001B[A \r')
    await waitForPromptOutput(outputText, /How much host agent data should Boxdown use/)
    input.write('\u001B[A\r')

    assert.strictEqual(await runPromise, 0)
    assert.strictEqual(receivedProfile, 'none')
  })

  test('skipping interactive targets suppresses the profile prompt and uses recorded or default fallback', async () => {
    for (const entry of [
      { name: 'recorded profile', recorded: 'full' as const, expected: 'full' as const },
      { name: 'default profile', expected: 'auth' as const }
    ]) {
      const slug = entry.name.replaceAll(' ', '-')
      const workspace = tempDir(`setup-profile-target-skip-${slug}-workspace`)
      const env = {
        CI: 'false',
        BOXDOWN_CACHE_HOME: tempDir(`setup-profile-target-skip-${slug}-cache`),
        BOXDOWN_DATA_HOME: tempDir(`setup-profile-target-skip-${slug}-data`)
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      const { input, output, outputText } = fakePromptStreams()
      let receivedProfile: AgentProfile | undefined

      if (entry.recorded !== undefined) {
        writeWorkspaceMetadata(context, 'recorded-profile-devcontainer', undefined, entry.recorded)
      }

      const runPromise = withProcessEnv(env, async () => runCli([
        'setup', '--workspace', workspace
      ], {
        env,
        promptInput: input,
        promptOutput: output,
        waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
        runDoctorChecks: async () => [],
        setupWorkspace: async (_context, _alias, setupOptions) => {
          receivedProfile = setupOptions.agentProfile
        }
      }))

      await waitForPromptOutput(outputText, /Select workspace toolchains\?/)
      input.write('\r')
      await waitForPromptOutput(outputText, /Add this project to an AI coding app/)
      input.write('\r')

      assert.strictEqual(await runPromise, 0, entry.name)
      assert.strictEqual(receivedProfile, entry.expected, entry.name)
      assert.strictEqual(readWorkspaceMetadata(context)?.agentProfile, entry.expected, entry.name)
      assert.doesNotMatch(outputText(), /How much host agent data should Boxdown use/, entry.name)
    }
  })

  test('cancelling interactive target selection suppresses the profile prompt and setup mutations', async () => {
    const workspace = tempDir('setup-profile-target-cancel-workspace')
    const env = {
      CI: 'false',
      BOXDOWN_CACHE_HOME: tempDir('setup-profile-target-cancel-cache'),
      BOXDOWN_DATA_HOME: tempDir('setup-profile-target-cancel-data')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const { input, output, outputText } = fakePromptStreams()
    let setupCalls = 0

    const runPromise = withProcessEnv(env, async () => runCli([
      'setup', '--workspace', workspace
    ], {
      env,
      promptInput: input,
      promptOutput: output,
      waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
      runDoctorChecks: async () => [],
      setupWorkspace: async () => {
        setupCalls += 1
      }
    }))

    await waitForPromptOutput(outputText, /Select workspace toolchains\?/)
    input.write('\r')
    await waitForPromptOutput(outputText, /Add this project to an AI coding app/)
    input.write('\u0003')

    assert.strictEqual(await runPromise, 1)
    assert.strictEqual(setupCalls, 0)
    assert.deepStrictEqual(readToolchainPlan(context)?.selected, [])
    assert.strictEqual(existsSync(context.generatedConfigPath), false)
    assert.doesNotMatch(outputText(), /How much host agent data should Boxdown use/)
  })

  test('persists and forwards prompted default auth', async () => {
    const workspace = tempDir('setup-profile-prompted-default-workspace')
    const env = {
      CI: 'false',
      BOXDOWN_CACHE_HOME: tempDir('setup-profile-prompted-default-cache'),
      BOXDOWN_DATA_HOME: tempDir('setup-profile-prompted-default-data')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const { input, output, outputText } = fakePromptStreams()
    let receivedProfile: AgentProfile | undefined

    const runPromise = withProcessEnv(env, async () => runCli([
      'setup', '--workspace', workspace, '--target', 'codex'
    ], {
      env,
      promptInput: input,
      promptOutput: output,
      waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
      runDoctorChecks: async () => [],
      setupWorkspace: async (_context, _alias, setupOptions) => {
        receivedProfile = setupOptions.agentProfile
      }
    }))

    await waitForPromptOutput(outputText, /Select workspace toolchains\?/)
    input.write('\r')
    await waitForPromptOutput(outputText, /How much host agent data should Boxdown use/)
    input.write('\r')

    assert.strictEqual(await runPromise, 0)
    assert.strictEqual(receivedProfile, 'auth')
    assert.strictEqual(readWorkspaceMetadata(context)?.agentProfile, 'auth')
  })

  test('cancelling the profile prompt preserves existing metadata without invoking setup lifecycle', async () => {
    const workspace = tempDir('setup-profile-cancel-workspace')
    const env = {
      CI: 'false',
      BOXDOWN_CACHE_HOME: tempDir('setup-profile-cancel-cache'),
      BOXDOWN_DATA_HOME: tempDir('setup-profile-cancel-data')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const { input, output, outputText } = fakePromptStreams()
    let setupCalls = 0

    writeWorkspaceMetadata(context, 'preserved-profile-devcontainer', undefined, 'full')

    const runPromise = withProcessEnv(env, async () => runCli([
      'setup', '--workspace', workspace, '--target', 'claude'
    ], {
      env,
      promptInput: input,
      promptOutput: output,
      waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
      runDoctorChecks: async () => [],
      setupWorkspace: async () => {
        setupCalls += 1
      }
    }))

    await waitForPromptOutput(outputText, /Select workspace toolchains\?/)
    input.write('\r')
    await waitForPromptOutput(outputText, /How much host agent data should Boxdown use/)
    input.write('\u0003')

    assert.strictEqual(await runPromise, 1)
    assert.strictEqual(setupCalls, 0)
    assert.strictEqual(readWorkspaceMetadata(context)?.agentProfile, 'full')
    assert.strictEqual(existsSync(context.generatedConfigPath), false)
    assert.strictEqual(existsSync(context.sshKeyPath), false)
  })

  test('uses setup agent profile precedence without unnecessary prompts', async () => {
    const cases = [
      {
        name: 'explicit profile suppresses prompt',
        argv: ['--target', 'codex', '--agent-profile', 'none'],
        recorded: 'full',
        expected: 'none'
      },
      {
        name: 'no target retains metadata',
        argv: [],
        recorded: 'full',
        expected: 'full'
      },
      {
        name: 'no target defaults to auth',
        argv: [],
        expected: 'auth'
      },
      {
        name: 'non-interactive target retains metadata',
        argv: ['--target', 'claude'],
        recorded: 'none',
        expected: 'none',
        ci: true
      }
    ] as const

    for (const entry of cases) {
      const slug = entry.name.replaceAll(' ', '-')
      const workspace = tempDir(`setup-profile-${slug}-workspace`)
      const env = {
        CI: entry.ci === true ? '1' : 'false',
        BOXDOWN_CACHE_HOME: tempDir(`setup-profile-${slug}-cache`),
        BOXDOWN_DATA_HOME: tempDir(`setup-profile-${slug}-data`)
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      const input = new PassThrough() as PassThrough & PromptInput
      const output = new PassThrough() as PassThrough & PromptOutput
      const outputChunks: Buffer[] = []
      input.isTTY = false
      output.isTTY = false
      output.on('data', (chunk: Buffer) => outputChunks.push(chunk))
      let receivedProfile: AgentProfile | undefined

      if (entry.recorded !== undefined) {
        writeWorkspaceMetadata(context, 'recorded-profile-devcontainer', undefined, entry.recorded)
      }

      const code = await withProcessEnv(env, async () => runCli([
        'setup', '--workspace', workspace, ...entry.argv
      ], {
        env,
        promptInput: input,
        promptOutput: output,
        waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
        runDoctorChecks: async () => [],
        setupWorkspace: async (_context, _alias, setupOptions) => {
          receivedProfile = setupOptions.agentProfile
        }
      }))

      assert.strictEqual(code, 0, entry.name)
      assert.strictEqual(receivedProfile, entry.expected, entry.name)
      assert.strictEqual(readWorkspaceMetadata(context)?.agentProfile, entry.expected, entry.name)
      assert.doesNotMatch(Buffer.concat(outputChunks).toString('utf8'), /How much host agent data/, entry.name)
    }
  })

  test('invalid agent profiles do not create metadata or invoke the container runtime', async () => {
    const workspace = tempDir('invalid-agent-profile-workspace')
    const env = {
      CI: '1',
      BOXDOWN_CACHE_HOME: tempDir('invalid-agent-profile-cache'),
      BOXDOWN_DATA_HOME: tempDir('invalid-agent-profile-data')
    }
    const calls: string[] = []

    const code = await withProcessEnv(env, async () => runCli([
      'start', '--workspace', workspace, '--agent-profile', 'other'
    ], {
      env,
      waitForContainerRuntime: async () => {
        calls.push('runtime')
        return { state: 'ready', mode: 'buildx', warnings: [] }
      },
      writeWorkspaceMetadata: () => { calls.push('metadata') }
    }))

    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    assert.strictEqual(code, 1)
    assert.deepStrictEqual(calls, [])
    assert.strictEqual(existsSync(workspaceMetadataPath(context)), false)
  })

  test('forwards the resolved agent profile through the start lifecycle', async () => {
    const workspace = tempDir('agent-profile-lifecycle-workspace')
    const env = {
      CI: '1',
      BOXDOWN_CACHE_HOME: tempDir('agent-profile-lifecycle-cache'),
      BOXDOWN_DATA_HOME: tempDir('agent-profile-lifecycle-data')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const calls: string[] = []

    writeWorkspaceMetadata(context, 'agent-profile-devcontainer', undefined, 'full')
    writeToolchainPlan(context, toolchainPlanFor(context, 'none'))

    const code = await withProcessEnv(env, async () => runCli([
      'start', '--workspace', workspace, '--agent-profile', 'none'
    ], {
      env,
      prepareContainerLifecycle: async (_context, _alias, _progress, _options, _logger, profile) => {
        calls.push(`lifecycle:${profile}`)
      },
      startDevcontainer: async (_context, options) => {
        calls.push(`start:${options.agentProfile}`)
        return 'agent-profile-container'
      },
      printPortHint: async () => { calls.push('port') },
      openShell: async () => { calls.push('shell'); return 0 }
    }))

    assert.strictEqual(code, 0)
    assert.deepStrictEqual(calls, ['lifecycle:none', 'start:none', 'port', 'shell'])
  })

  test('propagates agent profile through every container lifecycle', async () => {
    const cases: Array<{
      name: string
      argv: string[]
      explicit?: 'none' | 'auth' | 'full'
      recorded?: 'none' | 'auth' | 'full'
      expected: 'none' | 'auth' | 'full'
      refresh?: boolean
      shortCircuitAfterStart?: boolean
    }> = [
      { name: 'setup explicit', argv: ['setup'], explicit: 'full', recorded: 'none', expected: 'full' },
      { name: 'start metadata', argv: ['start'], recorded: 'none', expected: 'none' },
      { name: 'Codex default', argv: ['codex'], expected: 'auth' },
      { name: 'Claude explicit', argv: ['claude'], explicit: 'full', recorded: 'none', expected: 'full' },
      { name: 'OpenCode metadata', argv: ['opencode'], recorded: 'none', expected: 'none' },
      { name: 'Antigravity default', argv: ['antigravity'], expected: 'auth' },
      { name: 'SSH proxy explicit', argv: ['ssh-proxy'], explicit: 'full', recorded: 'auth', expected: 'full', shortCircuitAfterStart: true },
      { name: 'tunnel metadata', argv: ['tunnel', '--port', '8080'], recorded: 'none', expected: 'none', shortCircuitAfterStart: true },
      { name: 'refresh GitHub token default', argv: ['refresh-gh-token'], expected: 'auth', refresh: true }
    ]

    for (const entry of cases) {
      const slug = entry.name.toLowerCase().replaceAll(' ', '-')
      const workspace = tempDir(`propagates-agent-profile-${slug}-workspace`)
      const env = {
        CI: '1',
        BOXDOWN_CACHE_HOME: tempDir(`propagates-agent-profile-${slug}-cache`),
        BOXDOWN_DATA_HOME: tempDir(`propagates-agent-profile-${slug}-data`),
        BOXDOWN_SSH_CONFIG: join(tempDir(`propagates-agent-profile-${slug}-ssh`), 'config')
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      const starts: Array<'none' | 'auth' | 'full' | undefined> = []
      const refreshes: Array<'none' | 'auth' | 'full' | undefined> = []
      const sentinel = new Error(`stop after start: ${entry.name}`)

      if (entry.recorded !== undefined) {
        writeWorkspaceMetadata(context, 'recorded-profile-devcontainer', undefined, entry.recorded)
      }
      if (['start', 'shell', 'codex', 'claude', 'cc', 'opencode', 'antigravity'].includes(entry.argv[0] ?? '')) {
        writeToolchainPlan(context, toolchainPlanFor(context, 'none'))
      }

      const argv = [
        ...entry.argv,
        '--workspace',
        workspace,
        ...(entry.explicit === undefined ? [] : ['--agent-profile', entry.explicit])
      ]
      const runCase = async (): Promise<number> => withProcessEnv(env, async () => runCli(argv, {
        env,
        waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
        runDoctorChecks: async () => [],
        prepareContainerLifecycle: async (receivedContext, alias, progress, lifecycleOptions, logger, profile) => {
          await prepareContainerLifecycle(receivedContext, alias, progress, lifecycleOptions, logger, profile)
        },
        setupWorkspace: async (receivedContext, alias, setupOptions) => {
          await setupWorkspace(receivedContext, alias, {
            ...setupOptions,
            start: async (_startContext, startOptions) => {
              starts.push(startOptions.agentProfile)
              return 'profile-container'
            },
            installSsh: async () => {},
            installTarget: async () => {}
          })
        },
        startDevcontainer: async (_startContext, startOptions) => {
          starts.push(startOptions.agentProfile)
          if (entry.shortCircuitAfterStart === true) throw sentinel
          return 'profile-container'
        },
        printPortHint: async () => {},
        openShell: async () => 0,
        ensureContainerCodingAgentCli: async () => {},
        openCodingAgentCli: async () => 0,
        refreshContainerGhAuth: async (_refreshContext, refreshOptions) => {
          refreshes.push(refreshOptions.agentProfile)
        }
      }))
      const code = entry.shortCircuitAfterStart === true
        ? await assert.rejects(runCase(), (error: unknown) => error === sentinel).then(() => 1)
        : await runCase()

      assert.strictEqual(code, entry.shortCircuitAfterStart === true ? 1 : 0, entry.name)
      assert.deepStrictEqual(starts, [entry.expected], entry.name)
      assert.strictEqual(readWorkspaceMetadata(context)?.agentProfile, entry.expected, entry.name)
      assert.deepStrictEqual(refreshes, entry.refresh === true ? [entry.expected] : [], entry.name)
    }
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
      waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] }),
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

  test('gated lifecycle branches invoke readiness before metadata or downstream state', async () => {
    const cases: Array<{ name: string, argv: string[] }> = [
      { name: 'start', argv: ['start'] },
      { name: 'shell alias', argv: ['shell'] },
      { name: 'ssh proxy', argv: ['ssh-proxy'] },
      { name: 'tunnel', argv: ['tunnel', '--port', '8080'] },
      { name: 'GitHub token refresh', argv: ['refresh-gh-token'] },
      { name: 'Codex', argv: ['codex'] },
      { name: 'Claude', argv: ['claude'] },
      { name: 'Claude alias', argv: ['cc'] },
      { name: 'OpenCode', argv: ['opencode'] },
      { name: 'Antigravity', argv: ['antigravity'] }
    ]

    for (const entry of cases) {
      const workspace = tempDir(`lifecycle-gate-${entry.name.replaceAll(' ', '-')}-workspace`)
      const dataHome = tempDir(`lifecycle-gate-${entry.name.replaceAll(' ', '-')}-data`)
      const cacheHome = tempDir(`lifecycle-gate-${entry.name.replaceAll(' ', '-')}-cache`)
      const env = { CI: '1', BOXDOWN_DATA_HOME: dataHome, BOXDOWN_CACHE_HOME: cacheHome }
      const calls: string[] = []
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      if (['start', 'shell', 'codex', 'claude', 'cc', 'opencode', 'antigravity'].includes(entry.argv[0] ?? '')) {
        writeToolchainPlan(context, toolchainPlanFor(context, 'none'))
      }

      const expectedError = `blocked at lifecycle gate: ${entry.name}`
      await assert.rejects(withProcessEnv(env, async () => runCli([
        ...entry.argv,
        '--workspace',
        workspace
      ], {
        env,
        prepareContainerLifecycle: async (receivedContext, alias, _progress, _options, logger) => {
          assert.strictEqual(receivedContext.workspaceFolder, realpathSync(workspace), entry.name)
          assert.strictEqual(alias, defaultSshAlias(receivedContext.workspaceBasename), entry.name)
          assert.notStrictEqual(logger, undefined, entry.name)
          calls.push('gate')
          throw new Error(expectedError)
        }
      })), (error: unknown) => {
        assert.ok(error instanceof Error, entry.name)
        assert.strictEqual(error.message, expectedError, entry.name)
        return true
      })

      assert.deepStrictEqual(calls, ['gate'], entry.name)
      assert.strictEqual(existsSync(workspaceMetadataPath(context)), false, entry.name)
      assert.strictEqual(existsSync(context.generatedConfigPath), false, entry.name)
      assert.strictEqual(existsSync(context.sshKeyPath), false, entry.name)
    }
  })

  test('reuses a running devcontainer for direct interactive commands', async () => {
    const cases: Array<{ argv: string[], agent?: CodingAgentCli }> = [
      { argv: ['start'] },
      { argv: ['shell'] },
      { argv: ['codex'], agent: 'codex' },
      { argv: ['claude'], agent: 'claude' },
      { argv: ['cc'], agent: 'claude' },
      { argv: ['opencode'], agent: 'opencode' },
      { argv: ['antigravity'], agent: 'antigravity' }
    ]

    for (const entry of cases) {
      const workspace = tempDir('direct-reuse-' + entry.argv[0] + '-workspace')
      const env = {
        CI: '1',
        BOXDOWN_CACHE_HOME: tempDir('direct-reuse-' + entry.argv[0] + '-cache'),
        BOXDOWN_DATA_HOME: tempDir('direct-reuse-' + entry.argv[0] + '-data')
      }
      const calls: string[] = []
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      writeToolchainPlan(context, toolchainPlanFor(context, 'none'))

      const code = await withProcessEnv(env, async () => runCli([...entry.argv, '--workspace', workspace], {
        env,
        prepareContainerLifecycle: async () => { calls.push('lifecycle') },
        startDevcontainer: async (_context, startOptions) => {
          assert.strictEqual(startOptions.recreate, false)
          assert.strictEqual(startOptions.reuseRunning, true)
          calls.push('start')
          return 'running-container'
        },
        ...(entry.agent === undefined
          ? {
              printPortHint: async () => { calls.push('port') },
              openShell: async () => { calls.push('shell'); return 0 }
            }
          : {
              ensureContainerCodingAgentCli: async (_context, agent) => {
                assert.strictEqual(agent, entry.agent)
                calls.push('ensure:' + agent)
              },
              openCodingAgentCli: async (_context, agent) => {
                assert.strictEqual(agent, entry.agent)
                calls.push('open:' + agent)
                return 0
              }
            })
      }))

      assert.strictEqual(code, 0)
      assert.deepStrictEqual(
        calls,
        entry.agent === undefined
          ? ['lifecycle', 'start', 'port', 'shell']
          : ['lifecycle', 'start', 'ensure:' + entry.agent, 'open:' + entry.agent]
      )
    }
  })

  test('preserves recreate for direct interactive commands', async () => {
    const cases: Array<{ argv: string[], agent: CodingAgentCli }> = [
      { argv: ['start', '--recreate'], agent: 'codex' },
      { argv: ['cc', '--recreate'], agent: 'claude' }
    ]

    for (const entry of cases) {
      const workspace = tempDir('direct-recreate-' + entry.argv[0] + '-workspace')
      const env = {
        CI: '1',
        BOXDOWN_CACHE_HOME: tempDir('direct-recreate-' + entry.argv[0] + '-cache'),
        BOXDOWN_DATA_HOME: tempDir('direct-recreate-' + entry.argv[0] + '-data')
      }
      const calls: string[] = []
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      writeToolchainPlan(context, toolchainPlanFor(context, 'none'))

      const code = await withProcessEnv(env, async () => runCli([...entry.argv, '--workspace', workspace], {
        env,
        prepareContainerLifecycle: async () => { calls.push('lifecycle') },
        startDevcontainer: async (_context, startOptions) => {
          assert.strictEqual(startOptions.recreate, true)
          assert.strictEqual(startOptions.reuseRunning, true)
          calls.push('start')
          return 'recreated-container'
        },
        ...(entry.argv[0] === 'start'
          ? {
              printPortHint: async () => { calls.push('port') },
              openShell: async () => { calls.push('shell'); return 0 }
            }
          : {
              ensureContainerCodingAgentCli: async (_context, agent) => {
                assert.strictEqual(agent, entry.agent)
                calls.push('ensure:' + agent)
              },
              openCodingAgentCli: async (_context, agent) => {
                assert.strictEqual(agent, entry.agent)
                calls.push('open:' + agent)
                return 0
              }
            })
      }))

      assert.strictEqual(code, 0)
      assert.deepStrictEqual(
        calls,
        entry.argv[0] === 'start'
          ? ['lifecycle', 'start', 'port', 'shell']
          : ['lifecycle', 'start', 'ensure:' + entry.agent, 'open:' + entry.agent]
      )
    }
  })

  test('refreshes GitHub auth in a matching running devcontainer without startup', async () => {
    const workspace = tempDir('running-refresh-workspace')
    const env = { CI: '1', BOXDOWN_DATA_HOME: tempDir('running-refresh-data'), BOXDOWN_CACHE_HOME: tempDir('running-refresh-cache') }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const calls: string[] = []

    const code = await withProcessEnv(env, async () => runCli(['refresh-gh-token', '--workspace', workspace], {
      env,
      findRunningContainerId: async () => { calls.push('find'); return 'running-container' },
      assertContainerAgentProfile: async (id, profile) => {
        assert.strictEqual(id, 'running-container')
        assert.strictEqual(profile, 'auth')
        calls.push('profile')
      },
      prepareContainerLifecycle: async () => { calls.push('unexpected:lifecycle') },
      startDevcontainer: async () => { calls.push('unexpected:start'); return 'unexpected' },
      refreshContainerGhAuth: async (_context, refreshOptions) => {
        assert.strictEqual(refreshOptions.agentProfile, 'auth')
        assert.strictEqual(refreshOptions.progress?.hasStep('devcontainer-running'), true)
        assert.strictEqual(refreshOptions.progress?.hasStep('devcontainer-start'), false)
        calls.push('refresh')
      }
    }))

    assert.strictEqual(code, 0)
    assert.deepStrictEqual(calls, ['find', 'profile', 'refresh'])
    assert.strictEqual(existsSync(workspaceMetadataPath(context)), false)
  })

  test('rejects a profile mismatch in a running devcontainer before refresh or startup', async () => {
    const workspace = tempDir('running-refresh-mismatch-workspace')
    const env = { CI: '1', BOXDOWN_DATA_HOME: tempDir('running-refresh-mismatch-data'), BOXDOWN_CACHE_HOME: tempDir('running-refresh-mismatch-cache') }
    const calls: string[] = []
    const mismatch = new Error('Agent profile full is not active in this devcontainer.')

    await assert.rejects(withProcessEnv(env, async () => runCli(['refresh-gh-token', '--workspace', workspace, '--agent-profile', 'full'], {
      env,
      findRunningContainerId: async () => { calls.push('find'); return 'running-container' },
      assertContainerAgentProfile: async (_id, profile) => {
        assert.strictEqual(profile, 'full')
        calls.push('profile')
        throw mismatch
      },
      prepareContainerLifecycle: async () => { calls.push('unexpected:lifecycle') },
      startDevcontainer: async () => { calls.push('unexpected:start'); return 'unexpected' },
      refreshContainerGhAuth: async () => { calls.push('unexpected:refresh') }
    })), (error: unknown) => error === mismatch)

    assert.deepStrictEqual(calls, ['find', 'profile'])
  })

  test('starts then refreshes GitHub auth when no devcontainer is running', async () => {
    const workspace = tempDir('fallback-refresh-workspace')
    const env = { CI: '1', BOXDOWN_DATA_HOME: tempDir('fallback-refresh-data'), BOXDOWN_CACHE_HOME: tempDir('fallback-refresh-cache') }
    const calls: string[] = []

    const code = await withProcessEnv(env, async () => runCli(['refresh-gh-token', '--workspace', workspace, '--agent-profile', 'none'], {
      env,
      findRunningContainerId: async () => { calls.push('find'); return undefined },
      prepareContainerLifecycle: async (_context, _alias, _progress, _options, _logger, profile) => {
        assert.strictEqual(profile, 'none')
        calls.push('lifecycle')
      },
      startDevcontainer: async (_context, startOptions) => {
        assert.strictEqual(startOptions.agentProfile, 'none')
        calls.push('start')
        return 'started-container'
      },
      refreshContainerGhAuth: async (_context, refreshOptions) => {
        assert.strictEqual(refreshOptions.agentProfile, 'none')
        assert.strictEqual(refreshOptions.progress?.hasStep('devcontainer-start'), true)
        calls.push('refresh')
      }
    }))

    assert.strictEqual(code, 0)
    assert.deepStrictEqual(calls, ['find', 'lifecycle', 'start', 'refresh'])
  })

  test('container lifecycle writes metadata only after readiness succeeds', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('container-lifecycle-order-workspace'),
      env: { BOXDOWN_CACHE_HOME: tempDir('container-lifecycle-order-cache'), BOXDOWN_DATA_HOME: tempDir('container-lifecycle-order-data') },
      assetsDevcontainerDir
    })
    const progress = createProgress({ mode: 'none' })
    progress.setSteps([{ id: 'container-runtime', label: 'Checking container runtime' }])
    const calls: string[] = []

    await prepareContainerLifecycle(context, 'boxdown-order', progress, {
      waitForContainerRuntime: async () => {
        calls.push('runtime')
        return { state: 'ready', mode: 'buildx', warnings: [] }
      },
      writeWorkspaceMetadata: () => { calls.push('metadata') }
    })

    assert.deepStrictEqual(calls, ['runtime', 'metadata'])
  })

  test('container lifecycle persists the default agent profile for direct callers', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('container-lifecycle-default-profile-workspace'),
      env: { BOXDOWN_CACHE_HOME: tempDir('container-lifecycle-default-profile-cache'), BOXDOWN_DATA_HOME: tempDir('container-lifecycle-default-profile-data') },
      assetsDevcontainerDir
    })
    const progress = createProgress({ mode: 'none' })
    progress.setSteps([{ id: 'container-runtime', label: 'Checking container runtime' }])

    await prepareContainerLifecycle(context, 'boxdown-default-profile', progress, {
      waitForContainerRuntime: async () => ({ state: 'ready', mode: 'buildx', warnings: [] })
    })

    assert.strictEqual(readWorkspaceMetadata(context)?.agentProfile, 'auth')
  })

  test('container lifecycle preserves provenance when metadata is created after a plan', async () => {
    const workspace = tempDir('lifecycle-toolchain-provenance-workspace')
    const env = {
      BOXDOWN_CACHE_HOME: tempDir('lifecycle-toolchain-provenance-cache'),
      BOXDOWN_DATA_HOME: tempDir('lifecycle-toolchain-provenance-data')
    }
    const context = createWorkspaceContext({workspace, env, assetsDevcontainerDir})
    const progress = createProgress({mode: 'none'})
    const plan = toolchainPlanFor(context, 'none')
    writeToolchainPlan(context, plan)

    await prepareContainerLifecycle(context, 'lifecycle-toolchain-provenance-devcontainer', progress, {
      env,
      waitForContainerRuntime: async () => ({state: 'ready', mode: 'buildx', warnings: []})
    })

    assert.strictEqual(readWorkspaceMetadata(context)?.toolchainPlanUpdatedAt, plan.updatedAt)
  })

  test('verbose readiness emits a final outcome for Buildx and fallback success', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('verbose-runtime-ready-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('verbose-runtime-ready-cache'),
        BOXDOWN_DATA_HOME: tempDir('verbose-runtime-ready-data')
      },
      assetsDevcontainerDir
    })
    const fallbackWarning = 'Docker Buildx is unavailable; the Dev Containers CLI will use its classic-build fallback.'
    const cases = [
      { mode: 'buildx' as const, warnings: [] },
      { mode: 'fallback' as const, warnings: [fallbackWarning] }
    ]

    for (const ready of cases) {
      const lines: string[] = []
      const progress = createProgress({
        mode: 'verbose',
        write: (_target, message) => { lines.push(message) }
      })
      progress.setSteps([{ id: 'container-runtime', label: 'Checking container runtime' }])

      await runContainerRuntimePreflight(context, progress, {
        waitForContainerRuntime: async () => ({ state: 'ready', ...ready })
      })

      assert.strictEqual(lines.filter((line) => line === 'Container runtime ready').length, 1)
      assert.strictEqual(lines.filter((line) => line === `Warning: ${fallbackWarning}`).length, ready.mode === 'fallback' ? 1 : 0)
    }
  })

  test('a readiness failure leaves no state and a later attempt decides afresh', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('container-lifecycle-recovery-workspace'),
      env: { BOXDOWN_CACHE_HOME: tempDir('container-lifecycle-recovery-cache'), BOXDOWN_DATA_HOME: tempDir('container-lifecycle-recovery-data') },
      assetsDevcontainerDir
    })
    const progress = createProgress({ mode: 'none' })
    progress.setSteps([{ id: 'container-runtime', label: 'Checking container runtime' }])
    const calls: string[] = []

    await assert.rejects(prepareContainerLifecycle(context, 'boxdown-recovery', progress, {
      waitForContainerRuntime: async () => ({
        state: 'failed',
        failure: { reason: 'docker-daemon-unavailable', command: ['docker', 'info'], detail: 'starting' },
        timedOut: true,
        timeoutMs: 60_000
      }),
      writeWorkspaceMetadata: () => { calls.push('unexpected metadata') }
    }), /Docker daemon did not become ready/)

    assert.deepStrictEqual(calls, [])
    assert.strictEqual(existsSync(workspaceMetadataPath(context)), false)
    assert.strictEqual(existsSync(context.generatedConfigPath), false)
    assert.strictEqual(existsSync(context.sshKeyPath), false)

    progress.setSteps([{ id: 'container-runtime', label: 'Checking container runtime' }])
    await prepareContainerLifecycle(context, 'boxdown-recovery', progress, {
      waitForContainerRuntime: async () => {
        calls.push('fresh runtime')
        return { state: 'ready', mode: 'buildx', warnings: [] }
      },
      writeWorkspaceMetadata: () => { calls.push('metadata') }
    })

    assert.deepStrictEqual(calls, ['fresh runtime', 'metadata'])
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

    const report = await setupWorkspace(context, alias, {
      start: async (receivedContext, options) => {
        assert.strictEqual(receivedContext, context)
        assert.deepStrictEqual(options, { agentProfile: 'auth', recreate: undefined })
        assert.strictEqual('reuseRunning' in options, false)
        calls.push('start')
        return 'setup-container'
      },
      installSsh: async (receivedContext, receivedAlias) => {
        assert.strictEqual(receivedContext, context)
        assert.strictEqual(receivedAlias, alias)
        calls.push('ssh')
        return setupSshResult(alias)
      }
    })

    assert.deepStrictEqual(calls, ['start', 'ssh'])
    assert.strictEqual(report.ssh?.alias, alias)
    assert.deepStrictEqual(report.apps, [])
    assert.deepStrictEqual(report.failures, [])
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

    const report = await setupWorkspace(context, alias, {
      recreate: true,
      targets: ['codex'],
      start: async (receivedContext, options) => {
        assert.strictEqual(receivedContext, context)
        assert.deepStrictEqual(options, { agentProfile: 'auth', recreate: true })
        calls.push('start')
        return 'setup-container'
      },
      installSsh: async () => {
        calls.push('ssh')
        return setupSshResult(alias)
      },
      installTarget: async (receivedContext, receivedAlias, target) => {
        assert.strictEqual(receivedContext, context)
        assert.strictEqual(receivedAlias, alias)
        assert.strictEqual(target, 'codex')
        calls.push('codex')
        return setupAppResult('codex')
      }
    })

    assert.deepStrictEqual(calls, ['start', 'ssh', 'codex'])
    assert.deepStrictEqual(report.apps.map((app) => app.target), ['codex'])
    assert.deepStrictEqual(report.failures, [])
  })

  test('setup workflow uses progress-aware structured installs', async () => {
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
    progress.setSteps([
      { id: 'ssh-alias', label: 'Configuring SSH alias' },
      { id: 'ssh-target:codex', label: 'Configuring ChatGPT app' }
    ])
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
        assert.strictEqual(installOptions, undefined)
        calls.push('ssh')
        return setupSshResult(alias)
      },
      installTarget: async (receivedContext, receivedAlias, target, installOptions) => {
        assert.strictEqual(receivedContext, context)
        assert.strictEqual(receivedAlias, alias)
        assert.strictEqual(target, 'codex')
        assert.strictEqual(installOptions, undefined)
        calls.push('codex')
        return setupAppResult('codex')
      }
    })

    assert.deepStrictEqual(calls, ['start', 'ssh', 'codex'])
    assert.ok(lines.some((line) => line.includes('Configuring SSH alias')))
    assert.ok(lines.some((line) => line.includes('Configuring ChatGPT app')))
  })

  test('setup workflow uses structured progress and installs in detailed mode', async () => {
    const workspace = tempDir('setup-detailed-progress-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('setup-detailed-progress-cache'),
        BOXDOWN_DATA_HOME: tempDir('setup-detailed-progress-data')
      },
      assetsDevcontainerDir
    })
    const alias = 'demo-devcontainer'
    const lines: string[] = []
    const progress = createProgress({
      mode: 'detailed',
      write: (_target, message) => {
        lines.push(message)
      }
    })
    progress.setSteps([
      { id: 'ssh-alias', label: 'Configuring SSH alias' },
      { id: 'ssh-target:codex', label: 'Configuring ChatGPT app' }
    ])
    const calls: string[] = []

    await setupWorkspace(context, alias, {
      progress,
      targets: ['codex'],
      start: async () => {
        calls.push('start')
        return 'setup-container'
      },
      installSsh: async (_receivedContext, _receivedAlias, installOptions) => {
        assert.strictEqual(installOptions, undefined)
        calls.push('ssh')
        return setupSshResult(alias)
      },
      installTarget: async (_receivedContext, _receivedAlias, target, installOptions) => {
        assert.strictEqual(target, 'codex')
        assert.strictEqual(installOptions, undefined)
        calls.push('codex')
        return setupAppResult('codex')
      }
    })

    assert.deepStrictEqual(calls, ['start', 'ssh', 'codex'])
    assert.deepStrictEqual(lines, [
      'Configuring SSH alias',
      'Configuring ChatGPT app'
    ])
  })

  test('interactive TTY setup returns the Cursor handoff and keeps the checklist coherent after completion redraw', async () => {
    const workspace = tempDir('setup-cursor-interactive-workspace')
    const sshConfigPath = join(tempDir('setup-cursor-interactive-ssh'), 'config')
    const settingsPath = join(tempDir('setup-cursor-interactive-settings'), 'settings.json')
    const cursor = fakeCursorCli('github.copilot')
    const env = {
      HOME: tempDir('setup-cursor-interactive-home'),
      BOXDOWN_CACHE_HOME: tempDir('setup-cursor-interactive-cache'),
      BOXDOWN_DATA_HOME: tempDir('setup-cursor-interactive-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('setup-cursor-interactive-runtime'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CURSOR_SETTINGS: settingsPath,
      BOXDOWN_HOST_PATH_PREFIX: cursor.env.BOXDOWN_HOST_PATH_PREFIX as string,
      BOXDOWN_FAKE_CURSOR_LOG: cursor.env.BOXDOWN_FAKE_CURSOR_LOG as string,
      BOXDOWN_FAKE_CURSOR_EXTENSIONS: cursor.env.BOXDOWN_FAKE_CURSOR_EXTENSIONS as string,
      BOXDOWN_FAKE_CURSOR_EXIT_CODE: cursor.env.BOXDOWN_FAKE_CURSOR_EXIT_CODE as string
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const alias = `${context.workspaceBasename}-devcontainer`
    const terminal = createTerminalOutputModel()
    const progress = createProgress({
      mode: 'interactive',
      isTTY: true,
      spinnerIntervalMs: 60_000,
      write: (_target, message) => terminal.write(`${message}\n`),
      writeRaw: (_target, message) => terminal.write(message)
    })
    const setupSteps = [
      { id: 'ssh-identity', label: 'Preparing SSH identity' },
      { id: 'devcontainer-config', label: 'Writing devcontainer configuration' },
      { id: 'devcontainer-start', label: 'Starting devcontainer' },
      { id: 'ssh-alias', label: 'Configuring SSH alias' },
      { id: 'ssh-target:cursor', label: 'Configuring Cursor' }
    ] as const
    progress.section('Boxdown setup')
    progress.setSteps(setupSteps)
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ 'remote.SSH.configFile': sshConfigPath }))
    const originalStderrWrite = process.stderr.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') terminal.write(chunk)
      return true
    }) as typeof process.stderr.write

    let report: RemoteAccessInstallReport
    try {
      report = await withProcessEnv(env, async () => setupWorkspace(context, alias, {
        progress,
        targets: ['cursor'],
        start: async () => {
          for (const step of setupSteps.slice(0, 3)) {
            progress.startStep(step.id)
            progress.completeStep(step.id)
          }
          return 'setup-container'
        },
        installSsh: async () => setupSshResult(alias),
        installTarget: installSshInstallTarget
      }))
    } finally {
      process.stderr.write = originalStderrWrite
      progress.end()
    }

    const output = terminal.text()
    const folderUri = `vscode-remote://ssh-remote+${alias}/workspaces/${encodeURIComponent(context.workspaceBasename)}`
    assert.deepStrictEqual(report.apps.map((app) => app.target), ['cursor'])
    assert.deepStrictEqual(report.failures, [])
    assert.strictEqual(report.apps[0]?.action.command, `cursor --folder-uri '${folderUri}'`)
    assert.deepStrictEqual(report.apps[0]?.details, [
      { label: 'Cursor settings', value: settingsPath },
      { label: 'Cursor remote folder URI', value: folderUri }
    ])
    assert.deepStrictEqual(report.apps[0]?.warnings.map((warning) => warning.remediation?.command), [
      'cursor --install-extension anysphere.remote-ssh'
    ])
    assert.doesNotMatch(output, /Cursor settings:|Cursor remote folder URI:|Cursor open command:/)
    for (const step of setupSteps) {
      assert.strictEqual(output.split(step.label).length - 1, 1, step.label)
      assert.ok(output.includes(`✔ ${step.label}`), step.label)
    }
    assert.deepStrictEqual(fakeCursorCalls(cursor.logPath), ['--list-extensions'])
  })

  test('detailed and non-TTY setup return the Cursor handoff without launching Cursor', async () => {
    for (const scenario of [
      { name: 'detailed', mode: 'detailed', isTTY: true },
      { name: 'non-tty', mode: 'interactive', isTTY: false }
    ] as const) {
      const workspace = tempDir(`setup-cursor-${scenario.name}-workspace`)
      const sshConfigPath = join(tempDir(`setup-cursor-${scenario.name}-ssh`), 'config')
      const settingsPath = join(tempDir(`setup-cursor-${scenario.name}-settings`), 'settings.json')
      const cursor = fakeCursorCli()
      const env = {
        HOME: tempDir(`setup-cursor-${scenario.name}-home`),
        BOXDOWN_CACHE_HOME: tempDir(`setup-cursor-${scenario.name}-cache`),
        BOXDOWN_DATA_HOME: tempDir(`setup-cursor-${scenario.name}-data`),
        BOXDOWN_RUNTIME_HOME: tempDir(`setup-cursor-${scenario.name}-runtime`),
        BOXDOWN_SSH_CONFIG: sshConfigPath,
        BOXDOWN_CURSOR_SETTINGS: settingsPath,
        BOXDOWN_HOST_PATH_PREFIX: cursor.env.BOXDOWN_HOST_PATH_PREFIX as string,
        BOXDOWN_FAKE_CURSOR_LOG: cursor.env.BOXDOWN_FAKE_CURSOR_LOG as string,
        BOXDOWN_FAKE_CURSOR_EXTENSIONS: cursor.env.BOXDOWN_FAKE_CURSOR_EXTENSIONS as string,
        BOXDOWN_FAKE_CURSOR_EXIT_CODE: cursor.env.BOXDOWN_FAKE_CURSOR_EXIT_CODE as string
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      const alias = `${context.workspaceBasename}-devcontainer`
      const output: string[] = []
      const progress = createProgress({
        mode: scenario.mode,
        isTTY: scenario.isTTY,
        write: (_target, message) => output.push(`${message}\n`),
        writeRaw: (_target, message) => output.push(message)
      })
      progress.setSteps([
        { id: 'ssh-alias', label: 'Configuring SSH alias' },
        { id: 'ssh-target:cursor', label: 'Configuring Cursor' }
      ])
      mkdirSync(dirname(settingsPath), { recursive: true })
      writeFileSync(settingsPath, JSON.stringify({ 'remote.SSH.configFile': sshConfigPath }))

      let report: RemoteAccessInstallReport
      try {
        report = await withProcessEnv(env, async () => setupWorkspace(context, alias, {
          progress,
          targets: ['cursor'],
          start: async () => 'setup-container',
          installSsh: async () => setupSshResult(alias),
          installTarget: installSshInstallTarget
        }))
      } finally {
        progress.end()
      }

      const rendered = output.join('')
      const folderUri = `vscode-remote://ssh-remote+${alias}/workspaces/${encodeURIComponent(context.workspaceBasename)}`
      assert.deepStrictEqual(report.apps.map((app) => app.target), ['cursor'], scenario.name)
      assert.deepStrictEqual(report.failures, [], scenario.name)
      assert.strictEqual(report.apps[0]?.action.command, `cursor --folder-uri '${folderUri}'`, scenario.name)
      assert.doesNotMatch(rendered, /Cursor settings:|Cursor remote folder URI:|Cursor open command:/, scenario.name)
      assert.deepStrictEqual(fakeCursorCalls(cursor.logPath), ['--list-extensions'], scenario.name)
    }
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

  test('down removes workspace runtime secret state after removing the container', async () => {
    const workspace = tempDir('down-runtime-secret-workspace')
    const env = {
      HOME: tempDir('down-runtime-secret-home'),
      BOXDOWN_CACHE_HOME: tempDir('down-runtime-secret-cache'),
      BOXDOWN_DATA_HOME: tempDir('down-runtime-secret-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('down-runtime-secret-runtime')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    mkdirSync(context.workspaceSecretEnvDir, { recursive: true })
    writeFileSync(join(context.workspaceSecretEnvDir, 'SNYK_TOKEN'), 'runtime-secret-sentinel')

    await withFakeDocker([
      { workspace, id: 'down-runtime-secret-container' }
    ], async (_logPath, dockerEnv) => {
      const result = runCliProcess(['down', '--workspace', workspace], { ...dockerEnv, ...env })

      assert.strictEqual(result.code, 0)
      assert.strictEqual(existsSync(context.workspaceRuntimeDir), false)
      assert.strictEqual(existsSync(context.workspaceFolder), true)
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
    assert.match(result.stdout, /SSH alias configured/)
    assert.match(result.stdout, /Configuration complete/)
    assert.match(result.stdout, /Next step/)
    assert.match(result.stdout, /Restart ChatGPT/)
    assert.doesNotMatch(result.stdout, /SSH connection not tested/)
    assert.doesNotMatch(result.stdout, /ChatGPT config:/)
    assert.doesNotMatch(result.stdout, /Identity file/)
    assert.doesNotMatch(result.stdout, /\u001B\[/)
    assert.strictEqual(existsSync(sshConfigPath), true)
    assert.strictEqual(codexConfig.remoteConnections.length, 1)
    assert.strictEqual(codexConfig.remoteConnections[0]?.projects[0]?.label, realpathSync(workspace).split('/').at(-1))
  })

  test('ssh install preserves metadata-only agent profile state', () => {
    const cases: Array<{ name: string, initialProfile?: 'full', writeMetadata: boolean }> = [
      { name: 'existing-profile', initialProfile: 'full', writeMetadata: true },
      { name: 'legacy-profile', writeMetadata: true },
      { name: 'missing-profile', writeMetadata: false }
    ]

    for (const entry of cases) {
      const workspace = tempDir(`ssh-install-agent-profile-${entry.name}-workspace`)
      const env = {
        HOME: tempDir(`ssh-install-agent-profile-${entry.name}-home`),
        BOXDOWN_CACHE_HOME: tempDir(`ssh-install-agent-profile-${entry.name}-cache`),
        BOXDOWN_DATA_HOME: tempDir(`ssh-install-agent-profile-${entry.name}-data`),
        BOXDOWN_SSH_CONFIG: join(tempDir(`ssh-install-agent-profile-${entry.name}-ssh`), 'config')
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

      if (entry.writeMetadata) {
        writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename), undefined, entry.initialProfile)
      }

      const result = runCliProcess(['ssh', 'install', '--workspace', workspace], { ...process.env, ...env })

      assert.strictEqual(result.code, 0, entry.name)
      assert.strictEqual(readWorkspaceMetadata(context)?.agentProfile, entry.initialProfile, entry.name)
    }
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
    assert.match(result.stdout, /SSH alias configured/)
    assert.match(result.stdout, /Configuration complete/)
    assert.match(result.stdout, /Next step/)
    assert.match(result.stdout, /Restart Claude/)
    assert.doesNotMatch(result.stdout, /SSH connection not tested/)
    assert.doesNotMatch(result.stdout, /Claude SSH config/)
    assert.doesNotMatch(result.stdout, /Identity file/)
    assert.doesNotMatch(result.stdout, /\u001B\[/)
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

  test('installs explicit Cursor target and prints connection details without launching Cursor', () => {
    const workspace = tempDir('cli-explicit-cursor-workspace')
    const workspaceName = realpathSync(workspace).split('/').at(-1) ?? 'workspace'
    const alias = `${workspaceName}-devcontainer`
    const sshConfigPath = join(tempDir('cli-explicit-cursor-ssh'), 'config')
    const cursorSettingsPath = join(tempDir('cli-explicit-cursor-settings'), 'settings.json')
    const cursor = fakeCursorCli('github.copilot\nANySphere.Remote-SSH')
    mkdirSync(dirname(cursorSettingsPath), { recursive: true })
    writeFileSync(cursorSettingsPath, JSON.stringify({ 'remote.SSH.configFile': sshConfigPath }))
    const result = runCliProcess(['ssh', 'install', '--workspace', workspace, '--target', 'cursor'], {
      ...process.env,
      ...cursor.env,
      HOME: tempDir('cli-explicit-cursor-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-explicit-cursor-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-explicit-cursor-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CURSOR_SETTINGS: cursorSettingsPath
    })
    const folderUri = `vscode-remote://ssh-remote+${alias}/workspaces/${encodeURIComponent(workspaceName)}`

    assert.strictEqual(result.code, 0)
    assert.match(result.stdout, /SSH alias configured/)
    assert.match(result.stdout, /Configuration complete/)
    assert.match(result.stdout, /Next step/)
    assert.match(result.stdout, /Open this project in Cursor/)
    assert.doesNotMatch(result.stdout, /SSH connection not tested/)
    assert.doesNotMatch(result.stdout, /Cursor settings/)
    assert.doesNotMatch(result.stdout, /Identity file/)
    assert.doesNotMatch(result.stdout, /\u001B\[/)
    assert.deepStrictEqual(cursorRemotePlatforms(cursorSettingsPath), { [alias]: 'linux' })
    assert.ok(result.stdout.includes(folderUri))
    assert.ok(result.stdout.includes(`cursor --folder-uri '${folderUri}'`))
    assert.deepStrictEqual(fakeCursorCalls(cursor.logPath), ['--list-extensions'])
  })

  test('Cursor extension probe failures warn without rolling back configuration or mirroring output', () => {
    const cases = [
      { name: 'missing-extension', extensions: 'private.probe-output', exitCode: 0 },
      { name: 'failed-query', extensions: 'private.failed-output', exitCode: 23 }
    ]

    for (const entry of cases) {
      const workspace = tempDir(`cli-cursor-probe-${entry.name}-workspace`)
      const sshConfigPath = join(tempDir(`cli-cursor-probe-${entry.name}-ssh`), 'config')
      const cursorSettingsPath = join(tempDir(`cli-cursor-probe-${entry.name}-settings`), 'settings.json')
      const cursor = fakeCursorCli(entry.extensions, entry.exitCode)
      mkdirSync(dirname(cursorSettingsPath), { recursive: true })
      writeFileSync(cursorSettingsPath, JSON.stringify({ 'remote.SSH.configFile': sshConfigPath }))
      const result = runCliProcess(['ssh', 'install', '--workspace', workspace, '--target', 'cursor'], {
        ...process.env,
        ...cursor.env,
        HOME: tempDir(`cli-cursor-probe-${entry.name}-home`),
        BOXDOWN_CACHE_HOME: tempDir(`cli-cursor-probe-${entry.name}-cache`),
        BOXDOWN_DATA_HOME: tempDir(`cli-cursor-probe-${entry.name}-data`),
        BOXDOWN_SSH_CONFIG: sshConfigPath,
        BOXDOWN_CURSOR_SETTINGS: cursorSettingsPath
      })
      assert.strictEqual(result.code, 0, entry.name)
      assert.strictEqual(existsSync(cursorSettingsPath), true, entry.name)
      assert.match(result.stdout, /Configuration complete with warnings/, entry.name)
      assert.match(result.stdout, /Could not verify Cursor Remote SSH/, entry.name)
      assert.match(result.stdout, /cursor --install-extension anysphere\.remote-ssh/u, entry.name)
      assert.strictEqual(result.stderr, '', entry.name)
      assert.doesNotMatch(result.stdout, /private\.(?:probe|failed)-output/u, entry.name)
      assert.deepStrictEqual(fakeCursorCalls(cursor.logPath), ['--list-extensions'], entry.name)
    }
  })

  test('ssh install reports already configured state on rerun', () => {
    const workspace = tempDir('cli-idempotent-workspace')
    const sshConfigPath = join(tempDir('cli-idempotent-ssh'), 'config')
    const cursorSettingsPath = join(tempDir('cli-idempotent-cursor-settings'), 'settings.json')
    const cursor = fakeCursorCli('anysphere.remote-ssh')
    mkdirSync(dirname(cursorSettingsPath), { recursive: true })
    writeFileSync(cursorSettingsPath, JSON.stringify({ 'remote.SSH.configFile': sshConfigPath }))
    const args = ['ssh', 'install', '--workspace', workspace, '--target', 'cursor']
    const env = {
      ...process.env,
      ...cursor.env,
      HOME: tempDir('cli-idempotent-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-idempotent-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-idempotent-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CURSOR_SETTINGS: cursorSettingsPath
    }

    const first = runCliProcess(args, env)
    const second = runCliProcess(args, env)

    assert.strictEqual(first.code, 0)
    assert.strictEqual(second.code, 0)
    assert.match(second.stdout, /SSH alias already configured/)
    assert.match(second.stdout, /Cursor already configured|Cursor already compatible/)
    assert.match(second.stdout, /Configuration complete/)
  })

  test('ssh install verbose output includes diagnostic details', () => {
    const workspace = tempDir('cli-verbose-workspace')
    const sshConfigPath = join(tempDir('cli-verbose-ssh'), 'config')
    const cursorSettingsPath = join(tempDir('cli-verbose-cursor-settings'), 'settings.json')
    const cursor = fakeCursorCli('anysphere.remote-ssh')
    mkdirSync(dirname(cursorSettingsPath), { recursive: true })
    writeFileSync(cursorSettingsPath, JSON.stringify({ 'remote.SSH.configFile': sshConfigPath }))
    const result = runCliProcess(['ssh', 'install', '--workspace', workspace, '--target', 'cursor', '--verbose'], {
      ...process.env,
      ...cursor.env,
      HOME: tempDir('cli-verbose-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-verbose-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-verbose-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CURSOR_SETTINGS: cursorSettingsPath
    })

    assert.strictEqual(result.code, 0)
    assert.match(result.stdout, /SSH config/)
    assert.match(result.stdout, /Identity file/)
    assert.match(result.stdout, /Cursor settings/)
    assert.match(result.stdout, /Cursor remote folder URI/)
  })

  test('ssh install preserves a compatible user-owned Cursor mapping', () => {
    const workspace = tempDir('cli-cursor-compatible-workspace')
    const workspaceName = realpathSync(workspace).split('/').at(-1) ?? 'workspace'
    const alias = `${workspaceName}-devcontainer`
    const sshConfigPath = join(tempDir('cli-cursor-compatible-ssh'), 'config')
    const cursorSettingsPath = join(tempDir('cli-cursor-compatible-settings'), 'settings.json')
    const cursor = fakeCursorCli('anysphere.remote-ssh')
    const originalSettings = `{\n  "remote.SSH.configFile": ${JSON.stringify(sshConfigPath)},\n  "remote.SSH.remotePlatform": {\n    ${JSON.stringify(alias)}: "linux"\n  }\n}\n`
    mkdirSync(dirname(cursorSettingsPath), { recursive: true })
    writeFileSync(cursorSettingsPath, originalSettings)

    const result = runCliProcess(['ssh', 'install', '--workspace', workspace, '--target', 'cursor'], {
      ...process.env,
      ...cursor.env,
      HOME: tempDir('cli-cursor-compatible-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-cursor-compatible-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-cursor-compatible-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CURSOR_SETTINGS: cursorSettingsPath
    })

    assert.strictEqual(result.code, 0)
    assert.match(result.stdout, /Cursor already compatible/)
    assert.match(result.stdout, /Configuration complete/)
    assert.strictEqual(readFileSync(cursorSettingsPath, 'utf8'), originalSettings)
  })

  test('ssh install continues selected app configuration after a partial failure', () => {
    const workspace = tempDir('cli-partial-failure-workspace')
    const sshConfigPath = join(tempDir('cli-partial-failure-ssh'), 'config')
    const codexConfigPath = join(tempDir('cli-partial-failure-codex'), 'config.json')
    const claudeConfigPath = join(tempDir('cli-partial-failure-claude'), 'ssh_configs.json')
    mkdirSync(dirname(codexConfigPath), { recursive: true })
    writeFileSync(codexConfigPath, '{ invalid json')

    const result = runCliProcess([
      'ssh', 'install', '--workspace', workspace, '--target', 'codex', '--target', 'claude'
    ], {
      ...process.env,
      HOME: tempDir('cli-partial-failure-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-partial-failure-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-partial-failure-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CODEX_APP_CONFIG: codexConfigPath,
      BOXDOWN_CLAUDE_SSH_CONFIGS: claudeConfigPath
    })

    assert.strictEqual(result.code, 1)
    assert.match(result.stdout, /SSH alias configured/)
    assert.match(result.stdout, /ChatGPT configuration failed/)
    assert.match(result.stdout, /Claude configured/)
    assert.match(result.stdout, /Configuration incomplete/)
    assert.doesNotMatch(result.stdout, /Restart ChatGPT/)
    assert.match(result.stdout, /boxdown ssh install --target codex/)
    assert.match(result.stdout, /Restart Claude/)
    assert.strictEqual(existsSync(claudeConfigPath), true)
  })

  test('ssh install skips selected apps after SSH alias configuration fails', () => {
    const workspace = tempDir('cli-core-failure-workspace')
    const sshConfigPath = join(tempDir('cli-core-failure-ssh'), 'config-directory')
    const codexConfigPath = join(tempDir('cli-core-failure-codex'), 'config.json')
    const claudeConfigPath = join(tempDir('cli-core-failure-claude'), 'ssh_configs.json')
    mkdirSync(sshConfigPath)

    const result = runCliProcess([
      'ssh', 'install', '--workspace', workspace, '--target', 'codex', '--target', 'claude'
    ], {
      ...process.env,
      HOME: tempDir('cli-core-failure-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-core-failure-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-core-failure-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CODEX_APP_CONFIG: codexConfigPath,
      BOXDOWN_CLAUDE_SSH_CONFIGS: claudeConfigPath
    })

    assert.strictEqual(result.code, 1)
    assert.match(result.stdout, /SSH alias failed/)
    assert.match(result.stdout, /ChatGPT skipped/)
    assert.match(result.stdout, /Claude skipped/)
    assert.match(result.stdout, /Configuration incomplete/)
    assert.strictEqual(existsSync(codexConfigPath), false)
    assert.strictEqual(existsSync(claudeConfigPath), false)
  })

  test('targeted Cursor uninstall preserves the SSH alias and removes only that mapping', () => {
    const workspace = tempDir('cli-uninstall-cursor-workspace')
    const workspaceName = realpathSync(workspace).split('/').at(-1) ?? 'workspace'
    const alias = `${workspaceName}-devcontainer`
    const sshConfigPath = join(tempDir('cli-uninstall-cursor-ssh'), 'config')
    const cursorSettingsPath = join(tempDir('cli-uninstall-cursor-settings'), 'settings.json')
    const cursor = fakeCursorCli()
    const env = {
      ...process.env,
      ...cursor.env,
      HOME: tempDir('cli-uninstall-cursor-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-uninstall-cursor-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-uninstall-cursor-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CURSOR_SETTINGS: cursorSettingsPath
    }
    mkdirSync(dirname(cursorSettingsPath), { recursive: true })
    writeFileSync(cursorSettingsPath, JSON.stringify({ 'remote.SSH.configFile': sshConfigPath }))

    assert.strictEqual(runCliProcess(['ssh', 'install', '--workspace', workspace, '--target', 'cursor'], env).code, 0)
    const result = runCliProcess(['ssh', 'uninstall', '--workspace', workspace, '--target', 'cursor'], env)

    assert.strictEqual(result.code, 0)
    assert.ok(readFileSync(sshConfigPath, 'utf8').includes(`Host ${alias}\n`))
    assert.deepStrictEqual(cursorRemotePlatforms(cursorSettingsPath), {})
    assert.match(result.stdout, /Removed Cursor Linux platform mapping:/)
    assert.doesNotMatch(result.stdout, /Removed SSH alias:/)
  })

  test('targeted Cursor cleanup reports every settings path with its exact disposition', async () => {
    const root = tempDir('cursor-cleanup-dispositions')
    const env = {
      HOME: root,
      BOXDOWN_CACHE_HOME: join(root, 'cache'),
      BOXDOWN_DATA_HOME: join(root, 'data'),
      BOXDOWN_RUNTIME_HOME: join(root, 'runtime'),
      BOXDOWN_SSH_CONFIG: join(root, '.ssh', 'config')
    }
    const workspace = join(root, 'workspace-current')
    const peerWorkspace = join(root, 'workspace-peer')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(peerWorkspace, { recursive: true })
    mkdirSync(dirname(env.BOXDOWN_SSH_CONFIG), { recursive: true })
    writeFileSync(env.BOXDOWN_SSH_CONFIG, '')
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const peerContext = createWorkspaceContext({ workspace: peerWorkspace, env, assetsDevcontainerDir })
    const alias = 'multi-path-devcontainer'
    const removedPath = join(root, 'Cursor-removed', 'settings.json')
    const userOwnedPath = join(root, 'Cursor-user-owned', 'settings.json')
    const userModifiedPath = join(root, 'Cursor-user-modified', 'settings.json')
    const sharedPath = join(root, 'Cursor-shared', 'settings.json')
    const optionsFor = (settingsPath: string) => ({
      env,
      platform: 'linux' as const,
      settingsPath,
      sshConfigPath: env.BOXDOWN_SSH_CONFIG
    })
    const writeSettings = (settingsPath: string, remotePlatform?: unknown): void => {
      mkdirSync(dirname(settingsPath), { recursive: true })
      writeFileSync(settingsPath, JSON.stringify({
        'remote.SSH.configFile': env.BOXDOWN_SSH_CONFIG,
        ...(remotePlatform === undefined ? {} : { 'remote.SSH.remotePlatform': remotePlatform })
      }))
    }

    for (const settingsPath of [removedPath, userModifiedPath, sharedPath]) {
      writeSettings(settingsPath)
      await installCursorSshTarget(context, alias, optionsFor(settingsPath))
    }
    writeSettings(userOwnedPath, { [alias]: 'linux' })
    await installCursorSshTarget(context, alias, optionsFor(userOwnedPath))
    await installCursorSshTarget(peerContext, alias, optionsFor(sharedPath))
    writeSettings(userModifiedPath, null)

    const stdout: string[] = []
    const originalStdoutWrite = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
      return true
    }) as typeof process.stdout.write
    try {
      await uninstallSshInstallTarget(context, alias, 'cursor')
    } finally {
      process.stdout.write = originalStdoutWrite
    }

    const output = stdout.join('')
    assert.ok(output.includes(`Removed Cursor Linux platform mapping: ${alias}\nCursor settings: ${removedPath}\n`))
    assert.ok(output.includes(`Preserved user-modified Cursor Linux platform mapping while releasing Boxdown ownership: ${alias}\nCursor settings: ${userModifiedPath}\n`))
    assert.ok(output.includes(`Preserved shared Cursor Linux platform mapping for another Boxdown workspace: ${alias}\nCursor settings: ${sharedPath}\n`))
    assert.ok(output.includes(`Preserved user-owned Cursor Linux platform mapping while releasing Boxdown ownership: ${alias}\nCursor settings: ${userOwnedPath}\n`))
    assert.strictEqual(output.match(/Cursor Linux platform mapping/gu)?.length, 4)
    assert.strictEqual(output.match(/Removed Cursor Linux platform mapping:/gu)?.length, 1)
  })

  test('quiet complete Cursor cleanup still warns about actionable peer uncertainty', async () => {
    const root = tempDir('cursor-cleanup-uncertainty')
    const env = {
      HOME: root,
      BOXDOWN_CACHE_HOME: join(root, 'cache'),
      BOXDOWN_DATA_HOME: join(root, 'data'),
      BOXDOWN_RUNTIME_HOME: join(root, 'runtime'),
      BOXDOWN_SSH_CONFIG: join(root, '.ssh', 'config')
    }
    const workspace = join(root, 'workspace-current')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(dirname(env.BOXDOWN_SSH_CONFIG), { recursive: true })
    writeFileSync(env.BOXDOWN_SSH_CONFIG, '')
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const alias = 'uncertain-output-devcontainer'
    const settingsPath = join(root, 'Cursor', 'settings.json')
    await installCursorSshTarget(context, alias, {
      env,
      platform: 'linux',
      settingsPath,
      sshConfigPath: env.BOXDOWN_SSH_CONFIG
    })
    const malformedPeer = join(context.dataRoot, 'workspaces', 'malformed-peer', 'cursor-integration.json')
    mkdirSync(dirname(malformedPeer), { recursive: true })
    writeFileSync(malformedPeer, '{malformed')

    const stdout: string[] = []
    const stderr: string[] = []
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
      return true
    }) as typeof process.stderr.write
    try {
      await uninstallWorkspaceSshInstallTarget(context, [], 'cursor', { quiet: true })
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
    }

    assert.strictEqual(stdout.join(''), '')
    assert.match(stderr.join(''), /Warning: Preserved Cursor Linux platform mapping because peer ownership is uncertain/)
    assert.ok(stderr.join('').includes(`${alias} (${settingsPath})`))
    assert.ok(stderr.join('').includes(`Review unreadable Cursor integration records under ${join(context.dataRoot, 'workspaces')} before removing it manually.`))
    assert.strictEqual(cursorRemotePlatforms(settingsPath)[alias], 'linux')
    assert.strictEqual(existsSync(cursorIntegrationPath(context)), false)
  })

  test('unqualified SSH uninstall cleans every recorded Cursor mapping', () => {
    const workspace = tempDir('cli-uninstall-cursor-workspace-cleanup')
    const sshConfigPath = join(tempDir('cli-uninstall-cursor-workspace-cleanup-ssh'), 'config')
    const cursorSettingsPath = join(tempDir('cli-uninstall-cursor-workspace-cleanup-settings'), 'settings.json')
    const cursor = fakeCursorCli()
    const env = {
      ...process.env,
      ...cursor.env,
      HOME: tempDir('cli-uninstall-cursor-workspace-cleanup-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-uninstall-cursor-workspace-cleanup-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-uninstall-cursor-workspace-cleanup-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CURSOR_SETTINGS: cursorSettingsPath
    }
    mkdirSync(dirname(cursorSettingsPath), { recursive: true })
    writeFileSync(cursorSettingsPath, JSON.stringify({ 'remote.SSH.configFile': sshConfigPath }))

    assert.strictEqual(runCliProcess(['ssh', 'install', '--workspace', workspace, '--alias', 'cursor-alias-a', '--target', 'cursor'], env).code, 0)
    assert.strictEqual(runCliProcess(['ssh', 'install', '--workspace', workspace, '--alias', 'cursor-alias-b', '--target', 'cursor'], env).code, 0)
    assert.deepStrictEqual(cursorRemotePlatforms(cursorSettingsPath), {
      'cursor-alias-a': 'linux',
      'cursor-alias-b': 'linux'
    })

    const result = runCliProcess(['ssh', 'uninstall', '--workspace', workspace, '--alias', 'cursor-alias-b'], env)

    assert.strictEqual(result.code, 0)
    assert.deepStrictEqual(cursorRemotePlatforms(cursorSettingsPath), {})
    assert.doesNotMatch(readFileSync(sshConfigPath, 'utf8'), /^Host cursor-alias-b$/mu)
  })

  test('uninstalls selected SSH target for Claude only', () => {
    const workspace = tempDir('cli-uninstall-claude-workspace')
    const sshConfigPath = join(tempDir('cli-uninstall-claude-ssh'), 'config')
    const codexConfigPath = join(tempDir('cli-uninstall-claude-codex'), 'config.json')
    const claudeConfigPath = join(tempDir('cli-uninstall-claude-app'), 'ssh_configs.json')
    const env = {
      ...process.env,
      HOME: tempDir('cli-uninstall-claude-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-uninstall-claude-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-uninstall-claude-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CODEX_APP_CONFIG: codexConfigPath,
      BOXDOWN_CLAUDE_SSH_CONFIGS: claudeConfigPath
    }

    const installResult = runCliProcess(['ssh', 'install', '--workspace', workspace, '--target', 'codex', '--target', 'claude'], env)
    const result = runCliProcess(['ssh', 'uninstall', '--workspace', workspace, '--target', 'claude'], env)

    assert.strictEqual(installResult.code, 0)
    assert.strictEqual(result.code, 0)
    assert.strictEqual(existsSync(sshConfigPath), true)
    assert.strictEqual(parseCodexAppConfig(JSON.parse(readFileSync(codexConfigPath, 'utf8'))).remoteConnections.length, 1)
    assert.deepStrictEqual(parseClaudeSshConfigs(JSON.parse(readFileSync(claudeConfigPath, 'utf8'))), {
      configs: [],
      trustedHosts: []
    })
    assert.match(result.stdout, /Removed Claude SSH remote:/)
    assert.doesNotMatch(result.stdout, /Removed SSH alias:/)
    assert.doesNotMatch(result.stdout, /Codex app config:/)
  })

  test('rejects an invalid alias before targeted SSH uninstall mutates app configuration', () => {
    const workspace = tempDir('cli-uninstall-invalid-alias-workspace')
    const workspaceName = realpathSync(workspace).split('/').at(-1) ?? 'workspace'
    const alias = 'invalid alias'
    const codexConfigPath = join(tempDir('cli-uninstall-invalid-alias-codex'), 'config.json')
    const originalConfig = `${JSON.stringify({
      version: 1,
      remoteConnections: [
        {
          sshAlias: alias,
          projects: [
            {
              remotePath: `/workspaces/${workspaceName}`,
              label: workspaceName
            }
          ]
        }
      ]
    }, null, 2)}\n`
    writeFileSync(codexConfigPath, originalConfig)

    const result = runCliProcess([
      'ssh',
      'uninstall',
      '--workspace',
      workspace,
      '--alias',
      alias,
      '--target',
      'codex'
    ], {
      ...process.env,
      HOME: tempDir('cli-uninstall-invalid-alias-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-uninstall-invalid-alias-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-uninstall-invalid-alias-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('cli-uninstall-invalid-alias-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: codexConfigPath,
      BOXDOWN_CODEX_GLOBAL_STATE: join(tempDir('cli-uninstall-invalid-alias-state'), '.codex-global-state.json')
    })

    assert.strictEqual(result.code, 1)
    assert.match(result.stderr, /SSH alias contains unsupported characters: invalid alias/)
    assert.strictEqual(readFileSync(codexConfigPath, 'utf8'), originalConfig)
  })

  test('uninstalls selected SSH target for Codex only', () => {
    const workspace = tempDir('cli-uninstall-codex-workspace')
    const sshConfigPath = join(tempDir('cli-uninstall-codex-ssh'), 'config')
    const codexConfigPath = join(tempDir('cli-uninstall-codex-app'), 'config.json')
    const codexStatePath = join(tempDir('cli-uninstall-codex-state'), '.codex-global-state.json')
    const claudeConfigPath = join(tempDir('cli-uninstall-codex-claude'), 'ssh_configs.json')
    const env = {
      ...process.env,
      HOME: tempDir('cli-uninstall-codex-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-uninstall-codex-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-uninstall-codex-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CODEX_APP_CONFIG: codexConfigPath,
      BOXDOWN_CODEX_GLOBAL_STATE: codexStatePath,
      BOXDOWN_CLAUDE_SSH_CONFIGS: claudeConfigPath
    }
    const workspaceName = realpathSync(workspace).split('/').at(-1) ?? 'workspace'
    const alias = `${workspaceName}-devcontainer`
    const hostId = codexDiscoveredRemoteHostId(alias)
    const canonicalRemotePath = `/workspaces/${workspaceName}`
    const legacyRemotePath = `/home/node/${workspaceName}`
    const unrelatedRemotePath = '/workspaces/unrelated'

    const installResult = runCliProcess(['ssh', 'install', '--workspace', workspace, '--target', 'codex', '--target', 'claude'], env)
    writeFileSync(codexConfigPath, `${JSON.stringify({
      version: 1,
      remoteConnections: [
        {
          sshAlias: alias,
          projects: [
            {
              remotePath: canonicalRemotePath,
              label: workspaceName
            },
            {
              remotePath: legacyRemotePath,
              label: `Legacy ${workspaceName}`
            },
            {
              remotePath: unrelatedRemotePath,
              label: 'Unrelated'
            }
          ]
        }
      ]
    }, null, 2)}\n`)
    writeFileSync(codexStatePath, `${JSON.stringify({
      'codex-managed-remote-connections': [
        {
          hostId,
          displayName: alias,
          alias
        }
      ],
      'remote-projects': [
        {
          id: 'canonical-project',
          hostId,
          remotePath: canonicalRemotePath,
          label: workspaceName
        },
        {
          id: 'legacy-project',
          hostId,
          remotePath: legacyRemotePath,
          label: workspaceName
        }
      ]
    })}\n`)

    const result = runCliProcess(['ssh', 'uninstall', '--workspace', workspace, '--target', 'codex'], env)
    const codexConfig = parseCodexAppConfig(JSON.parse(readFileSync(codexConfigPath, 'utf8')))
    const codexState = JSON.parse(readFileSync(codexStatePath, 'utf8')) as Record<string, unknown>
    const remoteProjects = codexState['remote-projects'] as Array<{ hostId?: string, remotePath?: string }>
    const claudeConfig = parseClaudeSshConfigs(JSON.parse(readFileSync(claudeConfigPath, 'utf8')))

    assert.strictEqual(installResult.code, 0)
    assert.strictEqual(result.code, 0)
    assert.strictEqual(existsSync(sshConfigPath), true)
    assert.strictEqual(codexConfig.remoteConnections.some((connection) =>
      connection.sshAlias === alias &&
      connection.projects.some((project) => project.remotePath === canonicalRemotePath || project.remotePath === legacyRemotePath)
    ), false)
    assert.deepStrictEqual(codexConfig.remoteConnections, [
      {
        sshAlias: alias,
        projects: [
          {
            remotePath: unrelatedRemotePath,
            label: 'Unrelated'
          }
        ]
      }
    ])
    assert.strictEqual(remoteProjects.some((project) =>
      project.hostId === hostId &&
      (project.remotePath === canonicalRemotePath || project.remotePath === legacyRemotePath)
    ), false)
    assert.strictEqual(claudeConfig.configs.length, 1)
    assert.deepStrictEqual(claudeConfig.trustedHosts, [alias])
    assert.match(result.stdout, /Removed Codex remote project:/)
    assert.match(result.stdout, /Removed Codex sidebar state:/)
    assert.doesNotMatch(result.stdout, /Removed SSH alias:/)
    assert.doesNotMatch(result.stdout, /Claude SSH config:/)
  })

  test('reports completed Codex app-config cleanup before global-state cleanup fails', () => {
    const workspace = tempDir('cli-uninstall-codex-partial-workspace')
    const workspaceName = realpathSync(workspace).split('/').at(-1) ?? 'workspace'
    const alias = `${workspaceName}-devcontainer`
    const codexConfigPath = join(tempDir('cli-uninstall-codex-partial-app'), 'config.json')
    const codexStatePath = join(tempDir('cli-uninstall-codex-partial-state'), '.codex-global-state.json')
    writeFileSync(codexConfigPath, `${JSON.stringify({
      version: 1,
      remoteConnections: [
        {
          sshAlias: alias,
          projects: [
            {
              remotePath: `/workspaces/${workspaceName}`,
              label: workspaceName
            }
          ]
        }
      ]
    }, null, 2)}\n`)
    writeFileSync(codexStatePath, 'invalid global state\n')

    const result = runCliProcess(['ssh', 'uninstall', '--workspace', workspace, '--target', 'codex'], {
      ...process.env,
      HOME: tempDir('cli-uninstall-codex-partial-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-uninstall-codex-partial-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-uninstall-codex-partial-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('cli-uninstall-codex-partial-ssh'), 'config'),
      BOXDOWN_CODEX_APP_CONFIG: codexConfigPath,
      BOXDOWN_CODEX_GLOBAL_STATE: codexStatePath
    })

    assert.strictEqual(result.code, 1)
    assert.match(result.stdout, /Codex app config:/)
    assert.match(result.stdout, /Removed Codex remote project:/)
    assert.match(result.stdout, /Codex app config backup:/)
    assert.doesNotMatch(result.stdout, /Codex app state:/)
  })

  test('preserves shared Codex host state when targeted uninstall leaves another project', () => {
    const firstWorkspace = tempDir('cli-uninstall-shared-first-workspace')
    const secondWorkspace = tempDir('cli-uninstall-shared-second-workspace')
    const alias = 'shared-devcontainer'
    const hostId = codexDiscoveredRemoteHostId(alias)
    const firstWorkspaceName = realpathSync(firstWorkspace).split('/').at(-1) ?? 'first-workspace'
    const secondWorkspaceName = realpathSync(secondWorkspace).split('/').at(-1) ?? 'second-workspace'
    const firstRemotePath = `/workspaces/${firstWorkspaceName}`
    const secondRemotePath = `/workspaces/${secondWorkspaceName}`
    const sshConfigPath = join(tempDir('cli-uninstall-shared-ssh'), 'config')
    const codexConfigPath = join(tempDir('cli-uninstall-shared-codex-app'), 'config.json')
    const codexStatePath = join(tempDir('cli-uninstall-shared-codex-state'), '.codex-global-state.json')
    const env = {
      ...process.env,
      HOME: tempDir('cli-uninstall-shared-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-uninstall-shared-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-uninstall-shared-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CODEX_APP_CONFIG: codexConfigPath,
      BOXDOWN_CODEX_GLOBAL_STATE: codexStatePath
    }

    const firstInstall = runCliProcess(['ssh', 'install', '--workspace', firstWorkspace, '--alias', alias, '--target', 'codex'], env)
    const secondInstall = runCliProcess(['ssh', 'install', '--workspace', secondWorkspace, '--alias', alias, '--target', 'codex'], env)
    writeFileSync(codexStatePath, `${JSON.stringify({
      'codex-managed-remote-connections': [
        {
          hostId,
          displayName: alias,
          alias
        }
      ],
      'selected-remote-host-id': hostId,
      'remote-connection-auto-connect-by-host-id': {
        [hostId]: true
      },
      'agent-mode-by-host-id': {
        [hostId]: 'auto'
      },
      'remote-projects': [
        {
          id: 'first-project',
          hostId,
          remotePath: firstRemotePath,
          label: firstWorkspaceName
        },
        {
          id: 'second-project',
          hostId,
          remotePath: secondRemotePath,
          label: secondWorkspaceName
        }
      ]
    })}\n`)

    const result = runCliProcess(['ssh', 'uninstall', '--workspace', firstWorkspace, '--alias', alias, '--target', 'codex'], env)
    const codexConfig = parseCodexAppConfig(JSON.parse(readFileSync(codexConfigPath, 'utf8')))
    const codexState = JSON.parse(readFileSync(codexStatePath, 'utf8')) as Record<string, unknown>

    assert.strictEqual(firstInstall.code, 0)
    assert.strictEqual(secondInstall.code, 0)
    assert.strictEqual(result.code, 0)
    assert.match(readFileSync(sshConfigPath, 'utf8'), /^Host shared-devcontainer$/mu)
    assert.deepStrictEqual(codexConfig.remoteConnections, [
      {
        sshAlias: alias,
        projects: [
          {
            remotePath: secondRemotePath,
            label: secondWorkspaceName
          }
        ]
      }
    ])
    assert.deepStrictEqual(codexState['remote-projects'], [
      {
        id: 'second-project',
        hostId,
        remotePath: secondRemotePath,
        label: secondWorkspaceName
      }
    ])
    assert.deepStrictEqual(codexState['codex-managed-remote-connections'], [
      {
        hostId,
        displayName: alias,
        alias
      }
    ])
    assert.strictEqual(codexState['selected-remote-host-id'], hostId)
    assert.deepStrictEqual(codexState['remote-connection-auto-connect-by-host-id'], {
      [hostId]: true
    })
    assert.deepStrictEqual(codexState['agent-mode-by-host-id'], {
      [hostId]: 'auto'
    })
    assert.doesNotMatch(result.stdout, /Removed SSH alias:/)
  })

  test('uninstalls selected SSH targets together without removing the SSH alias', () => {
    const workspace = tempDir('cli-uninstall-targets-workspace')
    const sshConfigPath = join(tempDir('cli-uninstall-targets-ssh'), 'config')
    const codexConfigPath = join(tempDir('cli-uninstall-targets-codex'), 'config.json')
    const claudeConfigPath = join(tempDir('cli-uninstall-targets-claude'), 'ssh_configs.json')
    const env = {
      ...process.env,
      HOME: tempDir('cli-uninstall-targets-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-uninstall-targets-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-uninstall-targets-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CODEX_APP_CONFIG: codexConfigPath,
      BOXDOWN_CLAUDE_SSH_CONFIGS: claudeConfigPath
    }

    const installResult = runCliProcess(['ssh', 'install', '--workspace', workspace, '--target', 'codex', '--target', 'claude'], env)
    const result = runCliProcess(['ssh', 'uninstall', '--workspace', workspace, '--target', 'codex', '--target', 'claude'], env)

    assert.strictEqual(installResult.code, 0)
    assert.strictEqual(result.code, 0)
    assert.strictEqual(existsSync(sshConfigPath), true)
    assert.notStrictEqual(readFileSync(sshConfigPath, 'utf8'), '')
    assert.deepStrictEqual(parseCodexAppConfig(JSON.parse(readFileSync(codexConfigPath, 'utf8'))).remoteConnections, [])
    assert.deepStrictEqual(parseClaudeSshConfigs(JSON.parse(readFileSync(claudeConfigPath, 'utf8'))), {
      configs: [],
      trustedHosts: []
    })
    assert.doesNotMatch(result.stdout, /Removed SSH alias:/)
  })

  test('uninstalls all SSH integrations when no target is selected', () => {
    const workspace = tempDir('cli-uninstall-all-workspace')
    const sshConfigPath = join(tempDir('cli-uninstall-all-ssh'), 'config')
    const codexConfigPath = join(tempDir('cli-uninstall-all-codex'), 'config.json')
    const claudeConfigPath = join(tempDir('cli-uninstall-all-claude'), 'ssh_configs.json')
    const env = {
      ...process.env,
      HOME: tempDir('cli-uninstall-all-home'),
      BOXDOWN_CACHE_HOME: tempDir('cli-uninstall-all-cache'),
      BOXDOWN_DATA_HOME: tempDir('cli-uninstall-all-data'),
      BOXDOWN_SSH_CONFIG: sshConfigPath,
      BOXDOWN_CODEX_APP_CONFIG: codexConfigPath,
      BOXDOWN_CLAUDE_SSH_CONFIGS: claudeConfigPath
    }

    const installResult = runCliProcess(['ssh', 'install', '--workspace', workspace, '--target', 'codex', '--target', 'claude'], env)
    const result = runCliProcess(['ssh', 'uninstall', '--workspace', workspace], env)

    assert.strictEqual(installResult.code, 0)
    assert.strictEqual(result.code, 0)
    assert.strictEqual(readFileSync(sshConfigPath, 'utf8'), '')
    assert.deepStrictEqual(parseCodexAppConfig(JSON.parse(readFileSync(codexConfigPath, 'utf8'))).remoteConnections, [])
    assert.deepStrictEqual(parseClaudeSshConfigs(JSON.parse(readFileSync(claudeConfigPath, 'utf8'))), {
      configs: [],
      trustedHosts: []
    })
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
    assert.match(result.stdout, /No optional app integrations were selected/)
    assert.match(result.stdout, /boxdown ssh install with\s+--target codex, --target claude, or --target cursor/)
    assert.strictEqual(existsSync(sshConfigPath), true)
    assert.strictEqual(existsSync(codexConfigPath), false)
  })

  test('installs prompt-selected Codex ssh install target', async () => {
    const workspace = tempDir('cli-prompt-codex-workspace')
    const sshConfigPath = join(tempDir('cli-prompt-codex-ssh'), 'config')
    const codexConfigPath = join(tempDir('cli-prompt-codex-app'), 'config.json')
    const { input, output, outputText } = fakePromptStreams()

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
      input.write('\u001B[A')
      input.write(' ')
      input.write('\r')

      return runPromise
    })
    const codexConfig = parseCodexAppConfig(JSON.parse(readFileSync(codexConfigPath, 'utf8')))
    const promptOutput = outputText().replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')

    assert.strictEqual(code, 0)
    assert.strictEqual(existsSync(sshConfigPath), true)
    assert.strictEqual(codexConfig.remoteConnections[0]?.sshAlias, defaultSshAlias(realpathSync(workspace).split('/').at(-1) ?? 'workspace'))
    assert.match(promptOutput, /Add this project to an AI coding app\? \(Select any\)/)
    assert.match(promptOutput, /ChatGPT app - Connect ChatGPT to this project\./)
    assert.match(promptOutput, /Claude app - Connect Claude to this project\./)
    assert.match(promptOutput, /Cursor - Connect Cursor to this project\./)
    assert.match(promptOutput, /Not now — Finish setup without adding the project to an app\./)
  })

  test('cancels prompted ssh install without installing', async () => {
    const workspace = tempDir('cli-prompt-cancel-workspace')
    const sshConfigPath = join(tempDir('cli-prompt-cancel-ssh'), 'config')
    const codexConfigPath = join(tempDir('cli-prompt-cancel-app'), 'config.json')
    const dataDir = tempDir('cli-prompt-cancel-data')
    const { input, output } = fakePromptStreams()
    const originalStderrWrite = process.stderr.write
    let stderr = ''

    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += chunk.toString()
      return true
    }) as typeof process.stderr.write

    let code: number
    try {
      code = await withProcessEnv({
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
    } finally {
      process.stderr.write = originalStderrWrite
    }

    assert.strictEqual(code, 1)
    assert.match(stderr, /SSH install canceled\. No changes made\./)
    assert.strictEqual(existsSync(sshConfigPath), false)
    assert.strictEqual(existsSync(codexConfigPath), false)
    assert.deepStrictEqual(listWorkspaceMetadata(dataDir), [])
  })

  test('purge plan describes concrete resources and retained workspace files', async () => {
    const workspace = tempDir('purge-plan-workspace')
    const env = {
      HOME: tempDir('purge-plan-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-plan-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-plan-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('purge-plan-runtime')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    mkdirSync(context.workspaceRuntimeDir, { recursive: true })
    writeFileSync(context.generatedConfigPath, '{}\n')
    writeWorkspaceMetadata(context, 'recorded-devcontainer')
    recordWorkspaceDockerImage(context, { id: 'sha256:stale-recorded-image', name: 'boxdown-stale:latest' })

    await withFakeDocker([
      {
        workspace,
        id: 'purge-plan-container',
        containerState: 'running',
        imageId: 'sha256:purge-plan-image',
        imageName: 'boxdown-plan:latest'
      }
    ], async (_logPath, dockerEnv) => {
      await withProcessEnv({ ...dockerEnv, ...env }, async () => {
        const text = formatPurgePlanText(await createPurgePlan(context, { alias: 'provided-devcontainer' }))

        assert.match(text, /Docker container: purge-plan-container \(running\)/)
        assert.match(text, /Docker image if still unused during removal: boxdown-plan:latest \(sha256:purge-plan-image\)/)
        assert.doesNotMatch(text, /Recorded Docker image used by this workspace: boxdown-stale:latest/)
        assert.match(text, /Docker volumes attached only to that container/)
        assert.ok(text.includes(`SSH connection: provided-devcontainer, recorded-devcontainer, ${defaultSshAlias(context.workspaceBasename)}`))
        assert.match(text, /Codex, Claude, and Cursor integrations for those SSH connections, when installed/)
        assert.ok(text.includes(context.workspaceCacheDir))
        assert.ok(text.includes(context.workspaceDataDir))
        assert.ok(text.includes(context.workspaceRuntimeDir))
        assert.ok(text.includes(`Your repository and files: ${context.workspaceFolder}`))
        assert.match(text, /Other Docker containers, images, volumes, and Boxdown workspaces/)
      })
    })
  })

  test('purge plan retains an image known to be shared by another workspace', async () => {
    const workspace = tempDir('purge-plan-shared-workspace')
    const peerWorkspace = tempDir('purge-plan-shared-peer')
    const env = {
      HOME: tempDir('purge-plan-shared-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-plan-shared-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-plan-shared-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('purge-plan-shared-runtime')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      {
        workspace,
        id: 'purge-plan-container',
        imageId: 'sha256:purge-plan-image',
        imageName: 'boxdown-plan:latest'
      },
      {
        workspace: peerWorkspace,
        id: 'purge-plan-peer',
        containerState: 'exited',
        imageId: 'sha256:purge-plan-image',
        imageName: 'boxdown-plan:latest'
      }
    ], async (_logPath, dockerEnv) => {
      await withProcessEnv({ ...dockerEnv, ...env }, async () => {
        const text = formatPurgePlanText(await createPurgePlan(context))

        assert.match(text, /Shared Docker image retained: boxdown-plan:latest \(sha256:purge-plan-image\) \(used by: purge-plan-peer\)/)
        assert.doesNotMatch(text, /Docker image if still unused during removal/)
      })
    })
  })

  test('purge plan reports when image usage could not be checked', async () => {
    const workspace = tempDir('purge-plan-usage-failure-workspace')
    const env = {
      HOME: tempDir('purge-plan-usage-failure-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-plan-usage-failure-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-plan-usage-failure-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('purge-plan-usage-failure-runtime')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    await withFakeDocker([{
      workspace,
      id: 'purge-plan-usage-failure-container',
      imageId: 'sha256:purge-plan-usage-failure',
      imageName: 'boxdown-usage-failure:latest'
    }], async (_logPath, dockerEnv) => {
      await withProcessEnv({
        ...dockerEnv,
        ...env,
        BOXDOWN_FAKE_DOCKER_ANCESTOR_EXIT_CODE: '42'
      }, async () => {
        const text = formatPurgePlanText(await createPurgePlan(context))

        assert.match(text, /Docker image usage could not be checked; purge will verify before removal/)
      })
    })
  })

  test('purge plan marks absent resources without promising removal', async () => {
    const workspace = tempDir('purge-plan-absent-workspace')
    const env = {
      HOME: tempDir('purge-plan-absent-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-plan-absent-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-plan-absent-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('purge-plan-absent-runtime')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    await withFakeDocker([], async (_logPath, dockerEnv) => {
      await withProcessEnv({ ...dockerEnv, ...env }, async () => {
        const text = formatPurgePlanText(await createPurgePlan(context))

        assert.match(text, /No Boxdown Docker container currently exists/)
        assert.ok(text.includes(`Generated Boxdown configuration absent: ${context.workspaceCacheDir}`))
        assert.ok(text.includes(`Boxdown workspace data absent: ${context.workspaceDataDir}`))
        assert.ok(text.includes(`Temporary runtime state absent: ${context.workspaceRuntimeDir}`))
        assert.doesNotMatch(text, /Docker volumes attached only to that container/)
      })
    })
  })

  test('purge plan remains informative when workspace metadata cannot be read', async () => {
    const workspace = tempDir('purge-plan-invalid-metadata-workspace')
    const env = {
      HOME: tempDir('purge-plan-invalid-metadata-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-plan-invalid-metadata-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-plan-invalid-metadata-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('purge-plan-invalid-metadata-runtime')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))
    writeFileSync(workspaceMetadataPath(context), '{invalid json\n')

    await withFakeDocker([], async (_logPath, dockerEnv) => {
      await withProcessEnv({ ...dockerEnv, ...env }, async () => {
        const text = formatPurgePlanText(await createPurgePlan(context))

        assert.match(text, /Boxdown workspace metadata could not be read; purge will retry during removal/)
        assert.match(text, /No Boxdown Docker container currently exists/)
      })
    })
  })

  test('interactive purge shows its resource plan before confirmation', async () => {
    const workspace = tempDir('purge-preview-prompt-workspace')
    const env = {
      HOME: tempDir('purge-preview-prompt-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-preview-prompt-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-preview-prompt-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('purge-preview-prompt-runtime')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const { input, output, outputText } = fakePromptStreams()

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    mkdirSync(context.workspaceRuntimeDir, { recursive: true })
    writeFileSync(context.generatedConfigPath, '{}\n')
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      {
        workspace,
        id: 'purge-preview-prompt-container',
        containerState: 'running',
        imageId: 'sha256:purge-preview-prompt-image',
        imageName: 'boxdown-preview:latest'
      }
    ], async (logPath, dockerEnv) => {
      const codePromise = withProcessEnv({ ...dockerEnv, ...env }, async () => runCli(['purge', '--workspace', workspace], {
        promptInput: input,
        promptOutput: output,
        env: { ...process.env, CI: 'false' }
      }))

      await waitForPromptOutput(outputText, /Purge Boxdown workspace\?/)
      assert.match(outputText(), /This will remove:/)
      assert.match(outputText(), /Docker container: purge-preview-prompt-container \(running\)/)
      assert.match(outputText(), /Docker image if still unused during removal: boxdown-preview:latest \(sha256:purge-preview-prompt-image\)/)
      assert.ok(outputText().includes(context.workspaceCacheDir))
      assert.ok(outputText().includes(context.workspaceDataDir))
      assert.ok(outputText().includes(context.workspaceRuntimeDir))
      assert.match(outputText(), /This will keep:/)
      assert.ok(outputText().includes(`Your repository and files: ${context.workspaceFolder}`))

      input.write('\r')

      assert.strictEqual(await codePromise, 1)
      assert.ok(!fakeDockerCalls(logPath).some((line) => line.startsWith('rm -f') || line.startsWith('image rm ')))
      assert.strictEqual(existsSync(context.workspaceCacheDir), true)
      assert.strictEqual(existsSync(context.workspaceDataDir), true)
      assert.strictEqual(existsSync(context.workspaceRuntimeDir), true)
      assert.strictEqual(existsSync(context.workspaceLogPath), false)
    })
  })

  test('non-interactive targeted purge prints a plain resource plan before removal', async () => {
    const workspace = tempDir('purge-preview-ci-workspace')
    const env = {
      HOME: tempDir('purge-preview-ci-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-preview-ci-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-preview-ci-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('purge-preview-ci-runtime')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeFileSync(context.generatedConfigPath, '{}\n')
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      {
        workspace,
        id: 'purge-preview-ci-container',
        imageId: 'sha256:purge-preview-ci-image',
        imageName: 'boxdown-preview-ci:latest'
      }
    ], async (_logPath, dockerEnv) => {
      const result = runCliProcess(['purge', '--workspace', workspace], { ...dockerEnv, ...env, CI: 'true' })

      assert.strictEqual(result.code, 0)
      assert.ok(result.stdout.includes(`Purge plan: ${context.workspaceFolder}`))
      assert.match(result.stdout, /Docker container: purge-preview-ci-container \(running\)/)
      assert.match(result.stdout, /Docker image if still unused during removal: boxdown-preview-ci:latest \(sha256:purge-preview-ci-image\)/)
      assert.ok(result.stdout.includes(context.workspaceCacheDir))
      assert.doesNotMatch(result.stdout, /\u001B/)
      assert.doesNotMatch(result.stdout, /Purge Boxdown workspace\?/)
    })
  })

  test('purges workspace container image state and managed integrations', async () => {
    const workspace = tempDir('purge-workspace')
    const env = {
      HOME: tempDir('purge-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('purge-runtime'),
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
    mkdirSync(context.workspaceSecretEnvDir, { recursive: true })
    writeFileSync(join(context.workspaceSecretEnvDir, 'SNYK_TOKEN'), 'runtime-secret-sentinel')
    writeFileSync(context.generatedConfigPath, '{}\n')
    writeWorkspaceMetadata(context, recordedAlias)
    writeFileSync(env.BOXDOWN_SSH_CONFIG, 'Host github.com\n  User git\n')
    await installSshConfig(context, defaultAlias, { configPath: env.BOXDOWN_SSH_CONFIG })
    await installSshConfig(context, recordedAlias, { configPath: env.BOXDOWN_SSH_CONFIG })
    await installSshConfig(context, providedAlias, { configPath: env.BOXDOWN_SSH_CONFIG })
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
      assert.ok(calls.includes('inspect --format {{json .Image}}|{{json .Config.Image}} purge-container'))
      assert.ok(calls.includes('rm -f -v purge-container'))
      assert.ok(calls.includes('image rm sha256:purge-image'))
      assert.strictEqual(existsSync(context.workspaceFolder), true)
      assert.strictEqual(existsSync(context.workspaceCacheDir), false)
      assert.strictEqual(existsSync(context.workspaceDataDir), false)
      assert.strictEqual(existsSync(context.workspaceRuntimeDir), false)
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

  test('purge retains an image shared by another Boxdown workspace', async () => {
    const targetWorkspace = tempDir('purge-shared-target')
    const peerWorkspace = tempDir('purge-shared-peer')
    const env = {
      HOME: tempDir('purge-shared-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-shared-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-shared-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('purge-shared-runtime'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-shared-ssh'), 'config')
    }
    const context = createWorkspaceContext({
      workspace: targetWorkspace,
      env,
      assetsDevcontainerDir
    })
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([
      {
        workspace: targetWorkspace,
        id: 'target-container',
        imageId: 'sha256:shared',
        imageName: 'boxdown-shared:latest'
      },
      {
        workspace: peerWorkspace,
        id: 'peer-container',
        containerState: 'exited',
        imageId: 'sha256:shared',
        imageName: 'boxdown-shared:latest'
      }
    ], async (logPath, dockerEnv) => {
      const result = runCliProcess(['purge', '--workspace', targetWorkspace], {
        ...dockerEnv,
        ...env
      })
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(result.code, 0)
      assert.match(result.stdout, /Retained shared Docker image: .*sha256:shared.*used by: peer-container/)
      assert.ok(calls.includes('rm -f -v target-container'))
      assert.strictEqual(calls.some(call => call === 'image rm sha256:shared'), false)
    })
  })

  test('purge skips image removal when target container removal fails', async () => {
    const workspace = tempDir('purge-container-failure')
    const env = {
      HOME: tempDir('purge-container-failure-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-container-failure-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-container-failure-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-container-failure-ssh'), 'config')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

    await withFakeDocker([{
      workspace,
      id: 'failed-target-container',
      removeExitCode: 37,
      imageId: 'sha256:retained-after-container-failure'
    }], async (logPath, dockerEnv) => {
      const result = runCliProcess(['purge', '--workspace', workspace], {
        ...dockerEnv,
        ...env
      })
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(result.code, 1)
      assert.match(result.stdout, /Retained Docker image after failed container removal/)
      assert.strictEqual(calls.some(call => call.startsWith('image rm ')), false)
    })
  })

  test('retains Cursor ownership data when complete integration cleanup times out', async () => {
    const workspace = tempDir('purge-cursor-lock-workspace')
    const env = {
      HOME: tempDir('purge-cursor-lock-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-cursor-lock-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-cursor-lock-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('purge-cursor-lock-runtime'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-cursor-lock-ssh'), 'config'),
      BOXDOWN_CURSOR_SETTINGS: join(tempDir('purge-cursor-lock-settings'), 'settings.json')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const alias = defaultSshAlias(context.workspaceBasename)
    const lockPath = join(context.dataRoot, 'cursor-integration.lock')

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeFileSync(context.generatedConfigPath, '{}\n')
    mkdirSync(dirname(env.BOXDOWN_CURSOR_SETTINGS), { recursive: true })
    writeFileSync(env.BOXDOWN_CURSOR_SETTINGS, JSON.stringify({
      'remote.SSH.configFile': env.BOXDOWN_SSH_CONFIG
    }))
    await installCursorSshTarget(context, alias, { env })
    assert.strictEqual(existsSync(cursorIntegrationPath(context)), true)
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      timestamp: new Date().toISOString(),
      nonce: 'active-purge-owner'
    }))

    await withFakeDocker([
      {
        workspace,
        id: 'purge-cursor-lock-container',
        imageId: 'sha256:purge-cursor-lock-image',
        imageName: 'boxdown-purge-cursor-lock:latest'
      }
    ], async (logPath, dockerEnv) => {
      const result = runCliProcess(['purge', '--workspace', workspace], { ...dockerEnv, ...env })
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(result.code, 1)
      assert.match(result.stderr, /Failed Cursor workspace integration cleanup/)
      assert.ok(calls.includes('rm -f -v purge-cursor-lock-container'))
      assert.ok(calls.includes('image rm sha256:purge-cursor-lock-image'))
      assert.strictEqual(existsSync(context.workspaceCacheDir), false)
      assert.strictEqual(existsSync(context.workspaceDataDir), true)
      assert.strictEqual(existsSync(cursorIntegrationPath(context)), true)
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
      assert.ok(calls.includes('image rm sha256:recorded-image'))
      assert.strictEqual(existsSync(context.workspaceCacheDir), false)
      assert.strictEqual(existsSync(context.workspaceDataDir), false)
    })
  })

  test('purge retains a recorded image shared by an absent workspace container', async () => {
    const workspace = tempDir('purge-recorded-shared-image-workspace')
    const peerWorkspace = tempDir('purge-recorded-shared-image-peer')
    const env = {
      HOME: tempDir('purge-recorded-shared-image-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-recorded-shared-image-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-recorded-shared-image-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-recorded-shared-image-ssh'), 'config')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

    writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))
    recordWorkspaceDockerImage(context, {
      id: 'sha256:recorded-shared-image',
      name: 'recorded-shared:latest'
    })

    await withFakeDocker([{
      workspace: peerWorkspace,
      id: 'recorded-shared-peer',
      containerState: 'exited',
      imageId: 'sha256:recorded-shared-image',
      imageName: 'recorded-shared:latest'
    }], async (logPath, dockerEnv) => {
      const result = runCliProcess(['purge', '--workspace', workspace], {
        ...dockerEnv,
        ...env
      })
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(result.code, 0)
      assert.match(result.stdout, /Retained shared Docker image: .*sha256:recorded-shared-image.*used by: recorded-shared-peer/)
      assert.strictEqual(calls.some(call => call.startsWith('image rm ')), false)
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
        env: { ...process.env, CI: 'false', NO_COLOR: undefined }
      })))

      await waitForPromptOutput(outputText, /Purge Boxdown workspaces\?/)
      assert.match(outputText(), /alpha/)
      assert.match(outputText(), /beta/)
      assert.match(outputText(), /delta/)
      assert.match(outputText(), /missing/)
      assert.ok(compactPromptText(outputText()).includes(compactPromptText(`(absent) ${alphaContext.workspaceFolder}`)))
      assert.ok(compactPromptText(outputText()).includes(compactPromptText(`(running) ${betaContext.workspaceFolder}`)))
      assert.ok(compactPromptText(outputText()).includes(compactPromptText(`(exited) ${deltaContext.workspaceFolder}`)))
      assert.ok(compactPromptText(outputText()).includes(compactPromptText(`(missing) ${missingContext.workspaceFolder}`)))
      assert.doesNotMatch(outputText(), /alpha-devcontainer/)
      assert.doesNotMatch(outputText(), /beta-devcontainer/)
      assert.doesNotMatch(outputText(), /delta-devcontainer/)
      assert.doesNotMatch(outputText(), /missing-devcontainer/)

      input.write('\u001B[A')
      await waitForPromptOutput(outputText, /\u001B\[31m\(missing\)\u001B\[0m/)
      assert.ok(outputText().includes(color('(missing)', 'red')))
      assert.ok(compactPromptText(outputText()).includes(compactPromptText(`(missing) ${missingContext.workspaceFolder}`)))
      input.write(' ')
      input.write('\u001B[A')
      await waitForPromptOutput(outputText, /\u001B\[33m\(exited\)\u001B\[0m/)
      assert.ok(outputText().includes(color('(exited)', 'yellow')))
      assert.ok(compactPromptText(outputText()).includes(compactPromptText(`(exited) ${deltaContext.workspaceFolder}`)))
      input.write('\u001B[A')
      await waitForPromptOutput(outputText, /\u001B\[32m\(running\)\u001B\[0m/)
      assert.ok(outputText().includes(color('(running)', 'green')))
      assert.ok(compactPromptText(outputText()).includes(compactPromptText(`(running) ${betaContext.workspaceFolder}`)))
      input.write(' ')
      input.write('\u001B[A')
      await waitForPromptOutput(outputText, /\u001B\[31m\(absent\)\u001B\[0m/)
      assert.ok(outputText().includes(color('(absent)', 'red')))
      assert.ok(compactPromptText(outputText()).includes(compactPromptText(`(absent) ${alphaContext.workspaceFolder}`)))
      input.write('\r')
      await waitForPromptOutput(outputText, /Purge selected Boxdown workspaces\?/)
      assert.strictEqual((outputText().match(/This will remove:/g) ?? []).length, 2)
      assert.ok(outputText().includes(`Workspace: ${missingContext.workspaceFolder}`))
      assert.ok(outputText().includes(`Workspace: ${betaContext.workspaceFolder}`))
      assert.match(outputText(), /No Boxdown Docker container currently exists/)
      assert.match(outputText(), /Docker container: purge-batch-beta-container \(running\)/)
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
      env: { ...process.env, CI: 'false', NO_COLOR: undefined }
    })))

    await waitForPromptOutput(outputText, /Purge Boxdown workspaces\?/)
    assert.ok(compactPromptText(outputText()).includes(compactPromptText(`(unknown) ${context.workspaceFolder}`)))
    input.write('\u001B[A')
    await waitForPromptOutput(outputText, /\u001B\[31m\(unknown\)\u001B\[0m/)
    assert.ok(outputText().includes(color('(unknown)', 'red')))
    assert.ok(compactPromptText(outputText()).includes(compactPromptText(`(unknown) ${context.workspaceFolder}`)))
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
      assert.strictEqual((outputText().match(/This will remove:/g) ?? []).length, 2)
      assert.ok(outputText().includes(`Workspace: ${alphaContext.workspaceFolder}`))
      assert.ok(outputText().includes(`Workspace: ${betaContext.workspaceFolder}`))
      assert.match(outputText(), /Docker container: purge-batch-alpha-container \(running\)/)
      assert.match(outputText(), /Docker container: purge-batch-beta-container \(running\)/)
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
      assert.ok(calls.includes('image rm sha256:failing-image'))
      assert.match(result.stderr, /Failed Docker image sha256:failing-image/)
      assert.strictEqual(existsSync(context.workspaceCacheDir), false)
      assert.strictEqual(existsSync(context.workspaceDataDir), false)
    })
  })

  test('purge removes every recorded Cursor alias before deleting workspace data', async () => {
    const workspace = tempDir('purge-cursor-alias-history-workspace')
    const cursorSettingsPath = join(tempDir('purge-cursor-alias-history-settings'), 'settings.json')
    const cursor = fakeCursorCli()
    const env = {
      ...process.env,
      ...cursor.env,
      HOME: tempDir('purge-cursor-alias-history-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-cursor-alias-history-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-cursor-alias-history-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-cursor-alias-history-ssh'), 'config'),
      BOXDOWN_CURSOR_SETTINGS: cursorSettingsPath
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    mkdirSync(dirname(cursorSettingsPath), { recursive: true })
    writeFileSync(cursorSettingsPath, JSON.stringify({ 'remote.SSH.configFile': env.BOXDOWN_SSH_CONFIG }))

    assert.strictEqual(runCliProcess(['ssh', 'install', '--workspace', workspace, '--alias', 'purge-cursor-a', '--target', 'cursor'], env).code, 0)
    assert.strictEqual(runCliProcess(['ssh', 'install', '--workspace', workspace, '--alias', 'purge-cursor-b', '--target', 'cursor'], env).code, 0)
    assert.deepStrictEqual(cursorRemotePlatforms(cursorSettingsPath), {
      'purge-cursor-a': 'linux',
      'purge-cursor-b': 'linux'
    })
    assert.strictEqual(existsSync(cursorIntegrationPath(context)), true)

    await withFakeDocker([], async (_logPath, dockerEnv) => {
      const result = runCliProcess(['purge', '--workspace', workspace], { ...env, ...dockerEnv })

      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(cursorRemotePlatforms(cursorSettingsPath), {})
      assert.strictEqual(existsSync(cursorIntegrationPath(context)), false)
      assert.strictEqual(existsSync(context.workspaceDataDir), false)
    })
  })

  test('purge retains a shared Cursor alias until the last workspace owner is cleaned', async () => {
    const firstWorkspace = tempDir('purge-cursor-shared-first-workspace')
    const secondWorkspace = tempDir('purge-cursor-shared-second-workspace')
    const cursorSettingsPath = join(tempDir('purge-cursor-shared-settings'), 'settings.json')
    const cursor = fakeCursorCli()
    const env = {
      ...process.env,
      ...cursor.env,
      HOME: tempDir('purge-cursor-shared-home'),
      BOXDOWN_CACHE_HOME: tempDir('purge-cursor-shared-cache'),
      BOXDOWN_DATA_HOME: tempDir('purge-cursor-shared-data'),
      BOXDOWN_SSH_CONFIG: join(tempDir('purge-cursor-shared-ssh'), 'config'),
      BOXDOWN_CURSOR_SETTINGS: cursorSettingsPath
    }
    const firstContext = createWorkspaceContext({ workspace: firstWorkspace, env, assetsDevcontainerDir })
    const secondContext = createWorkspaceContext({ workspace: secondWorkspace, env, assetsDevcontainerDir })
    const alias = 'purge-cursor-shared'
    mkdirSync(dirname(cursorSettingsPath), { recursive: true })
    writeFileSync(cursorSettingsPath, JSON.stringify({ 'remote.SSH.configFile': env.BOXDOWN_SSH_CONFIG }))

    assert.strictEqual(runCliProcess(['ssh', 'install', '--workspace', firstWorkspace, '--alias', alias, '--target', 'cursor'], env).code, 0)
    assert.strictEqual(runCliProcess(['ssh', 'install', '--workspace', secondWorkspace, '--alias', alias, '--target', 'cursor'], env).code, 0)

    await withFakeDocker([], async (_logPath, dockerEnv) => {
      const firstResult = runCliProcess(['purge', '--workspace', firstWorkspace], { ...env, ...dockerEnv })

      assert.strictEqual(firstResult.code, 0, firstResult.stderr)
      assert.deepStrictEqual(cursorRemotePlatforms(cursorSettingsPath), { [alias]: 'linux' })
      assert.strictEqual(existsSync(firstContext.workspaceDataDir), false)
      assert.strictEqual(existsSync(cursorIntegrationPath(secondContext)), true)

      const secondResult = runCliProcess(['purge', '--workspace', secondWorkspace], { ...env, ...dockerEnv })

      assert.strictEqual(secondResult.code, 0, secondResult.stderr)
      assert.deepStrictEqual(cursorRemotePlatforms(cursorSettingsPath), {})
      assert.strictEqual(existsSync(secondContext.workspaceDataDir), false)
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
      assert.ok(calls.some((line) => line.startsWith('ps -a --filter label=devcontainer.local_folder=')))
      assert.ok(calls.some((line) => line.startsWith('inspect --format {{json .Image}}|{{json .Config.Image}}')))
      assert.ok(!calls.some((line) => line.startsWith('rm -f') || line.startsWith('image rm ')))
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
      assert.ok(calls.includes('image rm sha256:purge-prompt-confirm-image'))
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

  test('disables TTY normalization by default for direct Claude launches only', () => {
    const workspace = tempDir('claude-tty-normalization-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('claude-tty-normalization-cache'),
        BOXDOWN_DATA_HOME: tempDir('claude-tty-normalization-data')
      },
      assetsDevcontainerDir
    })
    const previous = process.env.BOXDOWN_TTY_NORMALIZE

    try {
      delete process.env.BOXDOWN_TTY_NORMALIZE

      assert.ok(codingAgentDevcontainerExecArgs(context, 'claude').includes('BOXDOWN_TTY_NORMALIZE=0'))
      assert.ok(codingAgentDevcontainerExecArgs(context, 'codex').includes('BOXDOWN_TTY_NORMALIZE=1'))

      process.env.BOXDOWN_TTY_NORMALIZE = '1'
      assert.ok(codingAgentDevcontainerExecArgs(context, 'claude').includes('BOXDOWN_TTY_NORMALIZE=1'))
    } finally {
      if (previous === undefined) {
        delete process.env.BOXDOWN_TTY_NORMALIZE
      } else {
        process.env.BOXDOWN_TTY_NORMALIZE = previous
      }
    }
  })
})

describe('SSH proxy container execution', () => {
  test('starts inetd-mode sshd explicitly as root in the non-root image', () => {
    assert.deepStrictEqual(sshdProxyDockerArgs('container-123').slice(0, 5), [
      'exec',
      '--user',
      'root',
      '-i',
      'container-123'
    ])
    assert.equal(sshdProxyDockerArgs('container-123').includes('/usr/sbin/sshd'), true)
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
  test('refreshes toolchain plan provenance from the persisted plan timestamp', () => {
    const workspace = tempDir('metadata-toolchain-plan-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('metadata-toolchain-plan-cache'),
        BOXDOWN_DATA_HOME: tempDir('metadata-toolchain-plan-data')
      },
      assetsDevcontainerDir
    })
    writeWorkspaceMetadata(context, 'toolchain-plan-devcontainer')
    const plan = resolveToolchainPlan({
      workspaceId: context.workspaceId,
      detections: [],
      selectors: [parseToolchainSelector('none')],
      selectionSource: 'cli',
      now: new Date('2026-08-02T12:34:56.000Z')
    })

    writeToolchainPlan(context, plan)

    assert.strictEqual(readWorkspaceMetadata(context)?.toolchainPlanUpdatedAt, plan.updatedAt)
  })

  test('migrates legacy agent profile metadata and preserves a selected profile', () => {
    const workspace = tempDir('metadata-profile-workspace')
    const data = tempDir('metadata-profile-data')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('metadata-profile-cache'),
        BOXDOWN_DATA_HOME: data
      },
      assetsDevcontainerDir
    })

    assert.deepStrictEqual(resolveAgentProfile(undefined, readWorkspaceMetadata(context)?.agentProfile), {
      value: 'auth',
      source: 'default'
    })

    mkdirSync(context.workspaceDataDir, { recursive: true })
    writeFileSync(workspaceMetadataPath(context), `${JSON.stringify({
      version: 1,
      workspaceId: context.workspaceId,
      workspaceFolder: context.workspaceFolder,
      workspaceBasename: context.workspaceBasename,
      sshAlias: 'legacy-devcontainer',
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
      dockerImageId: 'sha256:legacy-image',
      dockerImageName: 'boxdown-legacy:latest',
      dockerImageLastSeenAt: '2026-01-01T00:00:00.000Z'
    }, null, 2)}\n`)

    assert.deepStrictEqual(resolveAgentProfile(undefined, readWorkspaceMetadata(context)?.agentProfile), {
      value: 'auth',
      source: 'default'
    })

    writeWorkspaceMetadata(context, 'profile-devcontainer', new Date('2026-01-02T00:00:00.000Z'), 'full')
    const preserved = writeWorkspaceMetadata(context, 'profile-devcontainer', new Date('2026-01-03T00:00:00.000Z'))

    assert.strictEqual(preserved.agentProfile, 'full')
    assert.strictEqual(preserved.firstSeenAt, '2026-01-01T00:00:00.000Z')
    assert.strictEqual(preserved.dockerImageId, 'sha256:legacy-image')
    assert.strictEqual(preserved.dockerImageName, 'boxdown-legacy:latest')
    assert.strictEqual(preserved.dockerImageLastSeenAt, '2026-01-01T00:00:00.000Z')
  })

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

  test('warns once for a legacy locally-built devcontainer image without removing it', async () => {
    const workspace = tempDir('legacy-image-migration-workspace')
    const migrationWorkspace = tempDir('legacy-image-migration-metadata-workspace')
    const env = {
      BOXDOWN_CACHE_HOME: tempDir('legacy-image-migration-cache'),
      BOXDOWN_DATA_HOME: tempDir('legacy-image-migration-data')
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const migrationContext = createWorkspaceContext({ workspace: migrationWorkspace, env, assetsDevcontainerDir })
    const image = { id: 'sha256:legacy', name: 'vsc-example-legacy-uid' }
    const stderr: string[] = []
    const originalStderrWrite = process.stderr.write

    writeWorkspaceMetadata(context, 'legacy-devcontainer')
    writeWorkspaceMetadata(migrationContext, 'legacy-metadata-devcontainer')
    assert.equal(isPublishedBoxdownImage(image), false)
    assert.equal(isPublishedBoxdownImage({ id: 'sha256:published', name: 'ghcr.io/lirantal/boxdown:latest' }), true)
    assert.equal(isPublishedBoxdownImage({ id: 'sha256:untagged', name: 'ghcr.io/lirantal/boxdown' }), false)
    assert.equal(recordLegacyImageMigrationNotice(migrationContext), true)
    assert.equal(recordLegacyImageMigrationNotice(migrationContext), false)
    assert.match(readWorkspaceMetadata(migrationContext)?.legacyImageMigrationNotifiedAt ?? '', /^\d{4}-\d{2}-\d{2}T/)

    await withFakeDocker([
      { workspace, id: 'legacy-container', imageId: image.id, imageName: image.name, agentProfileMarker: 'auth' }
    ], async (logPath, dockerEnv) => {
      process.stderr.write = function capturedStderrWrite (this: typeof process.stderr, chunk: string | Uint8Array): boolean {
        stderr.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
        return true
      } as typeof process.stderr.write

      try {
        await withProcessEnv({ ...dockerEnv, ...env }, async () => {
          await startDevcontainer(context, { reuseRunning: true })
          await startDevcontainer(context, { reuseRunning: true })
        })
      } finally {
        process.stderr.write = originalStderrWrite
      }

      const calls = fakeDockerCalls(logPath)
      assert.match(stderr.join(''), /Run `boxdown start --recreate` to switch to the published Boxdown image\./)
      assert.strictEqual(stderr.join('').match(/This workspace uses Boxdown's legacy locally-built devcontainer image\./g)?.length, 1)
      assert.ok(!calls.some(call => call.startsWith('docker rm') || call.startsWith('docker image rm') || call.startsWith('rm ') || call.startsWith('image rm ')))
    })
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
    assert.strictEqual(commandWritesWorkspaceMetadata('coding-agent'), true)
  })

  test('container runtime readiness scope is explicit for every command', () => {
    const expected = new Map<BoxdownCommand, boolean>([
      ['help', false],
      ['version', false],
      ['setup', true],
      ['start', true],
      ['list', false],
      ['status', false],
      ['stop', false],
      ['down', false],
      ['purge', false],
      ['doctor', false],
      ['ssh-install', false],
      ['ssh-uninstall', false],
      ['ssh-proxy', true],
      ['tunnel', true],
      ['refresh-gh-token', true],
      ['coding-agent', true]
    ])

    for (const [command, waits] of expected) {
      assert.strictEqual(commandRequiresContainerRuntime(command), waits, command)
    }
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
  test('reports selected toolchains, a CLI override note, and the last sync result', () => {
    const workspace = tempDir('status-toolchain-override-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('status-toolchain-override-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-toolchain-override-data')
      },
      assetsDevcontainerDir
    })
    const goOverridePlan = resolveToolchainPlan({
      workspaceId: context.workspaceId,
      detections: [{
        id: 'go',
        exactVersion: '1.26.5',
        evidence: [{path: 'go.mod', source: 'toolchain', value: '1.26.5', exact: true}]
      }],
      selectors: [parseToolchainSelector('go@1.27.0')],
      selectionSource: 'cli'
    })

    writeToolchainPlan(context, goOverridePlan)
    writeFileSync(context.toolchainResultPath, JSON.stringify({
      version: 1,
      fingerprint: goOverridePlan.fingerprint,
      state: 'succeeded',
      updatedAt: '2026-08-02T00:00:00.000Z',
      runtimes: [{id: 'go', state: 'succeeded'}]
    }))

    const status = createStatusInfo(context, 'demo-devcontainer', undefined, existsSync)
    const text = formatStatusText(status)

    assert.match(text, /Toolchains: Go 1\.27\.0 \(CLI override\)/)
    assert.match(text, /Explicit Go 1\.27\.0 override differs from go\.mod toolchain 1\.26\.5\./)
    assert.match(text, /Last sync: succeeded/)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(status.toolchains)), {
      plan: goOverridePlan,
      result: {
        version: 1,
        fingerprint: goOverridePlan.fingerprint,
        state: 'succeeded',
        updatedAt: '2026-08-02T00:00:00.000Z',
        runtimes: [{id: 'go', state: 'succeeded'}]
      },
      containerState: 'active'
    })
  })

  test('reports an explicit override note when Python project evidence is unsupported', () => {
    const workspace = tempDir('status-toolchain-unchecked-override-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('status-toolchain-unchecked-override-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-toolchain-unchecked-override-data')
      },
      assetsDevcontainerDir
    })
    writeFileSync(join(workspace, 'pyproject.toml'), '[project]\nrequires-python = ">=3.11 || <3.9"\n')
    const detection = detectToolchains(workspace).find(item => item.id === 'python')
    const plan = resolveToolchainPlan({
      workspaceId: context.workspaceId,
      detections: detection === undefined ? [] : [detection],
      selectors: [parseToolchainSelector('python@3.14.6')],
      selectionSource: 'cli'
    })

    writeToolchainPlan(context, plan)
    const text = formatStatusText(createStatusInfo(context, 'demo-devcontainer', undefined, existsSync))

    assert.match(text, /Explicit Python 3\.14\.6 override compatibility could not be verified against pyproject\.toml requires-python >=3\.11 \|\| <3\.9: Unsupported python version constraint\./u)
  })

  test('distinguishes unselected, disabled, stale, failed, and unreadable toolchain state', () => {
    const workspace = tempDir('status-toolchain-states-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('status-toolchain-states-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-toolchain-states-data')
      },
      assetsDevcontainerDir
    })
    const container = {id: 'toolchain-container', state: 'running'}

    assert.deepStrictEqual(createStatusInfo(context, 'demo-devcontainer', undefined, existsSync).toolchains, {
      containerState: 'not-selected'
    })

    const disabledPlan = toolchainPlanFor(context, 'none')
    writeToolchainPlan(context, disabledPlan)
    const disabled = createStatusInfo(context, 'demo-devcontainer', undefined, existsSync)
    assert.strictEqual(disabled.toolchains.containerState, 'disabled')
    assert.match(formatStatusText(disabled), /Toolchains: disabled/)
    assert.strictEqual(
      createStatusInfo(context, 'demo-devcontainer', container, existsSync).toolchains.containerState,
      'recreate-required'
    )
    writeGeneratedDevcontainerConfig(context, undefined, undefined, disabledPlan)
    assert.strictEqual(
      createStatusInfo(context, 'demo-devcontainer', container, existsSync).toolchains.containerState,
      'disabled'
    )

    const selectedPlan = toolchainPlanFor(context, 'go@1.27.0')
    writeToolchainPlan(context, selectedPlan)
    writeGeneratedDevcontainerConfig(context, undefined, undefined, selectedPlan)
    writeFileSync(context.toolchainResultPath, JSON.stringify({
      version: 1,
      fingerprint: 'stale-fingerprint',
      state: 'failed',
      updatedAt: '2026-08-02T00:00:00.000Z',
      runtimes: [{id: 'go', state: 'failed', message: 'install failed'}]
    }))
    const stale = createStatusInfo(context, 'demo-devcontainer', container, existsSync)
    assert.strictEqual(stale.toolchains.containerState, 'recreate-required')
    assert.match(formatStatusText(stale), /Last sync: failed/)
    assert.match(formatStatusText(stale), /Run `boxdown start --recreate`\./)
    assert.strictEqual(statusIsHealthy({
      ...stale,
      paths: {...stale.paths, generatedConfigExists: true, assetsDevcontainerExists: true},
      ssh: {...stale.ssh, keyExists: true, publicKeyExists: true, publicKeyRuntimeExists: true},
      agentProfile: {...stale.agentProfile, containerState: 'active'}
    }), false)

    writeFileSync(context.toolchainResultPath, JSON.stringify({
      version: 1,
      fingerprint: selectedPlan.fingerprint,
      state: 'failed',
      updatedAt: '2026-08-02T00:00:00.000Z',
      runtimes: [{id: 'go', state: 'failed', message: 'install failed'}]
    }))
    const failed = createStatusInfo(context, 'demo-devcontainer', container, existsSync)
    assert.strictEqual(failed.toolchains.containerState, 'active')
    assert.match(formatStatusText(failed), /Last sync: failed/)
    assert.doesNotMatch(formatStatusText(failed), /Run `boxdown start --recreate`\./)

    const planMount = `type=bind,source=${context.toolchainsDir},target=${BOXDOWN_CONTAINER_TOOLCHAINS_DIR}/plan,readonly`
    for (const resultMount of [
      undefined,
      `type=bind,source=/tmp/not-boxdown,target=${BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR}`,
      `type=bind,source=${context.toolchainResultDir},target=${BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR},readonly`
    ]) {
      writeFileSync(context.generatedConfigPath, JSON.stringify({
        mounts: [planMount, ...(resultMount === undefined ? [] : [resultMount])]
      }))
      assert.strictEqual(
        createStatusInfo(context, 'demo-devcontainer', container, existsSync).toolchains.containerState,
        'recreate-required'
      )
    }

    writeGeneratedDevcontainerConfig(context, undefined, undefined, null)
    const missingMount = createStatusInfo(context, 'demo-devcontainer', container, existsSync)
    assert.strictEqual(missingMount.toolchains.containerState, 'recreate-required')

    writeGeneratedDevcontainerConfig(context, undefined, undefined, selectedPlan)

    writeFileSync(context.toolchainResultPath, '{ malformed')
    const unreadable = createStatusInfo(context, 'demo-devcontainer', container, existsSync)
    assert.strictEqual(unreadable.toolchains.result, undefined)
    assert.strictEqual(unreadable.toolchains.containerState, 'recreate-required')
  })

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

  test('formats status infrastructure with an active default auth agent profile', () => {
    const workspace = tempDir('status-workspace')
    const home = tempDir('status-home')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: home,
        BOXDOWN_CACHE_HOME: tempDir('status-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-data')
      },
      platform: 'linux',
      assetsDevcontainerDir
    })
    const sshConfigPath = join(tempDir('status-config'), 'config')
    mkdirSync(context.hostAgentsDir)
    mkdirSync(context.hostCodexDir)
    mkdirSync(context.hostClaudeDir)
    writeFileSync(context.hostCodexAuthPath, '{}\n')
    assert.notStrictEqual(context.hostClaudeCredentialsPath, undefined)
    writeFileSync(context.hostClaudeCredentialsPath as string, '{}\n')
    writeGeneratedDevcontainerConfig(context, undefined, 'auth')
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
    }, exists, {
      aliasSource: 'default',
      sshConfigPath,
      agentProfileSelection: resolveAgentProfile(undefined, undefined),
      containerAgentProfile: copiedAuthContainerProfile
    })
    const stopped = createStatusInfo(context, 'demo-devcontainer', {
      id: 'def456',
      name: 'demo',
      state: 'exited',
      status: 'Exited (0) 1 minute ago'
    }, exists, {
      aliasSource: 'provided',
      sshConfigPath,
      agentProfileSelection: resolveAgentProfile(undefined, undefined)
    })
    const absent = createStatusInfo(context, 'demo-devcontainer', undefined, () => false, {
      aliasSource: 'default',
      sshConfigPath,
      agentProfileSelection: resolveAgentProfile(undefined, undefined)
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
    assert.deepStrictEqual(JSON.parse(JSON.stringify(running.agentProfile)), {
      selected: 'auth',
      selectionSource: 'default',
      access: 'container-local copy',
      generated: 'auth',
      container: 'auth',
      containerState: 'active',
      sources: {
        codexAuthentication: 'available',
        claudeAuthentication: 'available',
        agents: 'available',
        codexHome: 'not-selected',
        claudeHome: 'not-selected',
        claudeConfig: 'not-selected'
      },
      customDestinations: []
    })
    assert.strictEqual('claude' in running, false)
    assert.strictEqual(stopped.agentProfile.containerState, 'unknown')
    assert.strictEqual(absent.agentProfile.containerState, 'not-created')
    assert.strictEqual(absent.ssh.managedBlockState, 'missing')
    assert.strictEqual(absent.paths.logExists, false)
    assert.match(formatStatusText(running), /SSH alias: demo-devcontainer \(computed default; installed\)/)
    assert.match(formatStatusText(stopped), /SSH alias: demo-devcontainer \(provided; installed\)/)
    assert.match(formatStatusText(running), /State: running/)
    assert.match(formatStatusText(stopped), /State: exited/)
    assert.match(formatStatusText(running), /Generated config: .* \(exists\)/)
    assert.match(formatStatusText(running), /Command log: .*boxdown\.log \(exists\)/)
    assert.match(formatStatusText(running), /Agent profile: auth \(default\)/)
    assert.match(formatStatusText(running), / {2}Codex authentication: available/)
    assert.match(formatStatusText(running), / {2}Claude authentication: available/)
    assert.match(formatStatusText(running), / {2}~\/\.agents: available/)
    assert.match(formatStatusText(running), / {2}Profile access: container-local copy\n {2}Container profile: active/)
    assert.doesNotMatch(formatStatusText(running), /start --recreate/)
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

  test('reports status agent profile none without probing host profile paths', () => {
    const workspace = tempDir('status-none-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: tempDir('status-none-home'),
        BOXDOWN_CACHE_HOME: tempDir('status-none-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-none-data')
      },
      assetsDevcontainerDir
    })
    const probed: string[] = []
    const status = createStatusInfo(context, 'demo-devcontainer', undefined, () => false, {
      sshConfigPath: join(tempDir('status-none-config'), 'config'),
      agentProfileSelection: resolveAgentProfile(undefined, 'none'),
      isFile: (path) => {
        probed.push(path)
        return true
      },
      isDirectory: (path) => {
        probed.push(path)
        return true
      }
    })

    assert.deepStrictEqual(JSON.parse(JSON.stringify(status.agentProfile)), {
      selected: 'none',
      selectionSource: 'metadata',
      access: 'container-local copy',
      containerState: 'not-created',
      sources: {
        codexAuthentication: 'not-selected',
        claudeAuthentication: 'not-selected',
        agents: 'not-selected',
        codexHome: 'not-selected',
        claudeHome: 'not-selected',
        claudeConfig: 'not-selected'
      },
      customDestinations: []
    })
    assert.deepStrictEqual(probed, [])
    assert.match(formatStatusText(status), /Agent profile: none \(workspace metadata\)/)
    assert.match(formatStatusText(status), / {2}Container profile: not created/)
  })

  test('status agent profile probes only six known top-level full-profile paths', () => {
    const workspace = tempDir('status-full-probes-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: tempDir('status-full-probes-home'),
        BOXDOWN_CACHE_HOME: tempDir('status-full-probes-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-full-probes-data')
      },
      platform: 'linux',
      assetsDevcontainerDir
    })
    const fileProbes: string[] = []
    const directoryProbes: string[] = []
    const status = createStatusInfo(context, 'demo-devcontainer', {
      id: 'stopped-full',
      state: 'exited'
    }, () => false, {
      sshConfigPath: join(tempDir('status-full-probes-config'), 'config'),
      agentProfileSelection: resolveAgentProfile(undefined, 'full'),
      isFile: (path) => {
        fileProbes.push(path)
        return path === context.hostCodexAuthPath
      },
      isDirectory: (path) => {
        directoryProbes.push(path)
        return path !== context.hostClaudeDir
      }
    })

    assert.deepStrictEqual(fileProbes, [
      context.hostCodexAuthPath,
      context.hostClaudeCredentialsPath,
      context.hostClaudeConfigPath
    ])
    assert.deepStrictEqual(directoryProbes, [
      context.hostAgentsDir,
      context.hostCodexDir,
      context.hostClaudeDir
    ])
    assert.deepStrictEqual(status.agentProfile.sources, {
      codexAuthentication: 'available',
      claudeAuthentication: 'missing',
      agents: 'available',
      codexHome: 'available',
      claudeHome: 'missing',
      claudeConfig: 'missing'
    })
    assert.strictEqual(status.agentProfile.containerState, 'unknown')
  })

  test('formats status agent profile macOS Keychain and recreate guidance', () => {
    const workspace = tempDir('status-macos-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: tempDir('status-macos-home'),
        BOXDOWN_CACHE_HOME: tempDir('status-macos-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-macos-data')
      },
      platform: 'darwin',
      assetsDevcontainerDir
    })
    mkdirSync(context.hostAgentsDir)
    mkdirSync(context.hostCodexDir)
    writeFileSync(context.hostCodexAuthPath, '{}\n')
    writeGeneratedDevcontainerConfig(context, undefined, 'auth')
    const status = createStatusInfo(context, 'demo-devcontainer', {
      id: 'mismatched-profile',
      state: 'running'
    }, existsSync, {
      sshConfigPath: join(tempDir('status-macos-config'), 'config'),
      agentProfileSelection: resolveAgentProfile(undefined, undefined),
      containerAgentProfile: liveFullContainerProfile
    })

    assert.strictEqual(status.agentProfile.sources.claudeAuthentication, 'unsupported')
    assert.strictEqual(status.agentProfile.containerState, 'recreate-required')
    assert.strictEqual(statusIsHealthy({
      ...status,
      paths: { ...status.paths, generatedConfigExists: true, assetsDevcontainerExists: true },
      ssh: {
        ...status.ssh,
        keyExists: true,
        publicKeyExists: true,
        publicKeyRuntimeExists: true
      }
    }), false)
    assert.match(formatStatusText(status), /Agent profile: auth \(default\)[\s\S]* {2}Codex authentication: available[\s\S]* {2}Claude authentication: unavailable \(macOS Keychain is not copied\)[\s\S]* {2}~\/\.agents: available[\s\S]* {2}Container profile: recreate required/)
    assert.match(formatStatusText(status), /Run `boxdown start --recreate --agent-profile auth`\./)
  })

  test('formats status agent profile unsupported platforms without a macOS explanation or JSON changes', () => {
    const createUnsupportedStatus = (platform: NodeJS.Platform): ReturnType<typeof createStatusInfo> => {
      const workspace = tempDir(`status-${platform}-workspace`)
      const context = createWorkspaceContext({
        workspace,
        env: {
          HOME: tempDir(`status-${platform}-home`),
          BOXDOWN_CACHE_HOME: tempDir(`status-${platform}-cache`),
          BOXDOWN_DATA_HOME: tempDir(`status-${platform}-data`)
        },
        platform,
        assetsDevcontainerDir
      })

      return createStatusInfo(context, 'demo-devcontainer', undefined, () => false, {
        sshConfigPath: join(tempDir(`status-${platform}-config`), 'config'),
        agentProfileSelection: resolveAgentProfile(undefined, undefined)
      })
    }
    const macStatus = createUnsupportedStatus('darwin')
    const freeBsdStatus = createUnsupportedStatus('freebsd')
    const exactAgentProfile = {
      selected: 'auth',
      selectionSource: 'default',
      access: 'container-local copy',
      containerState: 'not-created',
      sources: {
        codexAuthentication: 'missing',
        claudeAuthentication: 'unsupported',
        agents: 'missing',
        codexHome: 'not-selected',
        claudeHome: 'not-selected',
        claudeConfig: 'not-selected'
      },
      customDestinations: []
    }

    assert.deepStrictEqual(JSON.parse(JSON.stringify(macStatus.agentProfile)), exactAgentProfile)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(freeBsdStatus.agentProfile)), exactAgentProfile)
    assert.match(formatStatusText(macStatus), /Claude authentication: unavailable \(macOS Keychain is not copied\)/)
    assert.match(formatStatusText(freeBsdStatus), /Claude authentication: unavailable \(this host platform does not have a supported file-backed credential path\)/)
    assert.doesNotMatch(formatStatusText(freeBsdStatus), /macOS|Keychain/)
    const clonedMacStatus = { ...macStatus }
    assert.match(formatStatusText(clonedMacStatus), /Claude authentication: unavailable \(this host platform does not have a supported file-backed credential path\)/)
    assert.doesNotMatch(formatStatusText(clonedMacStatus), /macOS|Keychain/)
  })

  test('status agent profile uses matching generated truth after host sources change', () => {
    const presentWorkspace = tempDir('status-generated-present-workspace')
    const presentContext = createWorkspaceContext({
      workspace: presentWorkspace,
      env: {
        HOME: tempDir('status-generated-present-home'),
        BOXDOWN_CACHE_HOME: tempDir('status-generated-present-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-generated-present-data')
      },
      assetsDevcontainerDir
    })
    mkdirSync(presentContext.hostAgentsDir)
    writeFileSync(join(presentContext.hostAgentsDir, 'private-plugin-name.json'), '{}\n')
    writeGeneratedDevcontainerConfig(presentContext, undefined, 'auth')
    rmSync(presentContext.hostAgentsDir, { recursive: true })

    const presentStatus = createStatusInfo(presentContext, 'demo-devcontainer', {
      id: 'present-container',
      state: 'running'
    }, existsSync, {
      sshConfigPath: join(tempDir('status-generated-present-config'), 'config'),
      agentProfileSelection: resolveAgentProfile(undefined, undefined),
      containerAgentProfile: copiedAuthContainerProfile,
      isDirectory: () => false
    })

    const absentWorkspace = tempDir('status-generated-absent-workspace')
    const absentContext = createWorkspaceContext({
      workspace: absentWorkspace,
      env: {
        HOME: tempDir('status-generated-absent-home'),
        BOXDOWN_CACHE_HOME: tempDir('status-generated-absent-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-generated-absent-data')
      },
      assetsDevcontainerDir
    })
    writeGeneratedDevcontainerConfig(absentContext, undefined, 'auth')
    mkdirSync(absentContext.hostAgentsDir)
    writeFileSync(join(absentContext.hostAgentsDir, 'new-hook-name.json'), '{}\n')

    const absentStatus = createStatusInfo(absentContext, 'demo-devcontainer', {
      id: 'absent-container',
      state: 'running'
    }, existsSync, {
      sshConfigPath: join(tempDir('status-generated-absent-config'), 'config'),
      agentProfileSelection: resolveAgentProfile(undefined, undefined),
      containerAgentProfile: copiedAuthContainerProfile,
      isDirectory: () => true
    })

    assert.strictEqual(presentStatus.agentProfile.sources.agents, 'available')
    assert.strictEqual(absentStatus.agentProfile.sources.agents, 'missing')
    assert.strictEqual(presentStatus.agentProfile.containerState, 'active')
    assert.strictEqual(absentStatus.agentProfile.containerState, 'active')
    assert.doesNotMatch(JSON.stringify(presentStatus), /private-plugin-name/)
    assert.doesNotMatch(JSON.stringify(absentStatus), /new-hook-name/)
  })

  test('status agent profile reports canonical custom destinations without nested filename leakage', () => {
    const workspace = tempDir('status-custom-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: tempDir('status-custom-home'),
        BOXDOWN_CACHE_HOME: tempDir('status-custom-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-custom-data')
      },
      assetsDevcontainerDir
    })
    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeFileSync(context.generatedConfigPath, `${JSON.stringify({
      containerEnv: {
        BOXDOWN_AGENT_PROFILE: 'full',
        BOXDOWN_AGENT_PROFILE_SOURCES: 'agents,claude-config,claude-home,codex-home'
      },
      mounts: [
        'type=bind,source=/tmp/agents,target=/home/node/.agents',
        'type=bind,source=/tmp/codex,target=/home/node/.codex/private-plugin-name',
        'type=bind,source=/tmp/claude,target=/home/node/.claude',
        'type=bind,source=/tmp/config,target=/home/node/.claude.json',
        'type=bind,source=/tmp/duplicate,target=/home/node/.agents',
        'type=bind,source=/tmp/private-parent-name,target=/home/node'
      ]
    }, null, 2)}\n`)

    const status = createStatusInfo(context, 'demo-devcontainer', {
      id: 'custom-container',
      state: 'running'
    }, existsSync, {
      sshConfigPath: join(tempDir('status-custom-config'), 'config'),
      agentProfileSelection: resolveAgentProfile(undefined, 'full'),
      containerAgentProfile: liveFullContainerProfile
    })

    assert.deepStrictEqual(status.agentProfile.customDestinations, [
      '/home/node/.agents',
      '/home/node/.claude',
      '/home/node/.claude.json',
      '/home/node/.codex'
    ])
    assert.deepStrictEqual(status.agentProfile.sources, {
      codexAuthentication: 'custom',
      claudeAuthentication: 'custom',
      agents: 'custom',
      codexHome: 'custom',
      claudeHome: 'custom',
      claudeConfig: 'custom'
    })
    assert.doesNotMatch(JSON.stringify(status), /private-plugin-name|private-parent-name/)
    assert.match(formatStatusText(status), /Custom destinations: \/home\/node\/\.agents, \/home\/node\/\.claude, \/home\/node\/\.claude\.json, \/home\/node\/\.codex/)
  })

  test('status agent profile keeps sibling custom mounts from owning authentication', () => {
    const workspace = tempDir('status-custom-auth-siblings-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: tempDir('status-custom-auth-siblings-home'),
        BOXDOWN_CACHE_HOME: tempDir('status-custom-auth-siblings-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-custom-auth-siblings-data')
      },
      platform: 'linux',
      assetsDevcontainerDir
    })
    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeFileSync(context.generatedConfigPath, `${JSON.stringify({
      containerEnv: {
        BOXDOWN_AGENT_PROFILE: 'auth',
        BOXDOWN_AGENT_PROFILE_SOURCES: 'agents,claude-auth,codex-auth'
      },
      mounts: [
        `type=bind,source=/tmp/agents,target=${BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_AGENTS_DIR},readonly`,
        `type=bind,source=/tmp/codex-auth,target=${BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CODEX_AUTH_PATH},readonly`,
        `type=bind,source=/tmp/claude-auth,target=${BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CLAUDE_CREDENTIALS_PATH},readonly`,
        'type=bind,source=/tmp/codex-config,target=/home/node/.codex/config.toml',
        'type=bind,source=/tmp/claude-settings,target=/home/node/.claude/settings.json'
      ]
    }, null, 2)}\n`)

    const status = createStatusInfo(context, 'demo-devcontainer', {
      id: 'custom-auth-siblings-container',
      state: 'running'
    }, existsSync, {
      sshConfigPath: join(tempDir('status-custom-auth-siblings-config'), 'config'),
      agentProfileSelection: resolveAgentProfile(undefined, undefined),
      containerAgentProfile: copiedAuthContainerProfile
    })

    assert.deepStrictEqual(status.agentProfile.sources, {
      codexAuthentication: 'available',
      claudeAuthentication: 'available',
      agents: 'available',
      codexHome: 'not-selected',
      claudeHome: 'not-selected',
      claudeConfig: 'not-selected'
    })
    assert.deepStrictEqual(status.agentProfile.customDestinations, [
      '/home/node/.claude',
      '/home/node/.codex'
    ])
  })

  test('status agent profile makes nested Claude config inherit generated Claude-home state', () => {
    const workspace = tempDir('status-generated-nested-claude-config-workspace')
    const claudeDir = tempDir('status-generated-nested-claude-config-home')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: tempDir('status-generated-nested-claude-config-user-home'),
        CLAUDE_CONFIG_DIR: claudeDir,
        BOXDOWN_CACHE_HOME: tempDir('status-generated-nested-claude-config-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-generated-nested-claude-config-data')
      },
      platform: 'linux',
      assetsDevcontainerDir
    })
    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeFileSync(context.generatedConfigPath, `${JSON.stringify({
      containerEnv: {
        BOXDOWN_AGENT_PROFILE: 'full',
        BOXDOWN_AGENT_PROFILE_SOURCES: 'claude-home',
        BOXDOWN_AGENT_PROFILE_MANAGED_SOURCES: 'claude-home'
      },
      mounts: [
        `type=bind,source=${claudeDir},target=${BOXDOWN_CONTAINER_CLAUDE_DIR}`,
        'type=bind,source=/tmp/unrelated-config,target=/home/node/.claude.json'
      ]
    }, null, 2)}\n`)

    const status = createStatusInfo(context, 'demo-devcontainer', {
      id: 'generated-nested-claude-config-container',
      state: 'running'
    }, existsSync, {
      sshConfigPath: join(tempDir('status-generated-nested-claude-config-ssh'), 'config'),
      agentProfileSelection: resolveAgentProfile(undefined, 'full'),
      containerAgentProfile: liveFullContainerProfile
    })

    assert.strictEqual(status.agentProfile.sources.claudeHome, 'available')
    assert.strictEqual(status.agentProfile.sources.claudeConfig, 'available')
    assert.deepStrictEqual(status.agentProfile.customDestinations, ['/home/node/.claude.json'])
  })

  test('status agent profile makes nested Claude config inherit live Claude-home state', () => {
    const workspace = tempDir('status-live-nested-claude-config-workspace')
    const claudeDir = tempDir('status-live-nested-claude-config-home')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: tempDir('status-live-nested-claude-config-user-home'),
        CLAUDE_CONFIG_DIR: claudeDir,
        BOXDOWN_CACHE_HOME: tempDir('status-live-nested-claude-config-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-live-nested-claude-config-data')
      },
      platform: 'linux',
      assetsDevcontainerDir
    })
    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeFileSync(context.generatedConfigPath, JSON.stringify({
      containerEnv: { BOXDOWN_AGENT_PROFILE: 'auth' },
      mounts: ['type=bind,source=/tmp/unrelated-config,target=/home/node/.claude.json']
    }))
    const fileProbes: string[] = []
    const status = createStatusInfo(context, 'demo-devcontainer', undefined, existsSync, {
      sshConfigPath: join(tempDir('status-live-nested-claude-config-ssh'), 'config'),
      agentProfileSelection: resolveAgentProfile(undefined, 'full'),
      isFile: (path) => {
        fileProbes.push(path)
        return false
      },
      isDirectory: (path) => path === context.hostClaudeDir
    })

    assert.strictEqual(status.agentProfile.sources.claudeHome, 'available')
    assert.strictEqual(status.agentProfile.sources.claudeConfig, 'available')
    assert.ok(!fileProbes.includes(context.hostClaudeConfigPath))
    assert.deepStrictEqual(status.agentProfile.customDestinations, ['/home/node/.claude.json'])
  })

  test('status agent profile ignores empty and non-absolute mount targets', () => {
    const workspace = tempDir('status-invalid-custom-target-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: tempDir('status-invalid-custom-target-home'),
        BOXDOWN_CACHE_HOME: tempDir('status-invalid-custom-target-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-invalid-custom-target-data')
      },
      platform: 'linux',
      assetsDevcontainerDir
    })
    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeFileSync(context.generatedConfigPath, `${JSON.stringify({
      containerEnv: {
        BOXDOWN_AGENT_PROFILE: 'auth',
        BOXDOWN_AGENT_PROFILE_SOURCES: 'agents,claude-auth,codex-auth'
      },
      mounts: [
        `type=bind,source=/tmp/agents,target=${BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_AGENTS_DIR},readonly`,
        `type=bind,source=/tmp/codex-auth,target=${BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CODEX_AUTH_PATH},readonly`,
        `type=bind,source=/tmp/claude-auth,target=${BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CLAUDE_CREDENTIALS_PATH},readonly`,
        'type=bind,source=/tmp/empty,target=',
        'type=bind,source=/tmp/relative,target=home/node/.codex'
      ]
    }, null, 2)}\n`)

    const status = createStatusInfo(context, 'demo-devcontainer', {
      id: 'invalid-custom-target-container',
      state: 'running'
    }, existsSync, {
      sshConfigPath: join(tempDir('status-invalid-custom-target-ssh'), 'config'),
      agentProfileSelection: resolveAgentProfile(undefined, undefined),
      containerAgentProfile: copiedAuthContainerProfile
    })

    assert.deepStrictEqual(status.agentProfile.sources, {
      codexAuthentication: 'available',
      claudeAuthentication: 'available',
      agents: 'available',
      codexHome: 'not-selected',
      claudeHome: 'not-selected',
      claudeConfig: 'not-selected'
    })
    assert.deepStrictEqual(status.agentProfile.customDestinations, [])
  })

  test('status agent profile applies exact containerState rules and defensive generated parsing', () => {
    const workspace = tempDir('status-state-rules-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: tempDir('status-state-rules-home'),
        BOXDOWN_CACHE_HOME: tempDir('status-state-rules-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-state-rules-data')
      },
      assetsDevcontainerDir
    })
    const options = {
      sshConfigPath: join(tempDir('status-state-rules-config'), 'config'),
      agentProfileSelection: resolveAgentProfile(undefined, 'full')
    }
    const running = { id: 'state-rules-running', state: 'running' }
    const stopped = { id: 'state-rules-stopped', state: 'exited' }

    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeFileSync(context.generatedConfigPath, '{ malformed')
    assert.strictEqual(createStatusInfo(context, 'demo-devcontainer', running, existsSync, {
      ...options,
      containerAgentProfile: liveFullContainerProfile
    }).agentProfile.containerState, 'unknown')
    assert.strictEqual(createStatusInfo(context, 'demo-devcontainer', running, existsSync, {
      ...options,
      readFile: () => {
        throw new Error('unreadable')
      }
    }).agentProfile.generated, undefined)

    writeFileSync(context.generatedConfigPath, JSON.stringify({
      containerEnv: { BOXDOWN_AGENT_PROFILE: 'invalid', BOXDOWN_AGENT_PROFILE_SOURCES: 7 },
      mounts: [null, 42, { target: '/home/node/.codex' }]
    }))
    const invalid = createStatusInfo(context, 'demo-devcontainer', stopped, existsSync, options)
    assert.strictEqual(invalid.agentProfile.generated, undefined)
    assert.strictEqual(invalid.agentProfile.containerState, 'unknown')

    writeFileSync(context.generatedConfigPath, JSON.stringify({
      containerEnv: { BOXDOWN_AGENT_PROFILE: 'auth', BOXDOWN_AGENT_PROFILE_SOURCES: '' },
      mounts: []
    }))
    assert.strictEqual(createStatusInfo(context, 'demo-devcontainer', stopped, existsSync, options).agentProfile.containerState, 'recreate-required')
    assert.strictEqual(createStatusInfo(context, 'demo-devcontainer', running, existsSync, {
      ...options,
      containerAgentProfile: copiedAuthContainerProfile
    }).agentProfile.containerState, 'recreate-required')
    assert.strictEqual(createStatusInfo(context, 'demo-devcontainer', undefined, existsSync, options).agentProfile.containerState, 'not-created')

    writeFileSync(context.generatedConfigPath, JSON.stringify({
      containerEnv: { BOXDOWN_AGENT_PROFILE: 'full', BOXDOWN_AGENT_PROFILE_SOURCES: '' },
      mounts: []
    }))
    const stoppedUnknown = createStatusInfo(context, 'demo-devcontainer', stopped, existsSync, options)
    const runningUnknown = createStatusInfo(context, 'demo-devcontainer', running, existsSync, options)
    assert.strictEqual(stoppedUnknown.agentProfile.containerState, 'unknown')
    assert.strictEqual(runningUnknown.agentProfile.containerState, 'unknown')
    assert.strictEqual(statusIsHealthy({
      ...runningUnknown,
      paths: { ...runningUnknown.paths, generatedConfigExists: true, assetsDevcontainerExists: true },
      ssh: {
        ...runningUnknown.ssh,
        keyExists: true,
        publicKeyExists: true,
        publicKeyRuntimeExists: true
      }
    }), true)
    assert.strictEqual(createStatusInfo(context, 'demo-devcontainer', running, existsSync, {
      ...options,
      containerAgentProfile: liveFullContainerProfile
    }).agentProfile.containerState, 'active')
    assert.strictEqual(createStatusInfo(context, 'demo-devcontainer', running, existsSync, {
      ...options,
      containerAgentProfile: legacyFullContainerProfile
    }).agentProfile.containerState, 'recreate-required')
  })

  test('status agent profile JSON never enumerates full profile contents', () => {
    const workspace = tempDir('status-private-profile-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        HOME: tempDir('status-private-profile-home'),
        BOXDOWN_CACHE_HOME: tempDir('status-private-profile-cache'),
        BOXDOWN_DATA_HOME: tempDir('status-private-profile-data')
      },
      platform: 'linux',
      assetsDevcontainerDir
    })
    mkdirSync(join(context.hostAgentsDir, 'skills'), { recursive: true })
    mkdirSync(join(context.hostCodexDir, 'plugins'), { recursive: true })
    mkdirSync(join(context.hostClaudeDir, 'hooks'), { recursive: true })
    writeFileSync(join(context.hostAgentsDir, 'skills', 'private-mcp-name.json'), '{}\n')
    writeFileSync(join(context.hostCodexDir, 'plugins', 'private-plugin-name.json'), '{}\n')
    writeFileSync(join(context.hostClaudeDir, 'hooks', 'private-history-name.json'), '{}\n')
    writeFileSync(context.hostClaudeConfigPath, '{}\n')
    writeGeneratedDevcontainerConfig(context, undefined, 'full')

    const status = createStatusInfo(context, 'demo-devcontainer', {
      id: 'private-profile-container',
      state: 'running'
    }, existsSync, {
      sshConfigPath: join(tempDir('status-private-profile-config'), 'config'),
      agentProfileSelection: resolveAgentProfile(undefined, 'full'),
      containerAgentProfile: liveFullContainerProfile
    })
    const json = JSON.stringify(status)

    assert.deepStrictEqual(JSON.parse(JSON.stringify(status.agentProfile)), {
      selected: 'full',
      selectionSource: 'metadata',
      access: 'live, read-write host mounts',
      generated: 'full',
      container: 'full',
      containerState: 'active',
      sources: {
        codexAuthentication: 'available',
        claudeAuthentication: 'available',
        agents: 'available',
        codexHome: 'available',
        claudeHome: 'available',
        claudeConfig: 'available'
      },
      customDestinations: []
    })
    assert.doesNotMatch(json, /private-mcp-name|private-plugin-name|private-history-name/)
  })

  test('status does not record agent profile metadata or generated config while inspecting a running marker', async () => {
    const workspace = tempDir('status-read-only-workspace')
    const env = {
      HOME: tempDir('status-read-only-home'),
      BOXDOWN_CACHE_HOME: tempDir('status-read-only-cache'),
      BOXDOWN_DATA_HOME: tempDir('status-read-only-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('status-read-only-runtime'),
      BOXDOWN_SSH_CONFIG: join(tempDir('status-read-only-ssh'), 'config'),
      BOXDOWN_DEVCONTAINER_ASSETS_DIR: assetsDevcontainerDir
    }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    writeWorkspaceMetadata(context, 'status-read-only-devcontainer', undefined, 'full')
    writeGeneratedDevcontainerConfig(context, undefined, 'full')
    const metadataPath = workspaceMetadataPath(context)
    const metadataBefore = readFileSync(metadataPath, 'utf8')
    const generatedBefore = readFileSync(context.generatedConfigPath, 'utf8')

    await withFakeDocker([
      {
        workspace,
        id: 'status-read-only-container',
        containerState: 'running',
        agentProfileMarker: 'full:live'
      }
    ], async (logPath, dockerEnv) => {
      const result = runCliProcess(['status', '--workspace', workspace, '--json'], {
        ...dockerEnv,
        ...env
      })
      const status = JSON.parse(result.stdout) as ReturnType<typeof createStatusInfo>
      const calls = fakeDockerCalls(logPath)

      assert.strictEqual(result.code, 1)
      assert.strictEqual(status.agentProfile.selected, 'full')
      assert.strictEqual(status.agentProfile.selectionSource, 'metadata')
      assert.strictEqual(status.agentProfile.generated, 'full')
      assert.strictEqual(status.agentProfile.container, 'full')
      assert.strictEqual(status.agentProfile.containerState, 'active')
      assert.ok(calls.includes('exec status-read-only-container cat /opt/boxdown/state/agent-profile'))
      assert.ok(!calls.some((call) => call.includes('devcontainer up')))
    })

    assert.strictEqual(readFileSync(metadataPath, 'utf8'), metadataBefore)
    assert.strictEqual(readFileSync(context.generatedConfigPath, 'utf8'), generatedBefore)

    await withFakeDocker([
      {
        workspace,
        id: 'status-legacy-full-container',
        containerState: 'running',
        agentProfileMarker: 'full'
      }
    ], async (_logPath, dockerEnv) => {
      const result = runCliProcess(['status', '--workspace', workspace, '--json'], {
        ...dockerEnv,
        ...env
      })
      const status = JSON.parse(result.stdout) as ReturnType<typeof createStatusInfo>

      assert.strictEqual(status.agentProfile.container, 'full')
      assert.strictEqual(status.agentProfile.containerState, 'recreate-required')
    })

    await withFakeDocker([
      {
        workspace,
        id: 'status-stopped-container',
        containerState: 'exited',
        agentProfileMarker: 'auth'
      }
    ], async (logPath, dockerEnv) => {
      runCliProcess(['status', '--workspace', workspace, '--json'], {
        ...dockerEnv,
        ...env
      })
      assert.ok(!fakeDockerCalls(logPath).some((call) => call.startsWith('exec ')))
    })

    assert.strictEqual(readFileSync(metadataPath, 'utf8'), metadataBefore)
    assert.strictEqual(readFileSync(context.generatedConfigPath, 'utf8'), generatedBefore)
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
  test('warns for the default GPG signing preference without probing SSH or GitHub', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('doctor-gpg-signing-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('doctor-gpg-signing-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-gpg-signing-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []

    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      includeDockerMountProbe: false,
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'git' && args.includes('gpg.format')) return { code: 1, stdout: '', stderr: '' }
        if (command === 'git' && args.includes('gpg.program')) return { code: 1, stdout: '', stderr: '' }
        if (command === 'git' && args.includes('user.signingkey')) return { code: 0, stdout: '0123456789ABCDEF\n', stderr: '' }
        if (command === 'git' && args.includes('commit.gpgsign')) return { code: 0, stdout: 'true\n', stderr: '' }
        if (command === 'ssh-add') return { code: 1, stdout: '', stderr: 'agent unavailable\n' }
        return { code: 0, stdout: '', stderr: '' }
      }
    })

    assert.deepStrictEqual(checks.find((check) => check.name === 'git-signing-agent'), {
      name: 'git-signing-agent',
      level: 'warn',
      message: 'GPG commit signing is configured, but the default Boxdown image does not provide GnuPG or GPG-agent forwarding; commits in this container may fail to sign'
    })
    assert.ok(!calls.some((call) => call.startsWith('ssh-add ')))
    assert.ok(!calls.some((call) => call.startsWith('gh ')))
  })

  test('warns for a repository-local GPG signing preference without probing SSH or GitHub', async () => {
    const workspace = tempDir('doctor-local-gpg-signing-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('doctor-local-gpg-signing-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-local-gpg-signing-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []

    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      includeDockerMountProbe: false,
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'git' && args.includes('--local') && args.includes('gpg.format')) return { code: 0, stdout: 'openpgp\n', stderr: '' }
        if (command === 'ssh-add') return { code: 1, stdout: '', stderr: 'agent unavailable\n' }
        return { code: 1, stdout: '', stderr: '' }
      }
    })

    assert.deepStrictEqual(checks.find((check) => check.name === 'git-signing-agent'), {
      name: 'git-signing-agent',
      level: 'warn',
      message: 'GPG commit signing is configured, but the default Boxdown image does not provide GnuPG or GPG-agent forwarding; commits in this container may fail to sign'
    })
    assert.ok(!calls.some((call) => call.startsWith('ssh-add ')))
    assert.ok(!calls.some((call) => call.startsWith('gh ')))
  })

  test('warns for a Git boolean alias that enables default GPG signing without probing SSH or GitHub', async () => {
    const workspace = tempDir('doctor-gpg-signing-boolean-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('doctor-gpg-signing-boolean-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-gpg-signing-boolean-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []

    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      includeDockerMountProbe: false,
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'git' && args.includes('commit.gpgsign')) return { code: 0, stdout: 'yes\n', stderr: '' }
        if (command === 'ssh-add') return { code: 1, stdout: '', stderr: 'agent unavailable\n' }
        return { code: 1, stdout: '', stderr: '' }
      }
    })

    assert.deepStrictEqual(checks.find((check) => check.name === 'git-signing-agent'), {
      name: 'git-signing-agent',
      level: 'warn',
      message: 'GPG commit signing is configured, but the default Boxdown image does not provide GnuPG or GPG-agent forwarding; commits in this container may fail to sign'
    })
    assert.ok(!calls.some((call) => call.startsWith('ssh-add ')))
    assert.ok(!calls.some((call) => call.startsWith('gh ')))
  })

  test('warns for an explicit GPG program without probing SSH or GitHub', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('doctor-gpg-program-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('doctor-gpg-program-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-gpg-program-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []

    const checks = await runDoctorChecks(context, {
      includeDockerMountProbe: false,
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'git' && args.includes('gpg.program')) return { code: 0, stdout: 'gpg2\n', stderr: '' }
        if (command === 'ssh-add') throw new Error('SSH agent must not be queried')
        if (command === 'gh') throw new Error('GitHub must not be queried')
        return { code: 1, stdout: '', stderr: '' }
      }
    })

    assert.deepStrictEqual(checks.find((check) => check.name === 'git-signing-agent'), {
      name: 'git-signing-agent',
      level: 'warn',
      message: 'GPG commit signing is configured, but the default Boxdown image does not provide GnuPG or GPG-agent forwarding; commits in this container may fail to sign'
    })
    assert.ok(!calls.some((call) => call.startsWith('ssh-add ')))
    assert.ok(!calls.some((call) => call.startsWith('gh ')))
  })

  test('continues SSH diagnostics when SSH format has a legacy GPG program', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('doctor-ssh-format-legacy-gpg-program-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('doctor-ssh-format-legacy-gpg-program-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-ssh-format-legacy-gpg-program-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []

    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      includeDockerMountProbe: false,
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'git' && args.includes('gpg.format')) return { code: 0, stdout: 'ssh\n', stderr: '' }
        if (command === 'git' && args.includes('gpg.program')) return { code: 0, stdout: 'gpg2\n', stderr: '' }
        if (command === 'ssh-add') return { code: 1, stdout: '', stderr: 'agent unavailable\n' }
        return { code: 1, stdout: '', stderr: '' }
      }
    })

    assert.deepStrictEqual(checks.find((check) => check.name === 'git-signing-agent'), {
      name: 'git-signing-agent',
      level: 'warn',
      message: 'SSH agent is unavailable; Boxdown commits will remain unsigned'
    })
    assert.ok(calls.some((call) => call.startsWith('ssh-add ')))
  })

  test('keeps an X.509 preference generic', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('doctor-x509-preference-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('doctor-x509-preference-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-x509-preference-data')
      },
      assetsDevcontainerDir
    })

    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      includeDockerMountProbe: false,
      runCommand: async (command, args) => ({
        code: command === 'git' && args.includes('gpg.format') ? 0 : 1,
        stdout: command === 'git' && args.includes('gpg.format') ? 'x509\n' : '',
        stderr: ''
      })
    })

    assert.deepStrictEqual(checks.find((check) => check.name === 'git-signing-agent'), {
      name: 'git-signing-agent',
      level: 'ok',
      message: 'Existing non-SSH Git signing configuration detected; Boxdown SSH signing is skipped'
    })
  })

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

  test('doctor reports Buildx readiness from the shared runtime probe', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('doctor-buildx-ready-workspace'),
      env: { BOXDOWN_CACHE_HOME: tempDir('doctor-buildx-ready-cache'), BOXDOWN_DATA_HOME: tempDir('doctor-buildx-ready-data') },
      assetsDevcontainerDir
    })
    const calls: string[] = []
    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      includeDockerMountProbe: false,
      runCommand: async (command, args) => {
        calls.push([command, ...args].join(' '))
        return { code: 0, stdout: '', stderr: '' }
      }
    })

    assert.ok(calls.includes('docker buildx inspect --bootstrap'))
    assert.deepStrictEqual(checks.find((check) => check.name === 'docker-buildx'), {
      name: 'docker-buildx',
      level: 'ok',
      message: 'Docker Buildx builder is operational'
    })
  })

  test('doctor warns when the Dev Containers fallback will be used', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('doctor-buildx-fallback-workspace'),
      env: { BOXDOWN_CACHE_HOME: tempDir('doctor-buildx-fallback-cache'), BOXDOWN_DATA_HOME: tempDir('doctor-buildx-fallback-data') },
      assetsDevcontainerDir
    })
    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      includeDockerMountProbe: false,
      runCommand: async (command, args) => ({
        code: command === 'docker' && args.join(' ') === 'buildx version' ? 1 : 0,
        stdout: '',
        stderr: command === 'docker' && args.join(' ') === 'buildx version' ? 'unknown command: buildx' : ''
      })
    })

    const buildx = checks.find((check) => check.name === 'docker-buildx')
    assert.strictEqual(buildx?.level, 'warn')
    assert.match(buildx?.message ?? '', /classic-build fallback/)
  })

  test('doctor fails a discoverable but unusable Buildx builder', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('doctor-buildx-failed-workspace'),
      env: { BOXDOWN_CACHE_HOME: tempDir('doctor-buildx-failed-cache'), BOXDOWN_DATA_HOME: tempDir('doctor-buildx-failed-data') },
      assetsDevcontainerDir
    })
    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      includeDockerMountProbe: false,
      runCommand: async (command, args) => ({
        code: command === 'docker' && args.join(' ') === 'buildx inspect --bootstrap' ? 1 : 0,
        stdout: '',
        stderr: command === 'docker' && args.join(' ') === 'buildx inspect --bootstrap' ? 'builder is starting' : ''
      })
    })

    assert.deepStrictEqual(checks.find((check) => check.name === 'docker-buildx'), {
      name: 'docker-buildx',
      level: 'fail',
      message: 'Docker Buildx builder was not operational: builder is starting'
    })
  })

  test('doctor accepts prevalidated runtime status and retains the bind-mount probe', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('doctor-prevalidated-runtime-workspace'),
      env: { BOXDOWN_CACHE_HOME: tempDir('doctor-prevalidated-runtime-cache'), BOXDOWN_DATA_HOME: tempDir('doctor-prevalidated-runtime-data') },
      assetsDevcontainerDir
    })
    const calls: string[] = []
    let container = 0
    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      containerRuntimeReady: true,
      runCommand: async (command, args) => {
        calls.push([command, ...args].join(' '))
        if (command === 'docker' && args[0] === 'image') return { code: 0, stdout: 'node:24\n', stderr: '' }
        if (command === 'docker' && args[0] === 'create') {
          container += 1
          return { code: 0, stdout: `probe-${container}\n`, stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      }
    })

    assert.ok(!calls.includes('docker --version'))
    assert.ok(!calls.includes('docker info'))
    assert.ok(!calls.includes('docker buildx version'))
    assert.ok(calls.includes('docker image ls --format {{.Repository}}:{{.Tag}}'))
    assert.strictEqual(checks.find((check) => check.name === 'docker-bind-mounts')?.level, 'ok')
  })

  test('warns when generated config still injects secrets through Docker environment settings', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('doctor-secret-config-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('doctor-secret-config-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-secret-config-data'),
        BOXDOWN_RUNTIME_HOME: tempDir('doctor-secret-config-runtime')
      },
      assetsDevcontainerDir
    })
    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeFileSync(context.generatedConfigPath, JSON.stringify({
      runArgs: ['--env-file', `${context.workspaceFolder}/.env.development`],
      containerEnv: { SNYK_TOKEN: 'unsafe-placeholder' }
    }))

    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      includeDockerMountProbe: false,
      runCommand: async (command) => command === 'ssh-add'
        ? { code: 0, stdout: 'ssh-ed25519 AAAAC3NzaDoctorSecretConfig test\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' }
    })

    assert.deepStrictEqual(checks.find((item) => item.name === 'secret-environment-config'), {
      name: 'secret-environment-config',
      level: 'warn',
      message: 'Generated config still exposes Boxdown secrets through Docker environment settings; recreate after upgrading Boxdown'
    })
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
      'docker rm -f probe-3',
      'docker rm -f probe-4'
    ])
    const runtimeProbeSource = probeSources[2]?.match(/source=([^,]+)/)?.[1]
    assert.ok(runtimeProbeSource !== undefined)
    assert.strictEqual(existsSync(runtimeProbeSource ?? ''), false)
    assert.ok(probeSources.some((source) => source.includes(`source=${context.workspaceSecretEnvDir},`)))
  })

  test('refreshes a stable parent and retries a stale managed Docker mount once', async () => {
    const workspace = tempDir('doctor-stale-mount-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('doctor-stale-mount-cache'),
        BOXDOWN_DATA_HOME: tempDir('doctor-stale-mount-data'),
        BOXDOWN_RUNTIME_HOME: tempDir('doctor-stale-mount-runtime')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []
    const createSources: string[] = []
    const createdProbeIds: string[] = []
    let managedChildAttempts = 0

    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      containerRuntimeReady: true,
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'docker' && args[0] === 'image') {
          return { code: 0, stdout: 'example:latest\n', stderr: '' }
        }
        if (command === 'docker' && args[0] === 'create') {
          const mount = args.find(arg => arg.startsWith('type=bind,')) ?? ''
          const source = mount.match(/source=([^,]+)/)?.[1] ?? ''
          createSources.push(source)
          if (source.startsWith(`${context.workspaceDataDir}/doctor-mount-probe-`)) {
            managedChildAttempts += 1
            if (managedChildAttempts === 1) {
              return { code: 1, stdout: '', stderr: 'invalid mount config for type "bind": bind source path does not exist' }
            }
          }
          const containerId = `probe-${createSources.length}`
          createdProbeIds.push(containerId)
          return { code: 0, stdout: `${containerId}\n`, stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      }
    })

    assert.strictEqual(checks.find(check => check.name === 'docker-bind-mounts')?.level, 'ok')
    assert.strictEqual(managedChildAttempts, 2)
    assert.ok(createSources.includes(dirname(context.workspaceDataDir)))
    assert.ok(createdProbeIds.every(containerId => calls.includes(`docker rm -f ${containerId}`)))
  })

  function mountRefreshTestContext (name: string): ReturnType<typeof createWorkspaceContext> {
    return createWorkspaceContext({
      workspace: tempDir(`${name}-workspace`),
      env: {
        BOXDOWN_CACHE_HOME: tempDir(`${name}-cache`),
        BOXDOWN_DATA_HOME: tempDir(`${name}-data`),
        BOXDOWN_RUNTIME_HOME: tempDir(`${name}-runtime`)
      },
      assetsDevcontainerDir
    })
  }

  function doctorMountTestRunner (
    onCreate: (
      source: string,
      attempt: number
    ) => DoctorCommandResult | undefined
  ): { createSources: string[], runCommand: DoctorCommandRunner } {
    const createSources: string[] = []
    const attempts = new Map<string, number>()

    return {
      createSources,
      runCommand: async (command, args) => {
        if (command === 'docker' && args[0] === 'image') {
          return { code: 0, stdout: 'example:latest\n', stderr: '' }
        }
        if (command === 'docker' && args[0] === 'create') {
          const mount = args.find(arg => arg.startsWith('type=bind,')) ?? ''
          const source = mount.match(/source=([^,]+)/)?.[1] ?? ''
          const attempt = (attempts.get(source) ?? 0) + 1
          attempts.set(source, attempt)
          createSources.push(source)
          return onCreate(source, attempt) ?? {
            code: 0,
            stdout: `probe-${createSources.length}\n`,
            stderr: ''
          }
        }
        return { code: 0, stdout: '', stderr: '' }
      }
    }
  }

  test('does not refresh a stable parent for permission or file-sharing failures', async () => {
    for (const [name, error] of [
      ['permission', 'permission denied'],
      ['file-sharing', 'mounts denied: file sharing is disabled']
    ] as const) {
      const context = mountRefreshTestContext(`doctor-${name}-mount`)
      const fake = doctorMountTestRunner(source =>
        source.startsWith(`${context.workspaceDataDir}/doctor-mount-probe-`)
          ? { code: 1, stdout: '', stderr: error }
          : undefined
      )
      const checks = await runDoctorChecks(context, {
        includeOptional: false,
        containerRuntimeReady: true,
        runCommand: fake.runCommand
      })

      assert.strictEqual(checks.find(check => check.name === 'docker-bind-mounts')?.level, 'fail')
      assert.strictEqual(fake.createSources.includes(dirname(context.workspaceDataDir)), false)
    }
  })

  test('refreshes the runtime parent before retrying stale secret state', async () => {
    const context = mountRefreshTestContext('doctor-runtime-secret-refresh')
    let secretAttempts = 0
    const fake = doctorMountTestRunner((source) => {
      if (source === context.workspaceSecretEnvDir) {
        secretAttempts += 1
        if (secretAttempts === 1) {
          return { code: 1, stdout: '', stderr: 'bind source path does not exist' }
        }
      }
      return undefined
    })
    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      containerRuntimeReady: true,
      runCommand: fake.runCommand
    })

    assert.strictEqual(checks.find(check => check.name === 'docker-bind-mounts')?.level, 'ok')
    assert.strictEqual(secretAttempts, 2)
    assert.strictEqual(fake.createSources.includes(dirname(context.workspaceRuntimeDir)), true)
  })

  test('reports a blocking failure when stable-parent refresh fails', async () => {
    const context = mountRefreshTestContext('doctor-parent-refresh-failure')
    let exactChild = ''
    const fake = doctorMountTestRunner(source => {
      if (source.startsWith(`${context.workspaceDataDir}/doctor-mount-probe-`)) {
        exactChild = source
        return { code: 1, stdout: '', stderr: 'bind source path does not exist' }
      }
      if (source === dirname(context.workspaceDataDir)) {
        return { code: 1, stdout: '', stderr: 'mount denied' }
      }
      return undefined
    })
    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      containerRuntimeReady: true,
      runCommand: fake.runCommand
    })
    const mountCheck = checks.find(check => check.name === 'docker-bind-mounts')

    assert.strictEqual(mountCheck?.level, 'fail')
    assert.ok(mountCheck?.message.includes(exactChild))
    assert.ok(mountCheck?.message.includes(dirname(context.workspaceDataDir)))
    assert.strictEqual(fake.createSources.filter(source => source === exactChild).length, 1)
  })

  test('reports the exact child when its post-refresh retry still fails', async () => {
    const context = mountRefreshTestContext('doctor-child-retry-failure')
    let exactChild = ''
    let exactChildAttempts = 0
    const fake = doctorMountTestRunner(source => {
      if (source.startsWith(`${context.workspaceDataDir}/doctor-mount-probe-`)) {
        exactChild = source
        exactChildAttempts += 1
        return exactChildAttempts === 1
          ? { code: 1, stdout: '', stderr: 'bind source path does not exist' }
          : { code: 1, stdout: '', stderr: 'daemon unavailable' }
      }
      return undefined
    })
    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      containerRuntimeReady: true,
      runCommand: fake.runCommand
    })
    const mountCheck = checks.find(check => check.name === 'docker-bind-mounts')

    assert.strictEqual(mountCheck?.level, 'fail')
    assert.ok(mountCheck?.message.includes(exactChild))
    assert.ok(mountCheck?.message.includes('daemon unavailable'))
    assert.strictEqual(fake.createSources.filter(source => source === exactChild).length, 2)
    assert.strictEqual(fake.createSources.includes(dirname(context.workspaceDataDir)), true)
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
  test('redacts known Boxdown secret environment assignments structurally', () => {
    const output = redactKnownSecretEnvironmentAssignments('ANTHROPIC_API_KEY=alpha SNYK_TOKEN=beta "OP_SERVICE_ACCOUNT_TOKEN=gamma"')

    assert.strictEqual(output, 'ANTHROPIC_API_KEY=[redacted] SNYK_TOKEN=[redacted] "OP_SERVICE_ACCOUNT_TOKEN=[redacted]"')
  })

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

  test('buffered commands deterministically time out once and settle their command log once', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('buffered-command-timeout-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('buffered-command-timeout-cache'),
        BOXDOWN_DATA_HOME: tempDir('buffered-command-timeout-data')
      },
      assetsDevcontainerDir
    })
    const logger = createWorkspaceCommandLogger(context)
    const scheduledTimeouts: number[] = []
    const result = await runBuffered(process.execPath, [
      '--eval',
      'setInterval(() => {}, 1_000)'
    ], {
      logger,
      mirrorStdout: false,
      mirrorStderr: false,
      timeoutMs: 60_000,
      timeoutControl: {
        schedule: (callback, milliseconds) => {
          scheduledTimeouts.push(milliseconds)
          queueMicrotask(callback)
          return Symbol('timeout')
        },
        cancel: () => {}
      }
    })

    assert.strictEqual(result.code, 124)
    assert.strictEqual(result.timedOut, true)
    assert.deepStrictEqual(scheduledTimeouts, [60_000])
    assert.match(result.stderr, /Command timed out after 60000 milliseconds\./)
    const log = readFileSync(context.workspaceLogPath, 'utf8')
    assert.strictEqual(log.match(/command error: Command timed out after 60000 milliseconds\./gu)?.length, 1)
    assert.strictEqual(log.match(/command exit: 124/gu)?.length, 1)
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
    assert.strictEqual(resolveProgressMode({ isTTY: true, verbose: true, env: { CI: 'false' } }), 'detailed')
    assert.strictEqual(resolveProgressMode({ isTTY: true, env: { CI: 'true' } }), 'verbose')
    assert.strictEqual(resolveProgressMode({ isTTY: false, env: { CI: 'false' } }), 'verbose')
    assert.strictEqual(resolveProgressMode({ json: true, isTTY: true, env: { CI: 'false' } }), 'none')
  })

  test('detailed progress enables lifecycle markers without raw command mode', () => {
    const progress = createProgress({ mode: 'detailed' })
    assert.strictEqual(progress.detailed, true)
    assert.strictEqual(progress.rawOutput, false)
    assert.deepStrictEqual(progress.commandEnv(), {
      BOXDOWN_VERBOSE: '0',
      BOXDOWN_PROGRESS: '1'
    })
  })

  test('raw progress preserves raw command mode', () => {
    const progress = createProgress({ mode: 'verbose' })
    assert.strictEqual(progress.detailed, false)
    assert.strictEqual(progress.rawOutput, true)
    assert.deepStrictEqual(progress.commandEnv(), {
      BOXDOWN_VERBOSE: '1',
      BOXDOWN_PROGRESS: '0'
    })
  })

  test('detailed progress appends normalized lifecycle output without redraws', () => {
    const lines: string[] = []
    const raw: string[] = []
    const progress = createProgress({
      mode: 'detailed',
      isTTY: true,
      write: (_target, message) => lines.push(message),
      writeRaw: (_target, message) => raw.push(message)
    })

    progress.section('Boxdown setup')
    progress.detail('Workspace: /tmp/demo')
    progress.item('  Preparing   workspace  ')
    progress.status('  Waiting for Docker daemon  ')
    progress.marker('  configuring runtime  ')
    progress.setSteps([{ id: 'demo', label: 'Running demo command' }])
    progress.startStep('demo')
    progress.completeStep('demo')
    progress.failStep('demo')
    progress.skipStep('demo')
    progress.startSpinner('  Running fallback command  ')
    progress.warn('Docker Buildx is unavailable')
    progress.end()

    assert.deepStrictEqual(lines, [
      'Boxdown setup',
      '  Workspace: /tmp/demo',
      'Preparing workspace',
      'Waiting for Docker daemon',
      'configuring runtime',
      'Running demo command',
      'Failed: Running demo command',
      'Skipped: Running demo command',
      'Running fallback command',
      'Warning: Docker Buildx is unavailable'
    ])
    assert.deepStrictEqual(raw, [])
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

  test('progress status is visible once in interactive and verbose modes', () => {
    const interactiveLines: string[] = []
    const verboseLines: string[] = []
    createProgress({ mode: 'interactive', write: (_target, message) => interactiveLines.push(message) })
      .status('Waiting for Docker daemon')
    createProgress({ mode: 'verbose', write: (_target, message) => verboseLines.push(message) })
      .status('Waiting for Docker daemon')

    assert.strictEqual(interactiveLines.length, 1)
    assert.deepStrictEqual(verboseLines, ['Waiting for Docker daemon'])
  })

  test('interactive TTY status stays above an active checklist across redraws', () => {
    const output: string[] = []
    const progress = createProgress({
      mode: 'interactive',
      isTTY: true,
      spinnerIntervalMs: 60_000,
      write: (_target, message) => output.push(`line:${message}`),
      writeRaw: (_target, message) => output.push(`raw:${message}`)
    })
    progress.setSteps([
      { id: 'container-runtime', label: 'Checking container runtime' },
      { id: 'devcontainer-start', label: 'Starting devcontainer' }
    ])
    progress.startStep('container-runtime')

    const beforeStatus = output.length
    progress.status('Waiting for Docker daemon')
    const statusOutput = output.slice(beforeStatus)
    assert.strictEqual(statusOutput[0], 'raw:\u001B[2A\r\u001B[2K')
    assert.match(statusOutput[1] ?? '', /Waiting for Docker daemon/)
    assert.strictEqual(statusOutput.slice(2).map((entry) => entry.slice(0, 4)).join(''), 'raw:raw:')
    assert.strictEqual(statusOutput.filter((entry) => entry.includes('Checking container runtime')).length, 1)
    assert.strictEqual(statusOutput.filter((entry) => entry.includes('Starting devcontainer')).length, 1)

    progress.completeStep('container-runtime')
    progress.end()
    assert.strictEqual(output.filter((entry) => entry.includes('Waiting for Docker daemon')).length, 1)
  })

  test('interactive TTY warning stays above an active checklist across redraws', () => {
    const output: string[] = []
    const progress = createProgress({
      mode: 'interactive',
      isTTY: true,
      spinnerIntervalMs: 60_000,
      write: (_target, message) => output.push(`line:${message}`),
      writeRaw: (_target, message) => output.push(`raw:${message}`)
    })
    progress.setSteps([
      { id: 'container-runtime', label: 'Checking container runtime' },
      { id: 'devcontainer-start', label: 'Starting devcontainer' }
    ])
    progress.startStep('container-runtime')

    const beforeWarning = output.length
    progress.warn('Docker Buildx is unavailable; using fallback')
    const warningOutput = output.slice(beforeWarning)
    assert.strictEqual(warningOutput[0], 'raw:\u001B[2A\r\u001B[2K')
    assert.match(warningOutput[1] ?? '', /Docker Buildx is unavailable; using fallback/)
    assert.strictEqual(warningOutput.slice(2).map((entry) => entry.slice(0, 4)).join(''), 'raw:raw:')
    assert.strictEqual(warningOutput.filter((entry) => entry.includes('Checking container runtime')).length, 1)
    assert.strictEqual(warningOutput.filter((entry) => entry.includes('Starting devcontainer')).length, 1)

    progress.completeStep('container-runtime')
    progress.end()
    assert.strictEqual(output.filter((entry) => entry.includes('Docker Buildx is unavailable; using fallback')).length, 1)
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

  test('wraps interactive progress details and hard-wraps workspace paths under the rail', () => {
    const lines: string[] = []
    const progress = createProgress({
      mode: 'interactive',
      columns: 24,
      color: false,
      write: (_target, message) => lines.push(message)
    })
    const path = '/Users/demo/projects/a-very-long-workspace'

    progress.section('Boxdown setup with a long title')
    progress.detail(`Workspace: ${path}`)
    progress.item('Writing generated devcontainer configuration')
    progress.end()

    for (const line of lines) {
      assert.ok(Array.from(line).length <= 24, line)
    }
    assert.ok(lines.filter((line) => line.startsWith('│  ')).length > 3)
    assert.ok(lines.join('').replace(/[◆│└\s]/gu, '').includes(path))
  })

  test('redraws wrapped checklist steps using their physical row count', () => {
    const raw: string[] = []
    const progress = createProgress({
      mode: 'interactive',
      columns: 24,
      isTTY: true,
      color: false,
      spinnerIntervalMs: 60_000,
      writeRaw: (_target, message) => raw.push(message)
    })

    progress.setSteps([
      { id: 'one', label: 'Writing generated devcontainer configuration' },
      { id: 'two', label: 'Configuring SSH alias' }
    ])
    progress.startStep('one')

    const cursorUps = raw.join('').match(/\u001B\[(\d+)A/gu) ?? []
    assert.ok(cursorUps.some((entry) => Number(entry.match(/\d+/u)?.[0]) > 2))
    progress.completeStep('one')
    progress.end()
  })

  test('clears and redraws every row of a wrapped spinner', () => {
    const raw: string[] = []
    const progress = createProgress({
      mode: 'interactive',
      columns: 20,
      isTTY: true,
      color: false,
      spinnerFrames: ['x'],
      spinnerIntervalMs: 60_000,
      writeRaw: (_target, message) => raw.push(message)
    })

    progress.startSpinner('Starting a deliberately long operation')
    progress.tickSpinner()
    progress.stopSpinner()

    assert.ok(raw.join('').includes('\u001B[1A'))
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
    assert.ok(rendered.includes(`${color('✖', 'red')} Installing SSH alias`))
    assert.ok(rendered.includes(`${color('□', 'dim')} ${color('Installing SSH alias', 'dim')}`))
    assert.match(rendered, /\u001B\[3A/)
  })

  test('renders failed checklist steps with a red cross or a plain cross', () => {
    for (const colorEnabled of [true, false]) {
      const raw: string[] = []
      const progress = createProgress({
        isTTY: true,
        color: colorEnabled,
        spinnerIntervalMs: 60_000,
        writeRaw: (_target, message) => raw.push(message)
      })

      progress.setSteps([{ id: 'install', label: 'Installing SSH alias' }])
      progress.failStep('install')
      progress.end()

      const rendered = raw.join('')
      const expected = colorEnabled ? color('✖', 'red') : '✖'
      assert.ok(rendered.includes(`${expected} Installing SSH alias`), rendered)
      if (!colorEnabled) assert.doesNotMatch(rendered, /\u001B\[[0-9;]*m/u)
    }
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
    assert.ok(rendered.includes(`${color('✖', 'red')} Running failing command`))
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

  test('detailed progress renders lifecycle markers without mirroring child output', async () => {
    const lines: string[] = []
    const progress = createProgress({
      mode: 'detailed',
      write: (_target, message) => lines.push(message)
    })
    const result = await runProgressCommand('detailed demo', 'bash', [
      '-c',
      'printf "BOXDOWN_PROGRESS: Configuring global Git\\n"; printf "hidden raw stdout\\n"; printf "hidden raw stderr\\n" >&2'
    ], { progress })

    assert.strictEqual(result.code, 0)
    assert.ok(lines.includes('Configuring global Git'))
    assert.ok(!lines.some((line) => line.includes('hidden raw')))
  })

  test('buffers split stdout and stderr lifecycle markers independently', async () => {
    const lines: string[] = []
    const progress = createProgress({
      mode: 'detailed',
      write: (_target, message) => lines.push(message)
    })
    const result = await runProgressCommand('interleaved markers', 'bash', [
      '-c',
      [
        'printf "BOXDOWN_PROGRESS: stdout"',
        'sleep 0.05',
        'printf "BOXDOWN_PROGRESS: stderr marker\\n" >&2',
        'sleep 0.05',
        'printf " marker\\n"'
      ].join('; ')
    ], { progress })

    assert.strictEqual(result.code, 0)
    assert.deepStrictEqual(lines, [
      'stderr marker',
      'stdout marker'
    ])
  })

  test('raw progress still mirrors stdout and stderr to its requested targets', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const progress = createProgress({ mode: 'verbose' })
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      if (String(chunk) === 'raw stdout\n') stdout.push(String(chunk))
      return originalStdoutWrite.call(process.stdout, chunk)
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      if (String(chunk) === 'raw stderr\n') stderr.push(String(chunk))
      return originalStderrWrite.call(process.stderr, chunk)
    }) as typeof process.stderr.write
    try {
      await runProgressCommand('raw demo', 'bash', ['-c', 'printf "raw stdout\\n"; printf "raw stderr\\n" >&2'], { progress })
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
    }
    assert.deepStrictEqual(stdout, ['raw stdout\n'])
    assert.deepStrictEqual(stderr, ['raw stderr\n'])
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
    assert.match(message, /Inspect the command log for full redacted command output\./)
    assert.match(message, /Rerun in a non-interactive terminal with --verbose to stream raw command output\./)
    assert.match(message, /stderr tail:/)
    assert.match(message, /stderr two/)
    assert.match(message, /stdout tail:/)
    assert.match(message, /stdout two/)
    assert.doesNotMatch(message, /hidden marker/)
  })

  test('zero failure-tail budget emits no output tails', () => {
    const message = formatCommandFailure('demo', {
      code: 1,
      stdout: 'stdout detail\n',
      stderr: 'stderr detail\n'
    }, { tailLines: 0 })

    assert.doesNotMatch(message, /stdout tail|stderr tail|stdout detail|stderr detail/)
  })

  test('specific stderr wins over a generic Dev Containers wrapper', () => {
    const wrapper = JSON.stringify({
      outcome: 'error',
      message: 'Command failed: docker buildx build --load',
      description: 'An error occurred setting up the container.'
    })
    const message = formatCommandFailure('devcontainer up', {
      code: 1,
      stdout: `${wrapper}\n`,
      stderr: 'failed to solve: registry authentication failed\n'
    }, { logPath: '/tmp/workspace/boxdown.log' })

    assert.match(message, /registry authentication failed/)
    assert.doesNotMatch(message, /docker buildx build --load/)
    assert.doesNotMatch(message, /Rerun in a non-interactive terminal/)
    assert.match(message, /Command log: \/tmp\/workspace\/boxdown\.log/)
  })

  test('wrapper-only failures explain the missing nested diagnostic', () => {
    const wrapper = JSON.stringify({
      outcome: 'error',
      message: 'Command failed: docker buildx build --load',
      description: 'An error occurred setting up the container.'
    })
    const message = formatCommandFailure('devcontainer up', {
      code: 1,
      stdout: `${wrapper}\n`,
      stderr: ''
    })

    assert.match(message, /nested command failure without diagnostic output/)
    assert.doesNotMatch(message, /docker buildx build --load/)
  })

  test('zero failure-tail budget does not hide a stderr diagnostic behind a Dev Containers wrapper', () => {
    const wrapper = JSON.stringify({
      outcome: 'error',
      message: 'Command failed: docker buildx build --load'
    })
    const message = formatCommandFailure('devcontainer up', {
      code: 1,
      stdout: `${wrapper}\n`,
      stderr: 'failed to solve: registry authentication failed\n'
    }, { tailLines: 0 })

    assert.doesNotMatch(message, /nested command failure without diagnostic output/)
  })

  test('zero failure-tail budget does not hide a stdout diagnostic behind a Dev Containers wrapper', () => {
    const wrapper = JSON.stringify({
      outcome: 'error',
      message: 'Command failed: docker buildx build --load'
    })
    const message = formatCommandFailure('devcontainer up', {
      code: 1,
      stdout: `${wrapper}\nfailed to solve: registry authentication failed\n`,
      stderr: ''
    }, { tailLines: 0 })

    assert.doesNotMatch(message, /nested command failure without diagnostic output/)
  })

  test('devcontainer up remains a single-attempt operation after runtime readiness', async () => {
    const workspace = tempDir('devcontainer-up-single-attempt-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('devcontainer-up-single-attempt-cache'),
        BOXDOWN_DATA_HOME: tempDir('devcontainer-up-single-attempt-data')
      },
      assetsDevcontainerDir
    })
    const wrapper = JSON.stringify({
      outcome: 'error',
      message: 'Command failed: docker buildx build --load'
    })
    const calls: Array<{ label: string, command: string, args: string[] }> = []

    mkdirSync(context.sshKeyDir, { recursive: true })
    writeFileSync(context.sshKeyPath, 'test private key\n')
    writeFileSync(context.sshPublicKeyPath, 'test public key\n')

    await withFakeDocker([], async (_logPath, dockerEnv) => {
      await withProcessEnv(dockerEnv as Record<string, string>, async () => {
        await assert.rejects(
          startDevcontainer(context, {
            progress: createProgress({ mode: 'none' }),
            runDevcontainerUp: async (label, command, args) => {
              calls.push({ label, command, args })
              return {
                code: 1,
                stdout: `${wrapper}\n`,
                stderr: 'failed to solve: registry authentication failed\n'
              }
            }
          }),
          (error: unknown) => {
            assert.ok(error instanceof Error)
            assert.match(error.message, /registry authentication failed/)
            assert.doesNotMatch(error.message, /docker buildx build --load/)
            assert.doesNotMatch(error.message, /Command log:/)
            return true
          }
        )
      })
    })

    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0]?.label, 'devcontainer up')
    assert.ok(calls[0]?.args.includes('up'))
  })

  test('recreate bypasses running-container reuse and removes the existing container', async () => {
    const workspace = tempDir('devcontainer-recreate-workspace')

    await withFakeDocker([{ workspace, id: 'running-container', agentProfileMarker: 'auth' }], async (logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('devcontainer-recreate-cache'),
        BOXDOWN_DATA_HOME: tempDir('devcontainer-recreate-data')
      }
      const context = createWorkspaceContext({
        workspace,
        env,
        assetsDevcontainerDir
      })
      let capturedArgs: string[] | undefined

      mkdirSync(context.sshKeyDir, { recursive: true })
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')

      await withProcessEnv(env, async () => {
        await startDevcontainer(context, {
          recreate: true,
          reuseRunning: true,
          progress: createProgress({ mode: 'none' }),
          runDevcontainerUp: async (_label, _command, args) => {
            capturedArgs = args
            return {
              code: 0,
              stdout: '{"containerId":"running-container"}\n',
              stderr: ''
            }
          }
        })
      })

      assert.ok(capturedArgs?.includes('up'))
      assert.ok(capturedArgs?.includes('--remove-existing-container'))
      assert.strictEqual(fakeDockerCalls(logPath).some(call => call.includes('{{.ID}}')), false)
    })
  })

  test('devcontainer failures advertise the exact managed log when a logger participates', async () => {
    const workspace = tempDir('devcontainer-up-logged-failure-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('devcontainer-up-logged-failure-cache'),
        BOXDOWN_DATA_HOME: tempDir('devcontainer-up-logged-failure-data')
      },
      assetsDevcontainerDir
    })
    const logger = createWorkspaceCommandLogger(context)

    mkdirSync(context.sshKeyDir, { recursive: true })
    writeFileSync(context.sshKeyPath, 'test private key\n')
    writeFileSync(context.sshPublicKeyPath, 'test public key\n')

    await withFakeDocker([], async (_logPath, dockerEnv) => {
      await withProcessEnv(dockerEnv as Record<string, string>, async () => {
        await assert.rejects(
          startDevcontainer(context, {
            logger,
            progress: createProgress({ mode: 'none' }),
            runDevcontainerUp: async () => ({
              code: 1,
              stdout: '',
              stderr: 'failed to solve: registry authentication failed\n'
            })
          }),
          (error: unknown) => {
            assert.ok(error instanceof Error)
            assert.ok(error.message.includes(`Command log: ${context.workspaceLogPath}`))
            return true
          }
        )
      })
    })
  })

  test('requires recreation when a stored toolchain plan is missing from an existing container intent', async () => {
    const workspace = tempDir('toolchain-legacy-container-workspace')

    await withFakeDocker([{ workspace, id: 'legacy-toolchain-container', agentProfileMarker: 'auth' }], async (_logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('toolchain-legacy-container-cache'),
        BOXDOWN_DATA_HOME: tempDir('toolchain-legacy-container-data')
      }
      const context = createWorkspaceContext({workspace, env, assetsDevcontainerDir})
      writeToolchainPlan(context, toolchainPlanFor(context))
      mkdirSync(context.sshKeyDir, {recursive: true})
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')
      writeGeneratedDevcontainerConfig(context, undefined, 'auth', null)

      await withProcessEnv(env, async () => assert.rejects(
        startDevcontainer(context, {reuseRunning: true, progress: createProgress({mode: 'none'})}),
        /Toolchain plan is not active in this devcontainer\.\nRun `boxdown start --recreate`\./
      ))
    })
  })

  test('requires recreation when an explicit none plan is missing from an existing container intent', async () => {
    const workspace = tempDir('toolchain-none-legacy-container-workspace')

    await withFakeDocker([{ workspace, id: 'legacy-none-toolchain-container', agentProfileMarker: 'auth' }], async (_logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('toolchain-none-legacy-container-cache'),
        BOXDOWN_DATA_HOME: tempDir('toolchain-none-legacy-container-data')
      }
      const context = createWorkspaceContext({workspace, env, assetsDevcontainerDir})
      writeToolchainPlan(context, toolchainPlanFor(context, 'none'))
      mkdirSync(context.sshKeyDir, {recursive: true})
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')
      writeGeneratedDevcontainerConfig(context, undefined, 'auth', null)

      await withProcessEnv(env, async () => assert.rejects(
        startDevcontainer(context, {reuseRunning: true, progress: createProgress({mode: 'none'})}),
        /Toolchain plan is not active in this devcontainer\.\nRun `boxdown start --recreate`\./
      ))
    })
  })

  test('requires recreation when the stored toolchain mount has the wrong source, target, or access mode', async () => {
    const workspace = tempDir('toolchain-invalid-mount-container-workspace')

    for (const mount of [
      `type=bind,source=/tmp/not-boxdown,target=${BOXDOWN_CONTAINER_TOOLCHAINS_DIR}/plan,readonly`,
      `type=bind,source=/tmp/toolchains,target=${BOXDOWN_CONTAINER_TOOLCHAINS_DIR}/plan/nested,readonly`,
      `type=bind,source=/tmp/toolchains,target=${BOXDOWN_CONTAINER_TOOLCHAINS_DIR}/plan`
    ]) {
      await withFakeDocker([{workspace, id: 'invalid-toolchain-container', agentProfileMarker: 'auth'}], async (_logPath, dockerEnv) => {
        const env = {
          ...dockerEnv,
          BOXDOWN_CACHE_HOME: tempDir('toolchain-invalid-mount-container-cache'),
          BOXDOWN_DATA_HOME: tempDir('toolchain-invalid-mount-container-data')
        }
        const context = createWorkspaceContext({workspace, env, assetsDevcontainerDir})
        writeToolchainPlan(context, toolchainPlanFor(context))
        mkdirSync(context.sshKeyDir, {recursive: true})
        writeFileSync(context.sshKeyPath, 'test private key\n')
        writeFileSync(context.sshPublicKeyPath, 'test public key\n')
        mkdirSync(context.workspaceCacheDir, {recursive: true})
        writeFileSync(context.generatedConfigPath, JSON.stringify({
          mounts: [mount.replace('/tmp/toolchains', context.toolchainsDir)]
        }))

        await withProcessEnv(env, async () => assert.rejects(
          startDevcontainer(context, {reuseRunning: true, progress: createProgress({mode: 'none'})}),
          /Toolchain plan is not active in this devcontainer\.\nRun `boxdown start --recreate`\./
        ))
      })
    }
  })

  test('allows a plan edit when the existing container already has toolchain mounts', async () => {
    const workspace = tempDir('toolchain-mounted-container-workspace')

    await withFakeDocker([{workspace, id: 'mounted-toolchain-container', agentProfileMarker: 'auth'}], async (_logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('toolchain-mounted-container-cache'),
        BOXDOWN_DATA_HOME: tempDir('toolchain-mounted-container-data')
      }
      const context = createWorkspaceContext({workspace, env, assetsDevcontainerDir})
      const initialPlan = toolchainPlanFor(context)
      writeToolchainPlan(context, initialPlan)
      mkdirSync(context.sshKeyDir, {recursive: true})
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')
      writeGeneratedDevcontainerConfig(context, undefined, 'auth', initialPlan)
      writeToolchainPlan(context, toolchainPlanFor(context, 'go@1.27.0'))

      const containerId = await withProcessEnv(env, async () => startDevcontainer(context, {
        reuseRunning: true,
        progress: createProgress({mode: 'none'})
      }))

      assert.strictEqual(containerId, 'mounted-toolchain-container')
    })
  })
})

describe('agent profile container lifecycle', () => {
  test('profile marker inspection accepts validated values and ignores invalid or unreadable content', async () => {
    const workspace = tempDir('profile-marker-workspace')
    const markers = [
      { id: 'profile-none', marker: 'none', expected: { profile: 'none', mode: 'copy' } },
      { id: 'profile-auth', marker: 'auth', expected: copiedAuthContainerProfile },
      { id: 'profile-full-live', marker: ' full:live ', expected: liveFullContainerProfile },
      { id: 'profile-full-legacy', marker: ' full ', expected: legacyFullContainerProfile },
      { id: 'profile-whitespace', marker: '   ', expected: undefined },
      { id: 'profile-invalid', marker: 'host-root', expected: undefined },
      { id: 'profile-absent', marker: undefined, expected: undefined }
    ] as const

    await withFakeDocker(markers.map(({ id, marker }) => ({
      workspace,
      id,
      ...(marker === undefined ? {} : { agentProfileMarker: marker })
    })), async (logPath, dockerEnv) => {
      await withProcessEnv(dockerEnv as Record<string, string>, async () => {
        for (const marker of markers) {
          assert.deepStrictEqual(await inspectFakeContainerAgentProfile(marker.id), marker.expected, marker.id)
        }
        assert.strictEqual(await inspectFakeContainerAgentProfile('docker-error'), undefined)
      })

      const calls = fakeDockerCalls(logPath)
      for (const marker of markers) {
        assert.ok(calls.includes(`exec ${marker.id} cat /opt/boxdown/state/agent-profile`), marker.id)
      }
      assert.ok(calls.includes('exec docker-error cat /opt/boxdown/state/agent-profile'))
      assert.strictEqual(calls.some((call) => call.includes('host-root') || call.includes(' full')), false)
    })
  })

  test('profile marker inspection keeps invalid credential-like content out of the workspace command log', async () => {
    const workspace = tempDir('profile-marker-private-log-workspace')
    const marker = 'ANTHROPIC_API_KEY=marker-credential-secret'

    await withFakeDocker([{
      workspace,
      id: 'profile-private-log',
      agentProfileMarker: marker
    }], async (_logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('profile-marker-private-log-cache'),
        BOXDOWN_DATA_HOME: tempDir('profile-marker-private-log-data')
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      const logger = createWorkspaceCommandLogger(context)
      logger.section('profile marker privacy')

      await withProcessEnv(env as Record<string, string>, async () => {
        assert.strictEqual(await inspectContainerAgentProfile('profile-private-log', { logger }), undefined)
      })

      const log = readFileSync(context.workspaceLogPath, 'utf8')
      assert.match(log, /command start: \["docker","exec","profile-private-log","cat","\/opt\/boxdown\/state\/agent-profile"\]/)
      assert.match(log, /command exit: 0/)
      assert.doesNotMatch(log, /ANTHROPIC_API_KEY/)
      assert.doesNotMatch(log, /marker-credential-secret/)
    })
  })

  test('agent profile lifecycle fails reuse progress before a missing marker can be recorded successful', async () => {
    const workspace = tempDir('agent-profile-reuse-progress-workspace')

    await withFakeDocker([{
      workspace,
      id: 'reuse-progress',
      agentProfileMarker: 'invalid-marker'
    }], async (_logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('agent-profile-reuse-progress-cache'),
        BOXDOWN_DATA_HOME: tempDir('agent-profile-reuse-progress-data')
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      const progress = createProgress({ mode: 'none' })
      progress.setSteps([
        { id: 'ssh-identity', label: 'Preparing SSH identity' },
        { id: 'devcontainer-config', label: 'Writing generated devcontainer config' },
        { id: 'devcontainer-start', label: 'Starting devcontainer' }
      ])
      const events = recordProgressStepEvents(progress, 'devcontainer-start')

      mkdirSync(context.sshKeyDir, { recursive: true })
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')
      writeGeneratedDevcontainerConfig(context, undefined, 'auth')

      await withProcessEnv(env as Record<string, string>, async () => {
        await assert.rejects(startDevcontainer(context, {
          agentProfile: 'auth',
          reuseRunning: true,
          progress
        }), /Agent profile auth is not active/)
      })

      assert.deepStrictEqual(events, [
        'start:devcontainer-start',
        'fail:devcontainer-start'
      ])
    })
  })

  test('agent profile lifecycle fails normal startup progress before a missing marker can be recorded successful', async () => {
    const workspace = tempDir('agent-profile-up-progress-workspace')
    const hiddenWorkspace = tempDir('agent-profile-up-progress-hidden-workspace')

    await withFakeDocker([{
      workspace: hiddenWorkspace,
      id: 'up-progress',
      agentProfileMarker: 'invalid-marker'
    }], async (_logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('agent-profile-up-progress-cache'),
        BOXDOWN_DATA_HOME: tempDir('agent-profile-up-progress-data')
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      const progress = createProgress({ mode: 'none' })
      progress.setSteps([
        { id: 'ssh-identity', label: 'Preparing SSH identity' },
        { id: 'devcontainer-config', label: 'Writing generated devcontainer config' },
        { id: 'devcontainer-start', label: 'Starting devcontainer' }
      ])
      const events = recordProgressStepEvents(progress, 'devcontainer-start')

      mkdirSync(context.sshKeyDir, { recursive: true })
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')

      await withProcessEnv(env as Record<string, string>, async () => {
        await assert.rejects(startDevcontainer(context, {
          agentProfile: 'auth',
          progress,
          runDevcontainerUp: async () => {
            updateFakeDockerContainer(env, 'up-progress', { workspace })
            return { code: 0, stdout: '{"containerId":"up-progress"}\n', stderr: '' }
          }
        }), /Agent profile auth is not active/)
      })

      assert.deepStrictEqual(events, [
        'start:devcontainer-start',
        'fail:devcontainer-start'
      ])
    })
  })

  test('agent profile lifecycle keeps the no-checklist spinner pending through marker validation failure', async () => {
    const workspace = tempDir('agent-profile-spinner-marker-workspace')
    const hiddenWorkspace = tempDir('agent-profile-spinner-marker-hidden-workspace')

    await withFakeDocker([{
      workspace: hiddenWorkspace,
      id: 'spinner-marker',
      agentProfileMarker: 'invalid-marker'
    }], async (_logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('agent-profile-spinner-marker-cache'),
        BOXDOWN_DATA_HOME: tempDir('agent-profile-spinner-marker-data')
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      const rendered: string[] = []
      const progress = createProgress({
        mode: 'interactive',
        isTTY: false,
        write: (_target, message) => { rendered.push(message) }
      })
      const events = recordProgressSpinnerEvents(progress)

      mkdirSync(context.sshKeyDir, { recursive: true })
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')

      await withProcessEnv(env as Record<string, string>, async () => {
        await assert.rejects(startDevcontainer(context, {
          agentProfile: 'auth',
          progress,
          runDevcontainerUp: async (label, _command, _args, runOptions) => {
            const result = await runProgressCommand(
              label,
              'bash',
              ['-c', 'printf \'%s\\n\' \'{"containerId":"spinner-marker"}\''],
              runOptions
            )
            updateFakeDockerContainer(env, 'spinner-marker', { workspace })
            return result
          }
        }), /Agent profile auth is not active/)
      })

      assert.ok(events.includes('start:Starting devcontainer'))
      assert.strictEqual(events.includes('stop:complete'), false)
      assert.strictEqual(events.at(-1), 'stop:clear')
      assert.strictEqual(
        rendered.some((line) => line.includes(`${selectedMark()} Starting devcontainer`)),
        false
      )
    })
  })

  test('agent profile lifecycle clears the no-checklist spinner when container ID resolution fails', async () => {
    const workspace = tempDir('agent-profile-spinner-id-workspace')

    await withFakeDocker([], async (_logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('agent-profile-spinner-id-cache'),
        BOXDOWN_DATA_HOME: tempDir('agent-profile-spinner-id-data')
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      const rendered: string[] = []
      const progress = createProgress({
        mode: 'interactive',
        isTTY: false,
        write: (_target, message) => { rendered.push(message) }
      })
      const events = recordProgressSpinnerEvents(progress)

      mkdirSync(context.sshKeyDir, { recursive: true })
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')

      await withProcessEnv(env as Record<string, string>, async () => {
        await assert.rejects(startDevcontainer(context, {
          agentProfile: 'auth',
          progress,
          runDevcontainerUp: async (label, _command, _args, runOptions) => runProgressCommand(
            label,
            'bash',
            ['-c', 'true'],
            runOptions
          )
        }), /Could not resolve devcontainer ID/)
      })

      assert.ok(events.includes('start:Starting devcontainer'))
      assert.strictEqual(events.includes('stop:complete'), false)
      assert.strictEqual(events.at(-1), 'stop:clear')
      assert.strictEqual(
        rendered.some((line) => line.includes(`${selectedMark()} Starting devcontainer`)),
        false
      )
    })
  })

  test('agent profile lifecycle rejects a legacy full running marker before devcontainer up', async () => {
    const workspace = tempDir('agent-profile-stale-running-workspace')

    await withFakeDocker([{ workspace, id: 'stale-running', agentProfileMarker: 'full' }], async (logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('agent-profile-stale-running-cache'),
        BOXDOWN_DATA_HOME: tempDir('agent-profile-stale-running-data')
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      let upCalls = 0

      mkdirSync(context.sshKeyDir, { recursive: true })
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')
      writeGeneratedDevcontainerConfig(context, undefined, 'full')

      await withProcessEnv(env as Record<string, string>, async () => {
        await assert.rejects(startDevcontainer(context, {
          agentProfile: 'full',
          reuseRunning: true,
          progress: createProgress({ mode: 'none' }),
          runDevcontainerUp: async () => {
            upCalls += 1
            return { code: 0, stdout: '{"containerId":"stale-running"}\n', stderr: '' }
          }
        }), /Agent profile full is not active in this devcontainer\.\nRun `boxdown start --recreate --agent-profile full`\./)
      })

      assert.strictEqual(upCalls, 0)
      assert.strictEqual(readGeneratedAgentProfile(context), 'full')
      assert.ok(fakeDockerCalls(logPath).includes('exec stale-running cat /opt/boxdown/state/agent-profile'))
    })
  })

  test('agent profile lifecycle rejects a missing legacy profile marker', async () => {
    const workspace = tempDir('agent-profile-legacy-marker-workspace')

    await withFakeDocker([{ workspace, id: 'legacy-running' }], async (_logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('agent-profile-legacy-marker-cache'),
        BOXDOWN_DATA_HOME: tempDir('agent-profile-legacy-marker-data')
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      let upCalls = 0

      mkdirSync(context.sshKeyDir, { recursive: true })
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')

      await withProcessEnv(env as Record<string, string>, async () => {
        await assert.rejects(startDevcontainer(context, {
          agentProfile: 'auth',
          reuseRunning: true,
          progress: createProgress({ mode: 'none' }),
          runDevcontainerUp: async () => {
            upCalls += 1
            return { code: 0, stdout: '{"containerId":"legacy-running"}\n', stderr: '' }
          }
        }), /Agent profile auth is not active in this devcontainer\.\nRun `boxdown start --recreate --agent-profile auth`\./)
      })

      assert.strictEqual(upCalls, 0)
    })
  })

  test('agent profile lifecycle reuses a container with a matching marker', async () => {
    const workspace = tempDir('agent-profile-matching-reuse-workspace')

    await withFakeDocker([{ workspace, id: 'matching-running', agentProfileMarker: 'full:live' }], async (logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('agent-profile-matching-reuse-cache'),
        BOXDOWN_DATA_HOME: tempDir('agent-profile-matching-reuse-data')
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

      mkdirSync(context.sshKeyDir, { recursive: true })
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')

      const containerId = await withProcessEnv(env as Record<string, string>, async () => startDevcontainer(context, {
        agentProfile: 'full',
        reuseRunning: true,
        progress: createProgress({ mode: 'none' })
      }))

      assert.strictEqual(containerId, 'matching-running')
      assert.strictEqual(readGeneratedAgentProfile(context), 'full')
      assert.strictEqual(
        fakeDockerCalls(logPath).filter((call) => call === 'exec matching-running cat /opt/boxdown/state/agent-profile').length,
        2
      )
    })
  })

  test('recreate seeds a fresh profile marker through devcontainer up without host bootstrap mutation', async () => {
    const workspace = tempDir('recreate-fresh-profile-workspace')

    await withFakeDocker([{ workspace, id: 'recreated-profile', agentProfileMarker: 'auth' }], async (logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('recreate-fresh-profile-cache'),
        BOXDOWN_DATA_HOME: tempDir('recreate-fresh-profile-data')
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
      let capturedArgs: string[] = []

      mkdirSync(context.sshKeyDir, { recursive: true })
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')
      writeGeneratedDevcontainerConfig(context, undefined, 'auth')

      const containerId = await withProcessEnv(env as Record<string, string>, async () => startDevcontainer(context, {
        agentProfile: 'full',
        recreate: true,
        reuseRunning: true,
        progress: createProgress({ mode: 'none' }),
        runDevcontainerUp: async (_label, _command, args) => {
          capturedArgs = args
          updateFakeDockerContainer(env, 'recreated-profile', {
            containerState: 'running',
            agentProfileMarker: 'full:live'
          })
          return { code: 0, stdout: '{"containerId":"recreated-profile"}\n', stderr: '' }
        }
      }))

      const calls = fakeDockerCalls(logPath)
      assert.strictEqual(containerId, 'recreated-profile')
      assert.ok(capturedArgs.includes('--remove-existing-container'))
      assert.ok(calls.includes('exec recreated-profile cat /opt/boxdown/state/agent-profile'))
      assert.strictEqual(calls.some((call) => call.includes('agent-profile-bootstrap')), false)
      assert.strictEqual(calls.some((call) => call.startsWith('rm ')), false)
    })
  })

  test('container lifecycle restarts a stopped matching profile without invoking the bootstrap on the host', async () => {
    const workspace = tempDir('container-lifecycle-stopped-profile-workspace')

    await withFakeDocker([{
      workspace,
      id: 'stopped-profile',
      containerState: 'exited',
      agentProfileMarker: 'full'
    }], async (logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('container-lifecycle-stopped-profile-cache'),
        BOXDOWN_DATA_HOME: tempDir('container-lifecycle-stopped-profile-data')
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

      mkdirSync(context.sshKeyDir, { recursive: true })
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')
      writeGeneratedDevcontainerConfig(context, undefined, 'full')

      const containerId = await withProcessEnv(env as Record<string, string>, async () => startDevcontainer(context, {
        agentProfile: 'full',
        reuseRunning: true,
        progress: createProgress({ mode: 'none' }),
        runDevcontainerUp: async () => {
          updateFakeDockerContainer(env, 'stopped-profile', {
            containerState: 'running',
            agentProfileMarker: 'full:live'
          })
          return { code: 0, stdout: '{"containerId":"stopped-profile"}\n', stderr: '' }
        }
      }))

      const calls = fakeDockerCalls(logPath)
      assert.strictEqual(containerId, 'stopped-profile')
      assert.deepStrictEqual(
        calls.filter((call) => call === 'exec stopped-profile cat /opt/boxdown/state/agent-profile'),
        ['exec stopped-profile cat /opt/boxdown/state/agent-profile']
      )
      assert.strictEqual(calls.some((call) => call.includes('agent-profile-bootstrap')), false)
    })
  })

  test('agent profile lifecycle rejects a newly created container without a marker', async () => {
    const workspace = tempDir('agent-profile-new-missing-marker-workspace')

    await withFakeDocker([], async (_logPath, dockerEnv) => {
      const env = {
        ...dockerEnv,
        BOXDOWN_CACHE_HOME: tempDir('agent-profile-new-missing-marker-cache'),
        BOXDOWN_DATA_HOME: tempDir('agent-profile-new-missing-marker-data')
      }
      const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })

      mkdirSync(context.sshKeyDir, { recursive: true })
      writeFileSync(context.sshKeyPath, 'test private key\n')
      writeFileSync(context.sshPublicKeyPath, 'test public key\n')

      await withProcessEnv(env as Record<string, string>, async () => {
        await assert.rejects(startDevcontainer(context, {
          agentProfile: 'none',
          progress: createProgress({ mode: 'none' }),
          runDevcontainerUp: async () => ({
            code: 0,
            stdout: '{"containerId":"new-without-marker"}\n',
            stderr: ''
          })
        }), /Agent profile none is not active in this devcontainer\.\nRun `boxdown start --recreate --agent-profile none`\./)
      })
    })
  })
})

describe('Claude Code host credentials', () => {
  test('resolves documented Claude credential paths by platform', () => {
    assert.strictEqual(
      defaultHostClaudeCredentialsPath({ HOME: '/home/alice' }, 'linux'),
      '/home/alice/.claude/.credentials.json'
    )
    assert.strictEqual(
      defaultHostClaudeCredentialsPath({ USERPROFILE: 'C:\\Users\\Alice' }, 'win32'),
      'C:\\Users\\Alice\\.claude\\.credentials.json'
    )
    assert.strictEqual(
      defaultHostClaudeCredentialsPath({ CLAUDE_CONFIG_DIR: '/secure/claude' }, 'linux'),
      '/secure/claude/.credentials.json'
    )
    assert.strictEqual(defaultHostClaudeCredentialsPath({ HOME: '/Users/alice' }, 'darwin'), undefined)
    assert.strictEqual(defaultHostClaudeCredentialsPath({ HOME: '/home/alice' }, 'freebsd'), undefined)
  })

  test('does not mount an absent host Claude credential file', () => {
    const home = tempDir('claude-auth-absent-home')
    const credentialsPath = join(home, '.claude', '.credentials.json')
    const context = {
      ...createWorkspaceContext({
        workspace: tempDir('claude-auth-absent-workspace'),
        env: { HOME: home, BOXDOWN_CACHE_HOME: tempDir('claude-auth-absent-cache'), BOXDOWN_DATA_HOME: tempDir('claude-auth-absent-data') },
        assetsDevcontainerDir
      }),
      hostClaudeCredentialsPath: credentialsPath
    }

    const config = buildGeneratedDevcontainerConfig(context)

    assert.ok(!config.mounts?.some((mount) => mount.includes(`target=${BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH}`)))
  })

  test('does not mount a directory at the Claude credential source path', () => {
    const home = tempDir('claude-auth-non-regular-home')
    const credentialsPath = join(home, '.claude', '.credentials.json')
    mkdirSync(join(home, '.claude'))
    mkdirSync(credentialsPath)
    const directoryContext = {
      ...createWorkspaceContext({
        workspace: tempDir('claude-auth-directory-workspace'),
        env: { HOME: home, BOXDOWN_CACHE_HOME: tempDir('claude-auth-directory-cache'), BOXDOWN_DATA_HOME: tempDir('claude-auth-directory-data') },
        assetsDevcontainerDir
      }),
      hostClaudeCredentialsPath: credentialsPath
    }

    assert.ok(!buildGeneratedDevcontainerConfig(directoryContext).mounts?.some((mount) => mount.includes(`target=${BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH}`)))

  })

  test('does not mount a FIFO at the Claude credential source path', { skip: process.platform === 'win32' }, () => {
    const home = tempDir('claude-auth-fifo-home')
    const credentialsPath = join(home, '.claude', '.credentials.json')
    mkdirSync(join(home, '.claude'))
    execFileSync('mkfifo', [credentialsPath])
    const context = {
      ...createWorkspaceContext({
        workspace: tempDir('claude-auth-fifo-workspace'),
        env: { HOME: home, BOXDOWN_CACHE_HOME: tempDir('claude-auth-fifo-cache'), BOXDOWN_DATA_HOME: tempDir('claude-auth-fifo-data') },
        assetsDevcontainerDir
      }),
      hostClaudeCredentialsPath: credentialsPath
    }

    assert.ok(!buildGeneratedDevcontainerConfig(context).mounts?.some((mount) => mount.includes(`target=${BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH}`)))
  })

  test('preserves existing Claude config mounts without adding credentials', () => {
    const workspace = tempDir('claude-auth-duplicate-workspace')
    const home = tempDir('claude-auth-duplicate-home')
    const credentialsDir = join(home, '.claude')
    mkdirSync(credentialsDir)
    writeFileSync(join(credentialsDir, '.credentials.json'), '{}\n')

    for (const existingMount of [
      `type=bind,source=/tmp/claude,target=${BOXDOWN_CONTAINER_CLAUDE_DIR},readonly`,
      `type=bind,source=/tmp/credentials.json,target=${BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH},readonly`
    ]) {
      const customAssetsDir = tempDir('claude-auth-duplicate-assets')
      writeFileSync(join(customAssetsDir, 'devcontainer.json'), `${JSON.stringify({ mounts: [existingMount] })}\n`)
      const context = {
        ...createWorkspaceContext({
          workspace,
          env: {
            HOME: home,
            BOXDOWN_CACHE_HOME: tempDir('claude-auth-duplicate-cache'),
            BOXDOWN_DATA_HOME: tempDir('claude-auth-duplicate-data')
          },
          assetsDevcontainerDir: customAssetsDir
        }),
        hostClaudeCredentialsPath: join(credentialsDir, '.credentials.json')
      }

      const config = buildGeneratedDevcontainerConfig(context)

      assert.ok(config.mounts?.includes(existingMount))
      assert.ok(!config.mounts?.includes(`type=bind,source=${context.hostClaudeCredentialsPath},target=${BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH}`))
    }
  })
})

describe('devcontainer config generation', () => {
  test('mounts runtime secret state without Docker environment secret injection', () => {
    const context = createWorkspaceContext({
      workspace: tempDir('runtime-secret-config-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('runtime-secret-config-cache'),
        BOXDOWN_DATA_HOME: tempDir('runtime-secret-config-data'),
        BOXDOWN_RUNTIME_HOME: tempDir('runtime-secret-config-runtime')
      },
      assetsDevcontainerDir
    })

    const config = buildGeneratedDevcontainerConfig(context)
    const serialized = JSON.stringify(config)

    assert.ok(context.workspaceSecretEnvDir.startsWith(context.runtimeRoot))
    assert.ok(!context.workspaceSecretEnvDir.startsWith(context.workspaceDataDir))
    assert.ok(config.mounts?.includes(`type=bind,source=${context.workspaceSecretEnvDir},target=${BOXDOWN_CONTAINER_SECRET_ENV_DIR},readonly`))
    const dispatcherPath = `${BOXDOWN_CONTAINER_DEVCONTAINER_DIR}/utils/toolchains-env-bootstrap.sh`
    const dispatcher = readFileSync(join(assetsDevcontainerDir, 'utils', 'toolchains-env-bootstrap.sh'), 'utf8')
    assert.strictEqual(config.containerEnv?.BASH_ENV, dispatcherPath)
    assert.ok(config.mounts?.includes(
      `type=bind,source=${context.assetsDevcontainerDir},target=${BOXDOWN_CONTAINER_DEVCONTAINER_DIR},readonly`
    ))
    assert.ok(dispatcher.split(/\r?\n/u).some((line) => line === `source ${BOXDOWN_CONTAINER_SECRET_ENV_BOOTSTRAP}`))
    assert.strictEqual(config.containerEnv?.NODE_ENV, 'development')
    assert.doesNotMatch(serialized, /--env-file|\.env\.development|ANTHROPIC_API_KEY|SNYK_TOKEN|OP_SERVICE_ACCOUNT_TOKEN/)
  })

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
    assert.strictEqual(config.containerEnv?.SSH_AUTH_SOCK, '/run/boxdown/ssh-agent-node.sock')
    assert.strictEqual(config.containerEnv?.BOXDOWN_GIT_SIGNING_SOURCE_SOCKET, '/run/boxdown/ssh-agent.sock')
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

  test('agent profile mounts stage auth sources and mount full sources live', () => {
    const home = tempDir('agent-profile-home')
    const agentsDir = join(home, '.agents')
    const codexDir = join(home, '.codex')
    const claudeDir = join(home, '.claude')
    mkdirSync(agentsDir)
    mkdirSync(join(claudeDir, 'commands'), { recursive: true })
    mkdirSync(join(claudeDir, 'hooks'))
    mkdirSync(join(claudeDir, 'plugins'))
    mkdirSync(codexDir)
    writeFileSync(join(codexDir, 'auth.json'), '{"token":"secret"}\n')
    writeFileSync(join(codexDir, 'config.toml'), '[mcp_servers]\n')
    writeFileSync(join(codexDir, 'AGENTS.md'), 'private instructions\n')
    writeFileSync(join(claudeDir, '.credentials.json'), '{"token":"secret"}\n')
    writeFileSync(join(claudeDir, 'settings.json'), '{}\n')
    writeFileSync(join(claudeDir, 'CLAUDE.md'), 'private instructions\n')
    writeFileSync(join(home, '.claude.json'), '{"mcpServers":{}}\n')
    const context = createWorkspaceContext({
      workspace: tempDir('agent-profile-workspace'),
      env: { HOME: home, BOXDOWN_CACHE_HOME: tempDir('agent-profile-cache'), BOXDOWN_DATA_HOME: tempDir('agent-profile-data') },
      platform: 'linux',
      assetsDevcontainerDir
    })
    const expected = {
      none: { mounts: [], sources: '' },
      auth: {
        mounts: [
          `source=${agentsDir},target=${BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_AGENTS_DIR}`,
          `source=${join(codexDir, 'auth.json')},target=${BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CODEX_AUTH_PATH}`,
          `source=${join(claudeDir, '.credentials.json')},target=${BOXDOWN_CONTAINER_AGENT_PROFILE_SOURCE_CLAUDE_CREDENTIALS_PATH}`
        ],
        sources: 'agents,claude-auth,codex-auth'
      },
      full: {
        mounts: [
          `source=${agentsDir},target=${BOXDOWN_CONTAINER_AGENTS_DIR}`,
          `source=${codexDir},target=${BOXDOWN_CONTAINER_CODEX_DIR}`,
          `source=${claudeDir},target=${BOXDOWN_CONTAINER_CLAUDE_DIR}`,
          `source=${join(home, '.claude.json')},target=${BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH}`
        ],
        sources: 'agents,claude-config,claude-home,codex-home'
      }
    } as const

    for (const [profile, expectation] of Object.entries(expected)) {
      const config = buildGeneratedDevcontainerConfig(context, undefined, profile as 'none' | 'auth' | 'full')
      const profileMounts = config.mounts?.filter(mount => mount.includes('/opt/boxdown/agent-profile-source')) ?? []
      const expectedMounts = expectation.mounts.map(mount => `type=bind,${mount}`)
      const actualMounts = profile === 'full'
        ? config.mounts?.filter(mount => typeof mount === 'string' && mount.includes('/home/node/.')) ?? []
        : profileMounts
      assert.deepStrictEqual(actualMounts.map(mount => mount.replace(',readonly', '')).sort(), expectedMounts.sort())
      if (profile === 'full') {
        assert.ok(actualMounts.every(mount => !mount.endsWith(',readonly')))
        assert.deepStrictEqual(profileMounts, [])
      } else {
        assert.ok(profileMounts.every(mount => mount.endsWith(',readonly')))
      }
      assert.strictEqual(config.containerEnv?.BOXDOWN_AGENT_PROFILE, profile)
      assert.strictEqual(config.containerEnv?.BOXDOWN_AGENT_PROFILE_SOURCES, expectation.sources)
      assert.strictEqual(
        config.containerEnv?.BOXDOWN_AGENT_PROFILE_MANAGED_SOURCES,
        profile === 'full' ? expectation.sources : ''
      )
      assert.doesNotMatch(config.containerEnv?.BOXDOWN_AGENT_PROFILE_MANAGED_SOURCES ?? '', /(?:\/|\\|\.)/)
      assert.ok(config.initializeCommand?.includes(`BOXDOWN_AGENT_PROFILE='${profile}'`))
      if (profile !== 'full') {
        assert.ok(!profileMounts.some(mount => /target=\/home\/node\/\.(agents|codex|claude)(,|$)/.test(mount)))
      }
    }

    const fullConfig = buildGeneratedDevcontainerConfig(context, undefined, 'full')
    const fullMounts = fullConfig.mounts?.filter(mount =>
      typeof mount === 'string' && mount.includes('/home/node/.codex')
    ) ?? []
    assert.ok(fullMounts.some(mount =>
      mount.includes(`source=${context.hostCodexDir},target=/home/node/.codex`) &&
      !mount.endsWith(',readonly')
    ))
    assert.ok(!fullConfig.mounts?.some(mount =>
      typeof mount === 'string' && mount.includes('/opt/boxdown/agent-profile-source')
    ))
  })

  test('host agent paths honor configured roots and classify only top-level sources', () => {
    const home = tempDir('agent-profile-path-home')
    const customCodexDir = join(home, 'custom', 'codex')
    const customClaudeDir = join(home, 'custom', 'claude')
    mkdirSync(customCodexDir, { recursive: true })
    mkdirSync(customClaudeDir, { recursive: true })
    writeFileSync(join(customCodexDir, 'auth.json'), '{}\n')
    writeFileSync(join(customClaudeDir, '.credentials.json'), '{}\n')
    writeFileSync(join(customClaudeDir, '.claude.json'), '{}\n')
    const env = { HOME: home, CODEX_HOME: customCodexDir, CLAUDE_CONFIG_DIR: customClaudeDir, BOXDOWN_CACHE_HOME: tempDir('agent-profile-path-cache'), BOXDOWN_DATA_HOME: tempDir('agent-profile-path-data') }
    const context = createWorkspaceContext({ workspace: tempDir('agent-profile-path-workspace'), env, platform: 'linux', assetsDevcontainerDir })

    assert.strictEqual(defaultHostCodexDir(env), customCodexDir)
    assert.strictEqual(defaultHostClaudeDir(env, 'linux'), customClaudeDir)
    assert.strictEqual(context.hostCodexDir, customCodexDir)
    assert.strictEqual(context.hostCodexAuthPath, join(customCodexDir, 'auth.json'))
    assert.strictEqual(context.hostClaudeDir, customClaudeDir)
    assert.strictEqual(context.hostClaudeCredentialsPath, join(customClaudeDir, '.credentials.json'))
    assert.strictEqual(context.hostClaudeConfigPath, join(customClaudeDir, '.claude.json'))
    const config = buildGeneratedDevcontainerConfig(context, undefined, 'full')
    assert.ok(config.mounts?.some(mount => mount.includes(`source=${customClaudeDir},target=${BOXDOWN_CONTAINER_CLAUDE_DIR}`) && !mount.endsWith(',readonly')))
    assert.ok(!config.mounts?.some(mount => mount.includes(`target=${BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH}`)))

    const defaults = createWorkspaceContext({ workspace: tempDir('agent-profile-default-paths'), env: { HOME: home, BOXDOWN_CACHE_HOME: tempDir('agent-profile-default-cache'), BOXDOWN_DATA_HOME: tempDir('agent-profile-default-data') }, platform: 'linux', assetsDevcontainerDir })
    assert.strictEqual(defaults.hostCodexDir, join(home, '.codex'))
    assert.strictEqual(defaults.hostClaudeDir, join(home, '.claude'))
    assert.strictEqual(defaults.hostClaudeConfigPath, join(home, '.claude.json'))
    assert.strictEqual(buildGeneratedDevcontainerConfig(defaults, undefined, 'auth').containerEnv?.BOXDOWN_AGENT_PROFILE_SOURCES, '')
  })

  test('does not separately mount Claude config nested in configured roots', () => {
    const home = tempDir('agent-profile-nested-claude-home')
    const claudeDir = join(home, 'configured-claude')
    mkdirSync(claudeDir)
    writeFileSync(join(claudeDir, '.claude.json'), '{}\n')
    const context = createWorkspaceContext({
      workspace: tempDir('agent-profile-nested-claude-workspace'),
      env: { HOME: home, CLAUDE_CONFIG_DIR: `${claudeDir}/`, BOXDOWN_CACHE_HOME: tempDir('agent-profile-nested-claude-cache'), BOXDOWN_DATA_HOME: tempDir('agent-profile-nested-claude-data') },
      platform: 'linux',
      assetsDevcontainerDir
    })
    const config = buildGeneratedDevcontainerConfig(context, undefined, 'full')

    assert.ok(config.mounts?.some(mount => mount.includes(`source=${context.hostClaudeDir},target=${BOXDOWN_CONTAINER_CLAUDE_DIR}`) && !mount.endsWith(',readonly')))
    assert.ok(!config.mounts?.some(mount => mount.includes(`target=${BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH}`)))
    assert.strictEqual(sourcePathIsInside('C:\\custom\\claude\\.claude.json', 'C:\\custom\\claude'), true)
    assert.strictEqual(sourcePathIsInside('C:\\custom\\claude-other\\.claude.json', 'C:\\custom\\claude'), false)
    assert.strictEqual(sourcePathIsInside('C:\\custom\\claude\\..\\outside.json', 'C:\\custom\\claude'), false)
  })

  test('custom profile mounts retain ownership while discovered sources remain available', () => {
    const home = tempDir('custom-profile-home')
    const agentsDir = join(home, '.agents')
    const codexDir = join(home, '.codex')
    const claudeDir = join(home, '.claude')
    mkdirSync(agentsDir)
    mkdirSync(codexDir)
    mkdirSync(claudeDir)
    writeFileSync(join(codexDir, 'auth.json'), '{}\n')
    writeFileSync(join(claudeDir, '.credentials.json'), '{}\n')
    writeFileSync(join(home, '.claude.json'), '{}\n')
    const cases = [
      [BOXDOWN_CONTAINER_AGENTS_DIR, 'agents', BOXDOWN_CONTAINER_AGENTS_DIR],
      [BOXDOWN_CONTAINER_CODEX_DIR, 'codex', BOXDOWN_CONTAINER_CODEX_DIR],
      [BOXDOWN_CONTAINER_CODEX_AUTH_PATH, 'codex', BOXDOWN_CONTAINER_CODEX_DIR],
      [BOXDOWN_CONTAINER_CLAUDE_DIR, 'claude', BOXDOWN_CONTAINER_CLAUDE_DIR],
      [BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH, 'claude', BOXDOWN_CONTAINER_CLAUDE_DIR],
      [BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH, 'claude-config', BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH],
      ['/home/node', 'agents', BOXDOWN_CONTAINER_AGENTS_DIR],
      ['/home/node/.codex/custom-child', 'codex', BOXDOWN_CONTAINER_CODEX_DIR]
    ] as const

    for (const [destination, sourceName, skippedTarget] of cases) {
      const mount = `type=bind,source=/custom/${destination.replaceAll('/', '-')},target=${destination},readonly`
      const customAssetsDir = tempDir('custom-profile-assets')
      writeFileSync(join(customAssetsDir, 'devcontainer.json'), `${JSON.stringify({ mounts: [mount] })}\n`)
      const context = createWorkspaceContext({
        workspace: tempDir('custom-profile-workspace'),
        env: { HOME: home, BOXDOWN_CACHE_HOME: tempDir('custom-profile-cache'), BOXDOWN_DATA_HOME: tempDir('custom-profile-data') },
        platform: 'linux',
        assetsDevcontainerDir: customAssetsDir
      })
      const config = buildGeneratedDevcontainerConfig(context, undefined, 'full')
      const source = sourceName === 'agents'
        ? context.hostAgentsDir
        : sourceName === 'codex'
          ? context.hostCodexDir
          : sourceName === 'claude'
            ? context.hostClaudeDir
            : context.hostClaudeConfigPath
      assert.ok(config.mounts?.includes(mount))
      assert.ok(
        !config.mounts?.some(candidate => candidate.includes(`source=${source},target=${skippedTarget},`)),
        `${destination} should suppress ${skippedTarget}: ${JSON.stringify(config.mounts)}`
      )
      if (destination === '/home/node') {
        assert.deepStrictEqual(
          config.mounts?.filter(candidate => [
            BOXDOWN_CONTAINER_AGENTS_DIR,
            BOXDOWN_CONTAINER_CODEX_DIR,
            BOXDOWN_CONTAINER_CLAUDE_DIR,
            BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH
          ].some(target => candidate.includes(`target=${target},`))),
          [],
          '/home/node ownership should suppress every direct profile source'
        )
      }
      assert.strictEqual(config.containerEnv?.BOXDOWN_AGENT_PROFILE_SOURCES, 'agents,claude-config,claude-home,codex-home')
    }

    const boundaryMount = 'type=bind,source=/custom/codex-other,target=/home/node/.codex-other,readonly'
    const boundaryAssetsDir = tempDir('custom-profile-boundary-assets')
    writeFileSync(join(boundaryAssetsDir, 'devcontainer.json'), `${JSON.stringify({ mounts: [boundaryMount] })}\n`)
    const boundaryContext = createWorkspaceContext({
      workspace: tempDir('custom-profile-boundary-workspace'),
      env: { HOME: home, BOXDOWN_CACHE_HOME: tempDir('custom-profile-boundary-cache'), BOXDOWN_DATA_HOME: tempDir('custom-profile-boundary-data') },
      platform: 'linux',
      assetsDevcontainerDir: boundaryAssetsDir
    })
    assert.ok(buildGeneratedDevcontainerConfig(boundaryContext, undefined, 'full').mounts?.some(mount => mount.includes(`target=${BOXDOWN_CONTAINER_CODEX_DIR}`) && !mount.endsWith(',readonly')))
  })

  test('string mount aliases and normalized POSIX destinations consistently control profile mounts and status', () => {
    const home = tempDir('normalized-string-profile-home')
    mkdirSync(join(home, '.agents'))
    mkdirSync(join(home, '.codex'))
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude.json'), '{}\n')

    const cases = [
      {
        name: 'target exact',
        mount: 'type=bind,source=/custom/codex,target=/home/node/.codex,readonly',
        ownsCodex: true
      },
      {
        name: 'dst normalized parent',
        mount: 'type=bind,source=/custom/home,dst=/home/node/.codex/..,readonly',
        ownsCodex: true
      },
      {
        name: 'destination child',
        mount: 'type=bind,source=/custom/cache,destination=/home/node/.codex/cache,readonly',
        ownsCodex: true
      },
      {
        name: 'target trailing slash',
        mount: 'type=bind,source=/custom/codex,target=/home/node/.codex/,readonly',
        ownsCodex: true
      },
      {
        name: 'dst double slash',
        mount: 'type=bind,source=/custom/codex,dst=/home//node/.codex,readonly',
        ownsCodex: true
      },
      {
        name: 'destination dot and dotdot',
        mount: 'type=bind,source=/custom/codex,destination=/home/node/./.codex/cache/..,readonly',
        ownsCodex: true
      },
      {
        name: 'sibling',
        mount: 'type=bind,source=/custom/codex-other,target=/home/node/.codex-other,readonly',
        ownsCodex: false
      },
      {
        name: 'unrelated',
        mount: 'type=bind,source=/custom/codex,dst=/var/lib/codex,readonly',
        ownsCodex: false
      },
      {
        name: 'relative destination',
        mount: 'type=bind,source=/custom/codex,destination=home/node/.codex,readonly',
        ownsCodex: false
      },
      {
        name: 'any valid alias fails closed',
        mount: 'type=bind,source=/custom/codex,target=/var/lib/codex,dst=/home/node/.codex,readonly',
        ownsCodex: true
      },
      {
        name: 'quoted destination field',
        mount: 'type=tmpfs,"dst=/home/node/.codex"',
        ownsCodex: true
      },
      {
        name: 'quoted fields with escaped quotes and commas',
        mount: 'type=tmpfs,"source=/tmp/source ""quoted"",with-comma","destination=/home/node/.codex/cache ""quoted"",with-comma"',
        ownsCodex: true
      },
      {
        name: 'uppercase destination alias',
        mount: 'type=bind,source=/custom/codex,DST=/home/node/.codex,readonly',
        ownsCodex: true
      },
      {
        name: 'repeated mixed-case aliases',
        mount: 'type=bind,source=/custom/codex,target=/var/lib/codex,DST=/home/node/.codex,readonly',
        ownsCodex: true
      }
    ] as const

    for (const entry of cases) {
      const assets = tempDir(`normalized-string-profile-assets-${entry.name.replaceAll(' ', '-')}`)
      writeFileSync(join(assets, 'devcontainer.json'), `${JSON.stringify({ mounts: [entry.mount] })}\n`)
      const context = createWorkspaceContext({
        workspace: tempDir(`normalized-string-profile-workspace-${entry.name.replaceAll(' ', '-')}`),
        env: {
          HOME: home,
          BOXDOWN_CACHE_HOME: tempDir(`normalized-string-profile-cache-${entry.name.replaceAll(' ', '-')}`),
          BOXDOWN_DATA_HOME: tempDir(`normalized-string-profile-data-${entry.name.replaceAll(' ', '-')}`)
        },
        platform: 'linux',
        assetsDevcontainerDir: assets
      })

      const config = buildGeneratedDevcontainerConfig(context, undefined, 'full')
      const hasCodexProfileMount = config.mounts?.some(mount =>
        typeof mount === 'string' &&
        mount.includes(`source=${context.hostCodexDir},target=${BOXDOWN_CONTAINER_CODEX_DIR}`) &&
        !mount.endsWith(',readonly')
      ) ?? false

      assert.ok(config.mounts?.includes(entry.mount), `${entry.name}: preserve original mount`)
      assert.strictEqual(
        hasCodexProfileMount,
        !entry.ownsCodex,
        `${entry.name}: custom ownership must suppress the corresponding profile mount`
      )
      assert.match(config.containerEnv?.BOXDOWN_AGENT_PROFILE_SOURCES ?? '', /(?:^|,)codex-home(?:,|$)/)

      mkdirSync(context.workspaceCacheDir, { recursive: true })
      writeFileSync(context.generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`)
      const status = createStatusInfo(context, 'normalized-string-profile', {
        id: 'normalized-string-profile-container',
        state: 'running'
      }, existsSync, {
        sshConfigPath: join(tempDir('normalized-string-profile-ssh'), 'config'),
        agentProfileSelection: resolveAgentProfile(undefined, 'full'),
        containerAgentProfile: liveFullContainerProfile
      })

      assert.strictEqual(
        status.agentProfile.sources.codexHome,
        entry.ownsCodex ? 'custom' : 'available',
        `${entry.name}: status distinguishes custom ownership from Boxdown's direct full mount`
      )
      assert.strictEqual(
        status.agentProfile.customDestinations.includes(BOXDOWN_CONTAINER_CODEX_DIR),
        entry.ownsCodex,
        `${entry.name}: only user-owned canonical destinations are custom`
      )
    }
  })

  test('indeterminate mounts suppress all profile mounts and report only canonical custom ownership', () => {
    const home = tempDir('indeterminate-profile-home')
    mkdirSync(join(home, '.agents'))
    mkdirSync(join(home, '.codex'))
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.codex', 'auth.json'), '{}\n')
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}\n')
    writeFileSync(join(home, '.claude.json'), '{}\n')

    const cases = [
      {
        name: 'malformed csv',
        mount: 'type=bind,"source=/tmp'
      },
      {
        name: 'substituted destination',
        mount: 'type=bind,source=/tmp,target=${localEnv:PROFILE_DESTINATION}'
      },
      {
        name: 'substitution generated whole field',
        mount: '${localEnv:CUSTOM_MOUNT_FIELD}'
      },
      {
        name: 'workspace substitution in a string source',
        mount: 'type=bind,source=${localWorkspaceFolder}'
      },
      {
        name: 'known gitconfig target on uncertain string',
        mount: 'type=bind,source=${localEnv:PROFILE_SOURCE},target=/home/node/.gitconfig'
      },
      {
        name: 'structured substituted destination',
        mount: {
          type: 'bind',
          source: '/custom/profile',
          destination: '${containerWorkspaceFolder}/.codex',
          arbitrary: {
            preserve: true
          }
        }
      },
      {
        name: 'structured substituted source',
        mount: {
          type: 'bind',
          source: '${localEnv:PROFILE_SOURCE}',
          target: '/var/lib/unrelated',
          arbitrary: {
            preserve: true
          }
        }
      },
      {
        name: 'structured substituted type',
        mount: {
          type: '${localEnv:MOUNT_TYPE}',
          source: '/custom/profile',
          target: '/var/lib/unrelated'
        }
      },
      {
        name: 'structured source comma injection',
        mount: {
          type: 'bind',
          source: '/custom/profile,target=/home/node/.codex',
          target: '/var/lib/unrelated',
          arbitrary: {
            preserve: true,
            serializedLooking: 'target=/home/node/.agents,${localEnv:OPAQUE}'
          }
        }
      },
      {
        name: 'structured type comma injection',
        mount: {
          type: 'bind,dst=/home/node/.codex',
          source: '/custom/profile',
          target: '/var/lib/unrelated'
        }
      },
      {
        name: 'structured destination comma injection',
        mount: {
          type: 'tmpfs',
          target: '/var/lib/unrelated,dst=/home/node/.codex'
        }
      },
      {
        name: 'structured quote control',
        mount: {
          type: 'bind"',
          source: '/custom/profile',
          target: '/var/lib/unrelated'
        }
      },
      {
        name: 'structured carriage return control',
        mount: {
          type: 'bind',
          source: '/custom/profile\r',
          target: '/var/lib/unrelated'
        }
      },
      {
        name: 'structured line feed control',
        mount: {
          type: 'bind\n',
          source: '/custom/profile',
          target: '/var/lib/unrelated'
        }
      },
      {
        name: 'structured nul control',
        mount: {
          type: 'bind',
          source: '/custom/profile',
          target: '/var/lib/unrelated\0dst=/home/node/.codex'
        }
      },
      {
        name: 'structured non-string serialized field',
        mount: {
          type: 'bind',
          source: 42,
          target: '/var/lib/unrelated',
          arbitrary: {
            preserve: true
          }
        }
      }
    ] as const

    for (const entry of cases) {
      const slug = entry.name.replaceAll(' ', '-')
      const assets = tempDir(`indeterminate-profile-assets-${slug}`)
      writeFileSync(join(assets, 'devcontainer.json'), `${JSON.stringify({ mounts: [entry.mount] })}\n`)
      const context = createWorkspaceContext({
        workspace: tempDir(`indeterminate-profile-workspace-${slug}`),
        env: {
          HOME: home,
          BOXDOWN_CACHE_HOME: tempDir(`indeterminate-profile-cache-${slug}`),
          BOXDOWN_DATA_HOME: tempDir(`indeterminate-profile-data-${slug}`)
        },
        platform: 'linux',
        assetsDevcontainerDir: assets
      })

      const config = buildGeneratedDevcontainerConfig(context, undefined, 'full')
      assert.deepStrictEqual(config.mounts?.[0], entry.mount, `${entry.name}: preserve original mount`)
      assert.deepStrictEqual(
        config.mounts?.filter(mount =>
          typeof mount === 'string' &&
          [
            BOXDOWN_CONTAINER_AGENTS_DIR,
            BOXDOWN_CONTAINER_CODEX_DIR,
            BOXDOWN_CONTAINER_CLAUDE_DIR,
            BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH
          ].some(target => mount.includes(`target=${target}`))
        ),
        [],
        `${entry.name}: uncertainty must suppress every profile source`
      )

      mkdirSync(context.workspaceCacheDir, { recursive: true })
      writeFileSync(context.generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`)
      const status = createStatusInfo(context, 'indeterminate-profile', {
        id: 'indeterminate-profile-container',
        state: 'running'
      }, existsSync, {
        sshConfigPath: join(tempDir(`indeterminate-profile-ssh-${slug}`), 'config'),
        agentProfileSelection: resolveAgentProfile(undefined, 'full'),
        containerAgentProfile: liveFullContainerProfile
      })

      assert.deepStrictEqual(status.agentProfile.sources, {
        codexAuthentication: 'custom',
        claudeAuthentication: 'custom',
        agents: 'custom',
        codexHome: 'custom',
        claudeHome: 'custom',
        claudeConfig: 'custom'
      }, `${entry.name}: every canonical source is externally managed`)
      assert.deepStrictEqual(status.agentProfile.customDestinations, [
        BOXDOWN_CONTAINER_AGENTS_DIR,
        BOXDOWN_CONTAINER_CLAUDE_DIR,
        BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH,
        BOXDOWN_CONTAINER_CODEX_DIR
      ].sort(), `${entry.name}: expose canonical top-level destinations only`)
      assert.doesNotMatch(
        JSON.stringify(status),
        /\$\{|localEnv|localWorkspaceFolder|containerWorkspaceFolder/,
        `${entry.name}: status must not disclose substitution expressions`
      )
    }
  })

  test('structured mounts are preserved unchanged and use normalized dst ownership in generation and status', () => {
    const home = tempDir('structured-profile-home')
    mkdirSync(join(home, '.agents'))
    mkdirSync(join(home, '.codex'))
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude.json'), '{}\n')

    const cases: Array<{
      name: string
      dst: string
      ownsCodex: boolean
      aliases?: Record<string, string>
    }> = [
      { name: 'exact', dst: '/home//node/.codex/', ownsCodex: true },
      { name: 'parent', dst: '/home/node/.codex/..', ownsCodex: true },
      { name: 'child', dst: '/home/node/.codex/./cache', ownsCodex: true },
      { name: 'sibling', dst: '/home/node/.codex-other', ownsCodex: false },
      { name: 'unrelated', dst: '/var/lib/codex', ownsCodex: false },
      {
        name: 'repeated-case-alias',
        dst: '/var/lib/codex',
        ownsCodex: true,
        aliases: {
          DST: BOXDOWN_CONTAINER_CODEX_DIR
        }
      }
    ]

    for (const entry of cases) {
      const mount = {
        type: 'bind',
        src: `/custom/${entry.name}`,
        dst: entry.dst,
        ...entry.aliases,
        consistency: 'cached',
        arbitrary: {
          keep: true,
          labels: ['opaque', entry.name],
          serializedLooking: 'target=/home/node/.codex,${localEnv:OPAQUE}'
        }
      }
      const assets = tempDir(`structured-profile-assets-${entry.name}`)
      writeFileSync(join(assets, 'devcontainer.json'), `${JSON.stringify({ mounts: [mount] })}\n`)
      const context = createWorkspaceContext({
        workspace: tempDir(`structured-profile-workspace-${entry.name}`),
        env: {
          HOME: home,
          BOXDOWN_CACHE_HOME: tempDir(`structured-profile-cache-${entry.name}`),
          BOXDOWN_DATA_HOME: tempDir(`structured-profile-data-${entry.name}`)
        },
        platform: 'linux',
        assetsDevcontainerDir: assets
      })

      const config = buildGeneratedDevcontainerConfig(context, undefined, 'full')
      const hasCodexProfileMount = config.mounts?.some(candidate =>
        typeof candidate === 'string' &&
        candidate.includes(`source=${context.hostCodexDir},target=${BOXDOWN_CONTAINER_CODEX_DIR}`) &&
        !candidate.endsWith(',readonly')
      ) ?? false

      assert.deepStrictEqual(config.mounts?.[0], mount, `${entry.name}: preserve every structured field`)
      assert.strictEqual(hasCodexProfileMount, !entry.ownsCodex, `${entry.name}: profile mount decision`)

      mkdirSync(context.workspaceCacheDir, { recursive: true })
      writeFileSync(context.generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`)
      const status = createStatusInfo(context, 'structured-profile', {
        id: 'structured-profile-container',
        state: 'running'
      }, existsSync, {
        sshConfigPath: join(tempDir('structured-profile-ssh'), 'config'),
        agentProfileSelection: resolveAgentProfile(undefined, 'full'),
        containerAgentProfile: liveFullContainerProfile
      })

      assert.strictEqual(
        status.agentProfile.sources.codexHome,
        entry.ownsCodex ? 'custom' : 'available',
        `${entry.name}: status distinguishes custom ownership from Boxdown's direct full mount`
      )
      assert.strictEqual(
        status.agentProfile.customDestinations.includes(BOXDOWN_CONTAINER_CODEX_DIR),
        entry.ownsCodex,
        `${entry.name}: only user-owned canonical destinations are custom`
      )
    }
  })

  test('read-only matching full mounts remain custom in status', () => {
    const home = tempDir('read-only-full-profile-home')
    mkdirSync(join(home, '.codex'))

    const cases = [
      {
        name: 'string readonly',
        mount: (context: ReturnType<typeof createWorkspaceContext>) =>
          `type=bind,source=${context.hostCodexDir},target=${BOXDOWN_CONTAINER_CODEX_DIR},readonly`
      },
      {
        name: 'string ro alias',
        mount: (context: ReturnType<typeof createWorkspaceContext>) =>
          `type=bind,source=${context.hostCodexDir},target=${BOXDOWN_CONTAINER_CODEX_DIR},ro`
      },
      {
        name: 'structured readOnly',
        mount: (context: ReturnType<typeof createWorkspaceContext>) => ({
          type: 'bind',
          source: context.hostCodexDir,
          target: BOXDOWN_CONTAINER_CODEX_DIR,
          readOnly: true
        })
      }
    ] as const

    for (const entry of cases) {
      const assets = tempDir(`read-only-full-profile-assets-${entry.name.replaceAll(' ', '-')}`)
      const context = createWorkspaceContext({
        workspace: tempDir(`read-only-full-profile-workspace-${entry.name.replaceAll(' ', '-')}`),
        env: {
          HOME: home,
          BOXDOWN_CACHE_HOME: tempDir(`read-only-full-profile-cache-${entry.name.replaceAll(' ', '-')}`),
          BOXDOWN_DATA_HOME: tempDir(`read-only-full-profile-data-${entry.name.replaceAll(' ', '-')}`)
        },
        platform: 'linux',
        assetsDevcontainerDir: assets
      })
      const mount = entry.mount(context)
      writeFileSync(join(assets, 'devcontainer.json'), `${JSON.stringify({ mounts: [mount] })}\n`)
      const config = buildGeneratedDevcontainerConfig(context, undefined, 'full')
      mkdirSync(context.workspaceCacheDir, { recursive: true })
      writeFileSync(context.generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`)

      const status = createStatusInfo(context, 'read-only-full-profile', {
        id: 'read-only-full-profile-container',
        state: 'running'
      }, existsSync, {
        sshConfigPath: join(tempDir(`read-only-full-profile-ssh-${entry.name.replaceAll(' ', '-')}`), 'config'),
        agentProfileSelection: resolveAgentProfile(undefined, 'full'),
        containerAgentProfile: liveFullContainerProfile
      })

      assert.strictEqual(status.agentProfile.sources.codexHome, 'custom', `${entry.name}: read-only mount is user-owned`)
      assert.ok(status.agentProfile.customDestinations.includes(BOXDOWN_CONTAINER_CODEX_DIR), `${entry.name}: report custom destination`)
    }
  })

  test('read-write matching user full mounts remain custom without Boxdown provenance', () => {
    const home = tempDir('matching-user-full-profile-home')
    mkdirSync(join(home, '.codex'))
    const assets = tempDir('matching-user-full-profile-assets')
    const context = createWorkspaceContext({
      workspace: tempDir('matching-user-full-profile-workspace'),
      env: {
        HOME: home,
        BOXDOWN_CACHE_HOME: tempDir('matching-user-full-profile-cache'),
        BOXDOWN_DATA_HOME: tempDir('matching-user-full-profile-data')
      },
      platform: 'linux',
      assetsDevcontainerDir: assets
    })
    const userMount = `type=bind,source=${context.hostCodexDir},target=${BOXDOWN_CONTAINER_CODEX_DIR}`
    writeFileSync(join(assets, 'devcontainer.json'), `${JSON.stringify({ mounts: [userMount] })}\n`)

    const config = buildGeneratedDevcontainerConfig(context, undefined, 'full')
    assert.ok(config.mounts?.includes(userMount))
    assert.doesNotMatch(config.containerEnv?.BOXDOWN_AGENT_PROFILE_MANAGED_SOURCES ?? '', /(?:^|,)codex-home(?:,|$)/)
    mkdirSync(context.workspaceCacheDir, { recursive: true })
    writeFileSync(context.generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`)

    const status = createStatusInfo(context, 'matching-user-full-profile', {
      id: 'matching-user-full-profile-container',
      state: 'running'
    }, existsSync, {
      sshConfigPath: join(tempDir('matching-user-full-profile-ssh'), 'config'),
      agentProfileSelection: resolveAgentProfile(undefined, 'full'),
      containerAgentProfile: liveFullContainerProfile
    })

    assert.strictEqual(status.agentProfile.sources.codexHome, 'custom')
    assert.ok(status.agentProfile.customDestinations.includes(BOXDOWN_CONTAINER_CODEX_DIR))
  })

  test('parses JSONC without stripping URLs inside strings', () => {
    const parsed = parseJsonc<{ url: string }>('{ "url": "https://example.com/path" // keep string URL\n }')
    assert.strictEqual(parsed.url, 'https://example.com/path')
  })
})

describe('docker image inspection', () => {
  test('parses the narrow image-only Docker inspect projection', () => {
    assert.deepStrictEqual(parseDockerInspectImage('"sha256:abc"|"node:24"\n', 'container-1'), {
      id: 'sha256:abc',
      name: 'node:24'
    })
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

  test('classifies the default GPG signing preference without probing the SSH agent', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('git-signing-gpg-preference-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('git-signing-gpg-preference-cache'),
        BOXDOWN_DATA_HOME: tempDir('git-signing-gpg-preference-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []

    const plan = await resolveGitSigningPlan(context, {
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'git' && args.includes('gpg.format')) return { code: 1, stdout: '', stderr: '' }
        if (command === 'git' && args.includes('gpg.program')) return { code: 1, stdout: '', stderr: '' }
        if (command === 'git' && args.includes('user.signingkey')) return { code: 0, stdout: '0123456789ABCDEF\n', stderr: '' }
        if (command === 'git' && args.includes('commit.gpgsign')) return { code: 0, stdout: 'true\n', stderr: '' }
        if (command === 'ssh-add') return { code: 1, stdout: '', stderr: 'agent unavailable\n' }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
      }
    })

    assert.deepStrictEqual(plan, {
      enabled: false,
      reason: 'gpg-signing-unavailable'
    })
    assert.ok(!calls.some((call) => call.startsWith('ssh-add ')))
  })

  test('classifies a repository-local GPG signing preference without probing the SSH agent', async () => {
    const workspace = tempDir('git-signing-local-gpg-preference-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('git-signing-local-gpg-preference-cache'),
        BOXDOWN_DATA_HOME: tempDir('git-signing-local-gpg-preference-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []

    const plan = await resolveGitSigningPlan(context, {
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'git' && args.includes('--local') && args.includes('gpg.format')) return { code: 0, stdout: 'openpgp\n', stderr: '' }
        if (command === 'ssh-add') return { code: 1, stdout: '', stderr: 'agent unavailable\n' }
        return { code: 1, stdout: '', stderr: '' }
      }
    })

    assert.deepStrictEqual(plan, {
      enabled: false,
      reason: 'gpg-signing-unavailable'
    })
    assert.ok(!calls.some((call) => call.startsWith('ssh-add ')))
  })

  test('classifies a GPG signing preference enabled by a Git boolean alias without probing the SSH agent', async () => {
    const workspace = tempDir('git-signing-gpg-boolean-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('git-signing-gpg-boolean-cache'),
        BOXDOWN_DATA_HOME: tempDir('git-signing-gpg-boolean-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []

    const plan = await resolveGitSigningPlan(context, {
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'git' && args.includes('commit.gpgsign')) return { code: 0, stdout: 'yes\n', stderr: '' }
        if (command === 'ssh-add') return { code: 1, stdout: '', stderr: 'agent unavailable\n' }
        return { code: 1, stdout: '', stderr: '' }
      }
    })

    assert.deepStrictEqual(plan, {
      enabled: false,
      reason: 'gpg-signing-unavailable'
    })
    assert.ok(!calls.some((call) => call.startsWith('ssh-add ')))
  })

  test('classifies an explicit GPG program without probing the SSH agent', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('git-signing-gpg-program-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('git-signing-gpg-program-cache'),
        BOXDOWN_DATA_HOME: tempDir('git-signing-gpg-program-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []
    const plan = await resolveGitSigningPlan(context, {
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'git' && args.includes('gpg.program')) {
          return { code: 0, stdout: 'gpg2\n', stderr: '' }
        }
        if (command === 'ssh-add') throw new Error('SSH agent must not be queried')
        return { code: 1, stdout: '', stderr: '' }
      }
    })
    assert.deepStrictEqual(plan, { enabled: false, reason: 'gpg-signing-unavailable' })
    assert.ok(!calls.some((call) => call.startsWith('ssh-add ')))
  })

  test('uses SSH format before a legacy GPG program', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('git-signing-ssh-format-legacy-gpg-program-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('git-signing-ssh-format-legacy-gpg-program-cache'),
        BOXDOWN_DATA_HOME: tempDir('git-signing-ssh-format-legacy-gpg-program-data')
      },
      assetsDevcontainerDir
    })
    const calls: string[] = []

    const plan = await resolveGitSigningPlan(context, {
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        if (command === 'git' && args.includes('gpg.format')) return { code: 0, stdout: 'ssh\n', stderr: '' }
        if (command === 'git' && args.includes('gpg.program')) return { code: 0, stdout: 'gpg2\n', stderr: '' }
        if (command === 'ssh-add') return { code: 1, stdout: '', stderr: 'agent unavailable\n' }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
      }
    })

    assert.deepStrictEqual({ enabled: plan.enabled, reason: plan.reason }, {
      enabled: false,
      reason: 'agent-unavailable'
    })
    assert.ok(calls.some((call) => call.startsWith('ssh-add ')))
  })

  test('keeps a non-GPG X.509 preference generic', async () => {
    const context = createWorkspaceContext({
      workspace: tempDir('git-signing-x509-preference-workspace'),
      env: {
        BOXDOWN_CACHE_HOME: tempDir('git-signing-x509-preference-cache'),
        BOXDOWN_DATA_HOME: tempDir('git-signing-x509-preference-data')
      },
      assetsDevcontainerDir
    })
    const plan = await resolveGitSigningPlan(context, {
      runCommand: async (command, args) => {
        if (command === 'git' && args.includes('gpg.format')) {
          return { code: 0, stdout: 'x509\n', stderr: '' }
        }
        if (command === 'ssh-add') throw new Error('SSH agent must not be queried')
        return { code: 1, stdout: '', stderr: '' }
      }
    })
    assert.deepStrictEqual(plan, { enabled: false, reason: 'user-signing-preference' })
  })

  test('reports an explicit signing preference without claiming commits are unsigned', () => {
    const workspace = tempDir('git-signing-preference-report-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('git-signing-preference-report-cache'),
        BOXDOWN_DATA_HOME: tempDir('git-signing-preference-report-data')
      },
      assetsDevcontainerDir
    })
    const messages: string[] = []

    reportGitSigningPlan({ enabled: false, reason: 'user-signing-preference' }, {
      logger: createWorkspaceCommandLogger(context),
      writeWarning: (message) => messages.push(message)
    })

    assert.deepStrictEqual(messages, [
      'boxdown: preserving your existing Git signing configuration; Boxdown SSH signing is skipped.\n'
    ])
    assert.match(readFileSync(context.workspaceLogPath, 'utf8'), /reason=user-signing-preference/)
  })

  test('reports unavailable GPG signing without changing the preference', () => {
    const workspace = tempDir('git-signing-gpg-report-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('git-signing-gpg-report-cache'),
        BOXDOWN_DATA_HOME: tempDir('git-signing-gpg-report-data')
      },
      assetsDevcontainerDir
    })
    const messages: string[] = []
    const logger = createWorkspaceCommandLogger(context)
    reportGitSigningPlan({ enabled: false, reason: 'gpg-signing-unavailable' }, {
      logger,
      writeWarning: (message) => messages.push(message)
    })
    assert.deepStrictEqual(messages, [
      'boxdown: GPG commit signing is configured, but the default Boxdown image does not provide GnuPG or GPG-agent forwarding; commits in this container may fail to sign.\n'
    ])
    assert.match(readFileSync(context.workspaceLogPath, 'utf8'), /reason=gpg-signing-unavailable/)
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
        if (command === 'git' && args.includes('gpg.program')) return { code: 1, stdout: '', stderr: '' }
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
        if (command === 'git' && args.includes('gpg.program')) return { code: 1, stdout: '', stderr: '' }
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

describe('SSH-agent proxy asset', () => {
  test('forwards node SSH-agent connections', async () => {
    const root = mkdtempSync('/tmp/boxdown-ssh-agent-proxy-')
    const sourcePath = join(root, 'source.sock')
    const targetPath = join(root, 'target.sock')
    const proxyPath = join(assetsDevcontainerDir, 'utils', 'ssh-agent-proxy.mjs')
    const sourceServer = createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk))
    })
    sourceServer.listen(sourcePath)
    await once(sourceServer, 'listening')
    const proxy = spawn(process.execPath, [proxyPath, '--source', sourcePath, '--target', targetPath, '--uid', String(process.getuid?.() ?? 0), '--gid', String(process.getgid?.() ?? 0)])

    try {
      for (let attempt = 0; attempt < 20 && !existsSync(targetPath); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.strictEqual(existsSync(targetPath), true)

      const client = createConnection(targetPath)
      await once(client, 'connect')
      client.write('agent-request')
      const [response] = await once(client, 'data')
      assert.strictEqual(response.toString(), 'agent-request')
      client.destroy()
    } finally {
      proxy.kill()
      sourceServer.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('devcontainer git config hooks', () => {
  test('initialization scopes ANTHROPIC_API_KEY by agent profile without changing unrelated runtime secrets', () => {
    const initializePath = join(assetsDevcontainerDir, 'hooks', 'initialize.sh')
    const binDir = join(tempDir('agent-profile-initialize-bin'), 'bin')
    const baseEnv = { ...process.env }
    delete baseEnv.ANTHROPIC_API_KEY
    delete baseEnv.SNYK_TOKEN
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'op'), '#!/usr/bin/env bash\nexit 1\n')
    chmodSync(join(binDir, 'op'), 0o755)

    for (const { profile, hasAnthropicKey } of [
      { profile: 'none', hasAnthropicKey: false },
      { profile: 'auth', hasAnthropicKey: true },
      { profile: 'full', hasAnthropicKey: true }
    ]) {
      const secretDir = join(tempDir(`agent-profile-${profile}-state`), 'secrets')
      mkdirSync(secretDir)
      writeFileSync(join(secretDir, 'ANTHROPIC_API_KEY'), 'stale-anthropic-runtime-sentinel')
      writeFileSync(join(secretDir, 'SNYK_TOKEN'), 'stale-snyk-runtime-sentinel')
      writeFileSync(join(secretDir, 'OP_SERVICE_ACCOUNT_TOKEN'), 'stale-op-runtime-sentinel')

      execFileSync('bash', [initializePath], {
        env: {
          ...baseEnv,
          PATH: `${binDir}${delimiter}${baseEnv.PATH ?? ''}`,
          BOXDOWN_SECRET_ENV_DIR: secretDir,
          BOXDOWN_AGENT_PROFILE: profile,
          ANTHROPIC_API_KEY: 'anthropic-runtime-sentinel',
          SNYK_TOKEN: 'snyk-runtime-sentinel'
        }
      })

      assert.strictEqual(existsSync(join(secretDir, 'ANTHROPIC_API_KEY')), hasAnthropicKey)
      if (hasAnthropicKey) {
        assert.strictEqual(readFileSync(join(secretDir, 'ANTHROPIC_API_KEY'), 'utf8'), 'anthropic-runtime-sentinel')
      }
      assert.strictEqual(readFileSync(join(secretDir, 'SNYK_TOKEN'), 'utf8'), 'snyk-runtime-sentinel')
      assert.strictEqual(existsSync(join(secretDir, 'OP_SERVICE_ACCOUNT_TOKEN')), false)
    }

    const defaultProfileSecretDir = join(tempDir('agent-profile-default-state'), 'secrets')
    execFileSync('bash', [initializePath], {
      env: {
        ...baseEnv,
        PATH: `${binDir}${delimiter}${baseEnv.PATH ?? ''}`,
        BOXDOWN_SECRET_ENV_DIR: defaultProfileSecretDir,
        ANTHROPIC_API_KEY: 'anthropic-runtime-sentinel'
      }
    })
    assert.strictEqual(
      readFileSync(join(defaultProfileSecretDir, 'ANTHROPIC_API_KEY'), 'utf8'),
      'anthropic-runtime-sentinel'
    )

    const staleSecretDir = join(tempDir('agent-profile-stale-state'), 'secrets')
    execFileSync('bash', [initializePath], {
      env: {
        ...baseEnv,
        PATH: `${binDir}${delimiter}${baseEnv.PATH ?? ''}`,
        BOXDOWN_SECRET_ENV_DIR: staleSecretDir,
        BOXDOWN_AGENT_PROFILE: 'auth',
        ANTHROPIC_API_KEY: 'anthropic-runtime-sentinel'
      }
    })
    assert.strictEqual(readFileSync(join(staleSecretDir, 'ANTHROPIC_API_KEY'), 'utf8'), 'anthropic-runtime-sentinel')

    execFileSync('bash', [initializePath], {
      env: {
        ...baseEnv,
        PATH: `${binDir}${delimiter}${baseEnv.PATH ?? ''}`,
        BOXDOWN_SECRET_ENV_DIR: staleSecretDir,
        BOXDOWN_AGENT_PROFILE: 'none'
      }
    })
    assert.strictEqual(existsSync(join(staleSecretDir, 'ANTHROPIC_API_KEY')), false)
  })

  test('initialization writes private runtime secrets without changing project environment files', () => {
    const initializePath = join(assetsDevcontainerDir, 'hooks', 'initialize.sh')
    const workspace = tempDir('runtime-secret-initialize-workspace')
    const secretDir = join(tempDir('runtime-secret-initialize-state'), 'secrets')
    const projectEnv = join(workspace, '.env.development')
    const binDir = join(tempDir('runtime-secret-initialize-bin'), 'bin')
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'op'), '#!/usr/bin/env bash\nexit 1\n')
    chmodSync(join(binDir, 'op'), 0o755)
    writeFileSync(projectEnv, 'PROJECT_VALUE=unchanged\n')

    execFileSync('bash', [initializePath], {
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        BOXDOWN_WORKSPACE_FOLDER: workspace,
        BOXDOWN_SECRET_ENV_DIR: secretDir,
        ANTHROPIC_API_KEY: 'anthropic-runtime-sentinel',
        SNYK_TOKEN: 'snyk-runtime-sentinel'
      }
    })

    assert.strictEqual(readFileSync(projectEnv, 'utf8'), 'PROJECT_VALUE=unchanged\n')
    assert.strictEqual(readFileSync(join(secretDir, 'ANTHROPIC_API_KEY'), 'utf8'), 'anthropic-runtime-sentinel')
    assert.strictEqual(readFileSync(join(secretDir, 'SNYK_TOKEN'), 'utf8'), 'snyk-runtime-sentinel')
    assert.strictEqual(existsSync(join(secretDir, 'OP_SERVICE_ACCOUNT_TOKEN')), false)
    assert.strictEqual(statSync(secretDir).mode & 0o777, 0o700)
    assert.strictEqual(statSync(join(secretDir, 'ANTHROPIC_API_KEY')).mode & 0o777, 0o600)

    execFileSync('bash', [initializePath], {
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        BOXDOWN_WORKSPACE_FOLDER: workspace,
        BOXDOWN_SECRET_ENV_DIR: secretDir
      }
    })

    assert.strictEqual(existsSync(join(secretDir, 'ANTHROPIC_API_KEY')), false)
    assert.strictEqual(existsSync(join(secretDir, 'SNYK_TOKEN')), false)
    assert.strictEqual(readFileSync(projectEnv, 'utf8'), 'PROJECT_VALUE=unchanged\n')
  })

  test('initialization boots or reuses a varlock proxy session for schema workspaces and writes placeholder wiring', () => {
    const initializePath = join(assetsDevcontainerDir, 'hooks', 'initialize.sh')
    const binDir = join(tempDir('varlock-initialize-bin'), 'bin')
    const workspace = tempDir('varlock-initialize-workspace')
    const hostCaDir = tempDir('varlock-initialize-host-ca')
    const stateDir = tempDir('varlock-initialize-stub-state')
    const secretDir = join(tempDir('varlock-initialize-state'), 'secrets')
    const argsLog = join(tempDir('varlock-initialize-log'), 'args.log')
    mkdirSync(binDir)
    mkdirSync(secretDir, { recursive: true })
    writeFileSync(join(workspace, '.env.schema'), '# @sensitive\nDEMO_TOKEN=\n')
    writeFileSync(join(hostCaDir, 'ca-cert.pem'), 'proxy-ca-sentinel')
    writeFileSync(join(hostCaDir, 'combined-ca.pem'), 'combined-ca-sentinel')
    writeFileSync(join(binDir, 'op'), '#!/usr/bin/env bash\nexit 1\n')
    chmodSync(join(binDir, 'op'), 0o755)
    writeFileSync(join(binDir, 'varlock'), [
      '#!/usr/bin/env bash',
      'printf \'%s\\n\' "$*" >> "${VARLOCK_STUB_ARGS_LOG}"',
      '[[ "${VARLOCK_STUB_MODE:-ok}" == "fail" ]] && exit 1',
      'if [[ "$1" == "proxy" && "$2" == "status" ]]; then',
      '  if [[ -f "${VARLOCK_STUB_STATE_DIR}/started" ]]; then',
      '    printf \'[{"id":"stub-session","cwd":"%s"}]\\n\' "${VARLOCK_STUB_WORKSPACE}"',
      '  else',
      '    printf \'[]\\n\'',
      '  fi',
      'elif [[ "$1" == "proxy" && "$2" == "start" ]]; then',
      '  touch "${VARLOCK_STUB_STATE_DIR}/started"',
      'elif [[ "$*" == *"--proxy-url"* ]]; then',
      '  guest_url=""; cert_dir=""; previous=""',
      '  for argument in "$@"; do',
      '    [[ "${previous}" == "--proxy-url" ]] && guest_url="${argument}"',
      '    [[ "${previous}" == "--cert-dir" ]] && cert_dir="${argument}"',
      '    previous="${argument}"',
      '  done',
      '  printf "export HTTPS_PROXY=\'%s\'\\n" "${guest_url}"',
      '  printf "export SSL_CERT_FILE=\'%s/combined-ca.pem\'\\n" "${cert_dir}"',
      '  printf "export DEMO_TOKEN=\'DEMO-PLACEHOLDER\'\\n"',
      'else',
      '  printf "export HTTPS_PROXY=\'http://127.0.0.1:59999\'\\n"',
      '  printf "export SSL_CERT_FILE=\'%s/combined-ca.pem\'\\n" "${VARLOCK_STUB_CA_DIR}"',
      'fi',
      ''
    ].join('\n'))
    chmodSync(join(binDir, 'varlock'), 0o755)
    writeFileSync(join(secretDir, 'ANTHROPIC_API_KEY'), 'stale-anthropic-runtime-sentinel')

    const baseEnv = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      BOXDOWN_WORKSPACE_FOLDER: workspace,
      BOXDOWN_SECRET_ENV_DIR: secretDir,
      VARLOCK_STUB_ARGS_LOG: argsLog,
      VARLOCK_STUB_CA_DIR: hostCaDir,
      VARLOCK_STUB_STATE_DIR: stateDir,
      VARLOCK_STUB_WORKSPACE: workspace,
      ANTHROPIC_API_KEY: 'anthropic-runtime-sentinel'
    }

    // no session running: initialization boots one, then wires the container
    execFileSync('bash', [initializePath], { env: baseEnv })

    const guestEnv = readFileSync(join(secretDir, 'varlock.env'), 'utf8')
    assert.match(guestEnv, /HTTPS_PROXY='http:\/\/host\.docker\.internal:59999'/)
    assert.match(guestEnv, /SSL_CERT_FILE='\/run\/boxdown\/secrets\/varlock-ca\/combined-ca\.pem'/)
    assert.match(guestEnv, /DEMO_TOKEN='DEMO-PLACEHOLDER'/)
    assert.strictEqual(statSync(join(secretDir, 'varlock.env')).mode & 0o777, 0o600)
    assert.strictEqual(readFileSync(join(secretDir, 'varlock-ca', 'ca-cert.pem'), 'utf8'), 'proxy-ca-sentinel')
    assert.strictEqual(readFileSync(join(secretDir, 'varlock-ca', 'combined-ca.pem'), 'utf8'), 'combined-ca-sentinel')
    assert.strictEqual(existsSync(join(secretDir, 'ANTHROPIC_API_KEY')), false)
    assert.match(readFileSync(argsLog, 'utf8'), /^proxy start$/m)
    assert.match(readFileSync(argsLog, 'utf8'), /--session stub-session/)

    // session now registered: a re-run reuses it instead of starting another
    rmSync(argsLog)
    execFileSync('bash', [initializePath], { env: baseEnv })
    assert.doesNotMatch(readFileSync(argsLog, 'utf8'), /^proxy start$/m)
    assert.match(readFileSync(argsLog, 'utf8'), /--session stub-session/)

    // a workspace-local node_modules/.bin/varlock is preferred over PATH
    rmSync(argsLog)
    const localBinDir = join(workspace, 'node_modules', '.bin')
    mkdirSync(localBinDir, { recursive: true })
    writeFileSync(
      join(localBinDir, 'varlock'),
      readFileSync(join(binDir, 'varlock'), 'utf8').replace("printf '%s\\n'", "printf 'local %s\\n'")
    )
    chmodSync(join(localBinDir, 'varlock'), 0o755)
    execFileSync('bash', [initializePath], { env: baseEnv })
    assert.match(readFileSync(argsLog, 'utf8'), /^local proxy status/m)
    assert.doesNotMatch(readFileSync(argsLog, 'utf8'), /^proxy status/m)
    rmSync(join(workspace, 'node_modules'), { recursive: true, force: true })

    // explicit session selection bypasses workspace lookup
    rmSync(argsLog)
    execFileSync('bash', [initializePath], {
      env: { ...baseEnv, BOXDOWN_VARLOCK_PROXY_SESSION: 'explicit-session' }
    })
    assert.match(readFileSync(argsLog, 'utf8'), /--session explicit-session/)

    // a workspace without .env.schema keeps the plaintext secret-file behavior
    const plainWorkspace = tempDir('varlock-initialize-plain-workspace')
    execFileSync('bash', [initializePath], {
      env: { ...baseEnv, BOXDOWN_WORKSPACE_FOLDER: plainWorkspace }
    })
    assert.strictEqual(existsSync(join(secretDir, 'varlock.env')), false)
    assert.strictEqual(existsSync(join(secretDir, 'varlock-ca')), false)
    assert.strictEqual(readFileSync(join(secretDir, 'ANTHROPIC_API_KEY'), 'utf8'), 'anthropic-runtime-sentinel')

    // a failing varlock CLI falls back non-blocking after the boot timeout
    rmSync(join(stateDir, 'started'))
    execFileSync('bash', [initializePath], {
      env: { ...baseEnv, VARLOCK_STUB_MODE: 'fail', BOXDOWN_VARLOCK_BOOT_TIMEOUT_SECONDS: '1' }
    })
    assert.strictEqual(existsSync(join(secretDir, 'varlock.env')), false)
    assert.strictEqual(readFileSync(join(secretDir, 'ANTHROPIC_API_KEY'), 'utf8'), 'anthropic-runtime-sentinel')

    // BOXDOWN_VARLOCK=0 disables detection entirely
    execFileSync('bash', [initializePath], {
      env: { ...baseEnv, BOXDOWN_VARLOCK: '0' }
    })
    assert.strictEqual(existsSync(join(secretDir, 'varlock.env')), false)
    assert.strictEqual(readFileSync(join(secretDir, 'ANTHROPIC_API_KEY'), 'utf8'), 'anthropic-runtime-sentinel')
  })

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

  test('git signing bootstrap preserves an explicit user signing configuration without an agent', () => {
    const bootstrapPath = join(assetsDevcontainerDir, 'utils', 'git-signing-bootstrap.sh')
    const targetPath = join(tempDir('git-signing-target'), '.gitconfig')
    writeFileSync(targetPath, '[gpg]\n\tprogram = /opt/homebrew/bin/gpg\n[commit]\n\tgpgsign = true\n')

    execFileSync('bash', [bootstrapPath], {
      env: { ...process.env, BOXDOWN_GITCONFIG_TARGET_PATH: targetPath, BOXDOWN_GIT_SIGNING_ENABLED: '0' }
    })

    assert.strictEqual(readGitConfig(targetPath, 'commit.gpgsign'), 'true')
    assert.strictEqual(readGitConfig(targetPath, 'gpg.program'), '/opt/homebrew/bin/gpg')
  })

  test('git signing bootstrap preserves the default GPG signing configuration without an agent', () => {
    const bootstrapPath = join(assetsDevcontainerDir, 'utils', 'git-signing-bootstrap.sh')
    const targetPath = join(tempDir('git-signing-default-gpg-target'), '.gitconfig')
    writeFileSync(targetPath, '[user]\n\tsigningkey = 0123456789ABCDEF\n[commit]\n\tgpgsign = true\n')

    execFileSync('bash', [bootstrapPath], {
      env: { ...process.env, BOXDOWN_GITCONFIG_TARGET_PATH: targetPath, BOXDOWN_GIT_SIGNING_ENABLED: '0' }
    })

    assert.strictEqual(readGitConfig(targetPath, 'user.signingkey'), '0123456789ABCDEF')
    assert.strictEqual(readGitConfig(targetPath, 'commit.gpgsign'), 'true')
  })

  test('git signing bootstrap preserves a Git boolean alias for default GPG signing', () => {
    const bootstrapPath = join(assetsDevcontainerDir, 'utils', 'git-signing-bootstrap.sh')
    const targetPath = join(tempDir('git-signing-default-gpg-boolean-target'), '.gitconfig')
    writeFileSync(targetPath, '[commit]\n\tgpgsign = yes\n')

    execFileSync('bash', [bootstrapPath], {
      env: { ...process.env, BOXDOWN_GITCONFIG_TARGET_PATH: targetPath, BOXDOWN_GIT_SIGNING_ENABLED: '0' }
    })

    assert.strictEqual(readGitConfig(targetPath, 'commit.gpgsign'), 'yes')
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
        BOXDOWN_GITCONFIG_TARGET_PATH: join(testRoot, 'unavailable.gitconfig'),
        BOXDOWN_GIT_SIGNING_ENABLED: '1',
        BOXDOWN_GIT_SIGNING_KEY_PATH: keyPath
      }
    })
    assert.strictEqual(unavailableAgent.status, 0)
    assert.match(unavailableAgent.stderr, /reason: container-agent-proxy-unavailable/)

    writeFileSync(sshAddPath, '#!/usr/bin/env bash\nprintf "%s\\n" "ssh-ed25519 AAAAC3NzaDifferentKey other"\n')
    chmodSync(sshAddPath, 0o755)
    const unloadedKey = spawnSync('bash', [bootstrapPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        BOXDOWN_GITCONFIG_TARGET_PATH: join(testRoot, 'unloaded.gitconfig'),
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
  test('loads available runtime secrets without outputting their values', () => {
    const bootstrapPath = join(assetsDevcontainerDir, 'utils', 'secret-env-bootstrap.sh')
    const secretDir = tempDir('runtime-secret-bootstrap')
    writeFileSync(join(secretDir, 'ANTHROPIC_API_KEY'), 'anthropic-bootstrap-sentinel')
    writeFileSync(join(secretDir, 'SNYK_TOKEN'), 'snyk-bootstrap-sentinel')
    const result = spawnSync('bash', [
      '-c',
      'source "$1"; [[ "${ANTHROPIC_API_KEY:-}" == "anthropic-bootstrap-sentinel" ]] && echo anthropic:yes; [[ "${SNYK_TOKEN:-}" == "snyk-bootstrap-sentinel" ]] && echo snyk:yes; [[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]] && echo op:no',
      'bash',
      bootstrapPath
    ], {
      encoding: 'utf8',
      env: { ...process.env, BOXDOWN_SECRET_ENV_DIR: secretDir }
    })

    assert.strictEqual(result.status, 0)
    assert.match(result.stdout, /^anthropic:yes$/m)
    assert.match(result.stdout, /^snyk:yes$/m)
    assert.match(result.stdout, /^op:no$/m)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /bootstrap-sentinel/)
  })

  test('sources varlock proxy wiring when present without outputting values', () => {
    const bootstrapEnvWithoutSecrets = () => {
      const env = { ...process.env }
      delete env.ANTHROPIC_API_KEY
      delete env.DEMO_TOKEN
      delete env.HTTPS_PROXY
      return env
    }
    const bootstrapPath = join(assetsDevcontainerDir, 'utils', 'secret-env-bootstrap.sh')
    const secretDir = tempDir('varlock-bootstrap')
    writeFileSync(join(secretDir, 'varlock.env'), [
      "export DEMO_TOKEN='DEMO-PLACEHOLDER'",
      "export HTTPS_PROXY='http://host.docker.internal:59999'",
      ''
    ].join('\n'))
    const result = spawnSync('bash', [
      '-c',
      'source "$1"; [[ "${DEMO_TOKEN:-}" == "DEMO-PLACEHOLDER" ]] && echo demo:yes; [[ "${HTTPS_PROXY:-}" == "http://host.docker.internal:59999" ]] && echo proxy:yes; [[ -z "${ANTHROPIC_API_KEY:-}" ]] && echo anthropic:no',
      'bash',
      bootstrapPath
    ], {
      encoding: 'utf8',
      env: { ...bootstrapEnvWithoutSecrets(), BOXDOWN_SECRET_ENV_DIR: secretDir }
    })

    assert.strictEqual(result.status, 0)
    assert.match(result.stdout, /^demo:yes$/m)
    assert.match(result.stdout, /^proxy:yes$/m)
    assert.match(result.stdout, /^anthropic:no$/m)
  })

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

  test('uses the Claude-specific TTY normalization default when requested', () => {
    assert.deepStrictEqual(interactiveShellEnvArgs({ TERM: 'xterm-256color' }, {
      defaultTtyNormalization: '0'
    }), [
      'TERM=xterm-256color',
      'COLORTERM=truecolor',
      'BOXDOWN_TTY_NORMALIZE=0',
      `BOXDOWN_TTY_MAX_COLUMNS=${DEFAULT_TTY_MAX_COLUMNS}`
    ])
  })

  test('allows an explicit TTY normalization setting to override the Claude default', () => {
    assert.deepStrictEqual(interactiveShellEnvArgs({
      TERM: 'xterm-256color',
      BOXDOWN_TTY_NORMALIZE: '1'
    }, {
      defaultTtyNormalization: '0'
    }), [
      'TERM=xterm-256color',
      'COLORTERM=truecolor',
      'BOXDOWN_TTY_NORMALIZE=1',
      `BOXDOWN_TTY_MAX_COLUMNS=${DEFAULT_TTY_MAX_COLUMNS}`
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

  test('preserves coding-agent arguments while normalizing the TTY width', () => {
    const script = interactiveCommandScript().replace('if [ -t 0 ]; then', 'if true; then')
    const result = spawnSync('bash', [
      '-c',
      `stty() { printf '24 61\\n'; }\n${script}`,
      'boxdown-agent',
      'printf',
      '%s\\n',
      'claude'
    ], {
      encoding: 'utf8',
      env: { ...process.env, BASH_ENV: '/dev/null' }
    })

    assert.strictEqual(result.status, 0)
    assert.strictEqual(result.stdout, 'claude\n')
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
    const sshProxyBlock = /if \(parsed\.command === 'ssh-proxy'\) {([\s\S]*?)\n\s{4}if \(parsed\.command === 'refresh-gh-token'\)/.exec(mainSource)?.[1]

    assert.ok(sshProxyBlock !== undefined)
    assert.doesNotMatch(sshProxyBlock, /refreshContainerGhAuth/)
  })
})

describe('SSH config generation', () => {
  test('resolves the shared SSH config path by platform', () => {
    assert.strictEqual(defaultSshConfigPath({
      BOXDOWN_SSH_CONFIG: '/tmp/boxdown-config',
      DEVCONTAINER_SSH_CONFIG: '/tmp/devcontainer-config'
    }, 'linux'), '/tmp/boxdown-config')
    assert.strictEqual(defaultSshConfigPath({
      DEVCONTAINER_SSH_CONFIG: '/tmp/devcontainer-config'
    }, 'darwin'), '/tmp/devcontainer-config')
    assert.strictEqual(defaultSshConfigPath({ HOME: '/Users/tester' }, 'darwin'), '/Users/tester/.ssh/config')
    assert.strictEqual(defaultSshConfigPath({ HOME: '/home/tester' }, 'linux'), '/home/tester/.ssh/config')
    assert.strictEqual(
      defaultSshConfigPath({ USERPROFILE: 'C:\\Users\\tester' }, 'win32'),
      'C:\\Users\\tester\\.ssh\\config'
    )
    assert.strictEqual(
      defaultSshConfigPath({ USERPROFILE: '', HOME: 'C:\\Users\\fallback' }, 'win32'),
      'C:\\Users\\fallback\\.ssh\\config'
    )
    assert.throws(
      () => defaultSshConfigPath({}, 'win32'),
      /Cannot resolve the Windows home directory for the SSH config/
    )
    const foreignPosixPlatform: NodeJS.Platform = process.platform === 'linux' ? 'darwin' : 'linux'
    assert.throws(
      () => defaultSshConfigPath({}, foreignPosixPlatform),
      /Cannot resolve the (?:macOS|Linux) home directory for the SSH config/
    )
    assert.throws(
      () => defaultSshConfigPath({ HOME: '' }, foreignPosixPlatform),
      /Cannot resolve the (?:macOS|Linux) home directory for the SSH config/
    )
  })

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
    await assert.rejects(async () => installSshConfig(context, alias, { configPath: sshConfigPath }), /overlapping/)
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

    await installSshConfig(context, alias, { configPath: sshConfigPath })

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

  test('preserves shared Codex host state until its last project is removed', () => {
    const entry = {
      sshAlias: 'shared-devcontainer',
      remotePath: '/workspaces/first',
      label: 'First'
    }
    const remainingEntry = {
      sshAlias: entry.sshAlias,
      remotePath: '/workspaces/second',
      label: 'Second'
    }
    const hostId = codexDiscoveredRemoteHostId(entry.sshAlias)
    const hostSettings = {
      'remote-connection-analytics-id-by-host-id': {
        [hostId]: 'shared-analytics'
      },
      'remote-connection-auto-connect-by-host-id': {
        [hostId]: true
      },
      'preferred-non-full-access-agent-mode-by-host-id': {
        [hostId]: 'read-only'
      },
      'agent-mode-by-host-id': {
        [hostId]: 'auto'
      },
      'unread-thread-ids-by-host-v1': {
        [hostId]: ['thread-1']
      }
    }
    const state = {
      ...hostSettings,
      'codex-managed-remote-connections': [
        {
          hostId,
          displayName: entry.sshAlias,
          alias: entry.sshAlias
        }
      ],
      'selected-remote-host-id': hostId,
      'project-order': ['first-project', 'second-project'],
      'sidebar-collapsed-groups': {
        'first-project': true,
        'second-project': true
      },
      'remote-projects': [
        {
          id: 'first-project',
          hostId,
          remotePath: entry.remotePath,
          label: entry.label
        },
        {
          id: 'second-project',
          hostId,
          remotePath: remainingEntry.remotePath,
          label: remainingEntry.label
        }
      ],
      'electron-persisted-atom-state': {
        ...hostSettings,
        'codex-managed-remote-connections': [
          {
            hostId,
            displayName: entry.sshAlias,
            alias: entry.sshAlias
          }
        ],
        'selected-remote-host-id': hostId
      }
    }

    const afterFirstRemoval = removeCodexGlobalStateProject(state, entry)
    const afterLastRemoval = removeCodexGlobalStateProject(afterFirstRemoval, remainingEntry)
    const atomAfterFirstRemoval = afterFirstRemoval['electron-persisted-atom-state'] as Record<string, unknown>
    const atomAfterLastRemoval = afterLastRemoval['electron-persisted-atom-state'] as Record<string, unknown>

    assert.deepStrictEqual(afterFirstRemoval['remote-projects'], [
      {
        id: 'second-project',
        hostId,
        remotePath: remainingEntry.remotePath,
        label: remainingEntry.label
      }
    ])
    assert.deepStrictEqual(afterFirstRemoval['codex-managed-remote-connections'], state['codex-managed-remote-connections'])
    assert.strictEqual(afterFirstRemoval['selected-remote-host-id'], hostId)
    for (const [key, value] of Object.entries(hostSettings)) {
      assert.deepStrictEqual(afterFirstRemoval[key], value)
      assert.deepStrictEqual(atomAfterFirstRemoval[key], value)
    }
    assert.deepStrictEqual(atomAfterFirstRemoval['codex-managed-remote-connections'], state['codex-managed-remote-connections'])
    assert.strictEqual(atomAfterFirstRemoval['selected-remote-host-id'], hostId)
    assert.deepStrictEqual(afterLastRemoval['remote-projects'], [])
    assert.deepStrictEqual(afterLastRemoval['codex-managed-remote-connections'], [])
    assert.strictEqual(afterLastRemoval['selected-remote-host-id'], undefined)
    assert.deepStrictEqual(atomAfterLastRemoval['codex-managed-remote-connections'], [])
    assert.strictEqual(atomAfterLastRemoval['selected-remote-host-id'], undefined)
    for (const key of Object.keys(hostSettings)) {
      assert.deepStrictEqual(afterLastRemoval[key], {})
      assert.deepStrictEqual(atomAfterLastRemoval[key], {})
    }

    const atomOnlyState = {
      ...hostSettings,
      'codex-managed-remote-connections': state['codex-managed-remote-connections'],
      'selected-remote-host-id': hostId,
      'remote-projects': [
        {
          id: 'first-project',
          hostId,
          remotePath: entry.remotePath,
          label: entry.label
        }
      ],
      'electron-persisted-atom-state': {
        ...hostSettings,
        'codex-managed-remote-connections': state['codex-managed-remote-connections'],
        'selected-remote-host-id': hostId,
        'remote-projects': [
          {
            id: 'first-project',
            hostId,
            remotePath: entry.remotePath,
            label: entry.label
          },
          {
            id: 'second-project',
            hostId,
            remotePath: remainingEntry.remotePath,
            label: remainingEntry.label
          }
        ]
      }
    }
    const atomOnlyAfterFirstRemoval = removeCodexGlobalStateProject(atomOnlyState, entry)
    const atomOnlyAfterLastRemoval = removeCodexGlobalStateProject(atomOnlyAfterFirstRemoval, remainingEntry)
    const atomOnlyAfterFirstAtom = atomOnlyAfterFirstRemoval['electron-persisted-atom-state'] as Record<string, unknown>
    const atomOnlyAfterLastAtom = atomOnlyAfterLastRemoval['electron-persisted-atom-state'] as Record<string, unknown>

    assert.deepStrictEqual(atomOnlyAfterFirstRemoval['remote-projects'], [])
    assert.deepStrictEqual(atomOnlyAfterFirstAtom['remote-projects'], [
      {
        id: 'second-project',
        hostId,
        remotePath: remainingEntry.remotePath,
        label: remainingEntry.label
      }
    ])
    assert.deepStrictEqual(atomOnlyAfterFirstRemoval['codex-managed-remote-connections'], state['codex-managed-remote-connections'])
    assert.strictEqual(atomOnlyAfterFirstRemoval['selected-remote-host-id'], hostId)
    for (const [key, value] of Object.entries(hostSettings)) {
      assert.deepStrictEqual(atomOnlyAfterFirstRemoval[key], value)
      assert.deepStrictEqual(atomOnlyAfterFirstAtom[key], value)
    }
    assert.deepStrictEqual(atomOnlyAfterLastAtom['remote-projects'], [])
    assert.deepStrictEqual(atomOnlyAfterLastRemoval['codex-managed-remote-connections'], [])
    assert.strictEqual(atomOnlyAfterLastRemoval['selected-remote-host-id'], undefined)
    assert.deepStrictEqual(atomOnlyAfterLastAtom['codex-managed-remote-connections'], [])
    assert.strictEqual(atomOnlyAfterLastAtom['selected-remote-host-id'], undefined)
    for (const key of Object.keys(hostSettings)) {
      assert.deepStrictEqual(atomOnlyAfterLastRemoval[key], {})
      assert.deepStrictEqual(atomOnlyAfterLastAtom[key], {})
    }
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

    await installSshConfig(context, alias, { configPath: sshConfigPath })
    await installSshConfig(context, alias, { configPath: sshConfigPath })
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

  test('post-create configures workspace state without installing image-owned tools', () => {
    const postCreate = readFileSync(join(assetsDevcontainerDir, 'hooks', 'post-create.sh'), 'utf8')
    const gitConfigBootstrap = readFileSync(join(assetsDevcontainerDir, 'utils', 'git-config-bootstrap.sh'), 'utf8')

    assert.match(postCreate, /run_step "Configuring agent profile" configure_agent_profile/)
    assert.match(postCreate, /agent-profile-bootstrap\.mjs/)
    assert.ok(postCreate.indexOf('Configuring agent profile') < postCreate.indexOf('Installing workspace dependencies'))
    assert.doesNotMatch(postCreate, /Copying isolated agent profile/)
    assert.match(postCreate, /configure_global_git/)
    assert.match(postCreate, /git-config-bootstrap\.sh/)
    assert.match(postCreate, /configure_git_signing/)
    assert.match(postCreate, /configure_local_git/)
    assert.match(postCreate, /configure_runtime_secret_environment/)
    assert.match(postCreate, /ssh-bootstrap\.sh" runtime/)
    assert.match(postCreate, /deps-install\.sh/)
    assert.doesNotMatch(postCreate, /install_(openssh_server|python_runtime|apm|1password_cli|snyk_cli)/)
    assert.doesNotMatch(postCreate, /coding-agent-cli-update\.sh" install/)
    assert.match(postCreate, /BOXDOWN_PROGRESS: %s\\n/)
    assert.match(gitConfigBootstrap, /url\.git@github\.com:\.insteadOf/)
    assert.match(gitConfigBootstrap, /credential\.https:\/\/github\.com\.helper/)
    assert.match(gitConfigBootstrap, /Preparing writable Git config/)
  })

  test('keeps coding-agent refresh throttled in post-start', () => {
    const postStart = readFileSync(join(assetsDevcontainerDir, 'hooks', 'post-start.sh'), 'utf8')
    const updater = readFileSync(join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh'), 'utf8')
    const codexWrapper = readFileSync(join(assetsDevcontainerDir, 'utils', 'codex-cli-update.sh'), 'utf8')

    assert.match(postStart, /ssh-bootstrap\.sh" runtime/)
    assert.match(postStart, /coding-agent-cli-update\.sh" maybe-update/)
    assert.match(postStart, /run_step "Refreshing coding-agent CLIs"/)
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

  test('refreshes image-aged coding-agent stamps when the container is created', () => {
    const updaterPath = join(assetsDevcontainerDir, 'utils', 'coding-agent-cli-update.sh')
    const stateDir = tempDir('coding-agent-create-stamps-state')
    mkdirSync(stateDir, { recursive: true })

    for (const agent of ['codex', 'claude']) {
      const stampPath = join(stateDir, `${agent}.stamp`)
      writeFileSync(stampPath, '')
      execFileSync('touch', ['-t', '202001010000', stampPath])
    }

    execFileSync('bash', [updaterPath, 'initialize-stamps'], {
      env: {
        ...process.env,
        BOXDOWN_CODING_AGENT_UPDATE_STATE_DIR: stateDir
      },
      stdio: 'pipe'
    })

    const nowSeconds = Date.now() / 1000
    for (const agent of ['codex', 'claude']) {
      assert.ok(
        nowSeconds - statSync(join(stateDir, `${agent}.stamp`)).mtimeMs / 1000 < 10,
        `${agent} stamp must reflect container creation, not image build time`
      )
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
