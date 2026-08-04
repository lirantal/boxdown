# Cursor Remote SSH Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe `--target cursor` integration that configures Cursor Remote SSH over Boxdown's existing SSH alias and prints the remote-folder command.

**Architecture:** A focused Cursor module owns platform paths, JSONC edits, compatibility checks, ownership records, locking, and install/uninstall operations. The existing SSH target registry owns user-facing output, prerequisite warnings, profile eligibility, targeted uninstall, and complete-workspace cleanup; purge delegates through that registry before deleting workspace state.

**Tech Stack:** TypeScript, Node.js 24+, `jsonc-parser@3.3.1`, Node's built-in test runner, pnpm 11.

## Global Constraints

- Cursor uses Boxdown's existing managed OpenSSH `Host` alias; do not create a second container transport.
- Cursor opens `/workspaces/<repo-name>` through `vscode-remote://ssh-remote+<alias>/<path>`.
- Do not launch Cursor, install an extension, or edit Cursor SQLite, `workspaceStorage`, recent-project, or remote-history state.
- Edit only `remote.SSH.remotePlatform[alias]`, preserving user JSONC and refusing conflicting values.
- Validate the selected Cursor settings file against the same SSH config path Boxdown installs; do not rewrite `remote.SSH.configFile`.
- `BOXDOWN_CURSOR_SETTINGS` overrides the complete Cursor settings path.
- The Cursor Remote SSH prerequisite is `anysphere.remote-ssh`; probing is warning-only and limited to five seconds.
- Cursor-only setup does not trigger the agent-profile prompt; Codex or Claude in the same selection still does.
- Ownership records live at `<dataRoot>/workspaces/<workspaceId>/cursor-integration.json`, version `1`.
- Peer ownership is discovered from `<dataRoot>/workspaces/*/cursor-integration.json`, independent of `metadata.json`.
- Cursor integration mutations serialize through `<dataRoot>/cursor-integration.lock`; uncertain cleanup preserves settings.
- Targeted Cursor uninstall cleans the selected alias; unqualified uninstall and purge clean every mapping in that workspace record.
- macOS/Linux commands use POSIX quoting; Windows output is explicitly labelled PowerShell syntax and does not claim `cmd.exe` compatibility.
- Use test-first red-green-refactor cycles and commit after each task's tests pass.

---

### Task 1: Platform-aware shared SSH config resolution

**Files:**

- Modify: `src/ssh-config.ts`
- Modify: `__tests__/app.test.ts`

**Interfaces:**

- Produces: `defaultSshConfigPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string`
- Preserves: `BOXDOWN_SSH_CONFIG` before `DEVCONTAINER_SSH_CONFIG` before the platform default.

- [ ] **Step 1: Write the failing platform-path tests**

Add `win32` coverage beside the existing SSH config generation tests:

```ts
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
  assert.throws(
    () => defaultSshConfigPath({}, 'win32'),
    /Cannot resolve the Windows home directory for the SSH config/
  )
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```sh
node --import tsx --test --test-name-pattern='resolves the shared SSH config path by platform' __tests__/app.test.ts
```

Expected: FAIL because the current function has no platform argument and produces POSIX separators for Windows.

- [ ] **Step 3: Implement the platform-aware resolver**

Update imports and the function without changing existing callers:

```ts
import { homedir } from 'node:os'
import { dirname, join, win32 } from 'node:path'

export function defaultSshConfigPath (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const configuredPath = env.BOXDOWN_SSH_CONFIG ?? env.DEVCONTAINER_SSH_CONFIG
  if (configuredPath !== undefined) return configuredPath

  if (platform === 'win32') {
    const home = env.USERPROFILE ?? env.HOME
    if (home === undefined || home.length === 0) {
      throw new Error('Cannot resolve the Windows home directory for the SSH config')
    }
    return win32.join(home, '.ssh', 'config')
  }

  return join(env.HOME ?? homedir(), '.ssh', 'config')
}
```

- [ ] **Step 4: Run focused and full-file tests**

Run:

```sh
node --import tsx --test --test-name-pattern='SSH config|shared SSH config path' __tests__/app.test.ts
node --import tsx --test __tests__/app.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```sh
git add src/ssh-config.ts __tests__/app.test.ts
git commit -m "fix: resolve SSH config paths by platform"
```

---

### Task 2: Cursor paths, URI commands, compatibility, and JSONC edits

**Files:**

- Create: `src/cursor-app-config.ts`
- Create: `__tests__/cursor-app-config.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: Task 1's `defaultSshConfigPath(env, platform)` and `shellQuote(value)`.
- Produces:

```ts
export function defaultCursorSettingsPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string
export function cursorRemoteFolderUri(alias: string, workspaceBasename: string): string
export function formatCursorFolderCommand(folderUri: string, platform?: NodeJS.Platform): { label?: 'PowerShell', command: string }
export function validateCursorSshConfigCompatibility(settingsText: string, settingsPath: string, boxdownSshConfigPath: string, options?: { platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }): { cursorSshConfigPath: string, source: 'default' | 'setting' }
export function mergeCursorRemotePlatform(settingsText: string, alias: string): { text: string, changed: boolean, state: 'inserted' | 'existing-linux' }
export function removeCursorRemotePlatform(settingsText: string, alias: string): { text: string, changed: boolean, retainedBecause?: 'attached-comment' | 'missing' | 'changed-value' }
```

- [ ] **Step 1: Promote `jsonc-parser` to a direct dependency**

Add the exact dependency:

```json
"dependencies": {
  "@devcontainers/cli": "0.84.1",
  "jsonc-parser": "3.3.1"
}
```

Update the lockfile through the bundled pnpm runtime, not by hand:

```sh
/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm install --offline
```

Expected: the root importer lists `jsonc-parser` at `3.3.1`; no unrelated dependency versions change.

- [ ] **Step 2: Write failing path, URI, and command tests**

Create the test file with temporary-path helpers and these assertions:

```ts
test('resolves Cursor settings paths by platform', () => {
  assert.strictEqual(defaultCursorSettingsPath({ HOME: '/Users/tester' }, 'darwin'), '/Users/tester/Library/Application Support/Cursor/User/settings.json')
  assert.strictEqual(defaultCursorSettingsPath({ HOME: '/home/tester' }, 'linux'), '/home/tester/.config/Cursor/User/settings.json')
  assert.strictEqual(defaultCursorSettingsPath({ HOME: '/home/tester', XDG_CONFIG_HOME: '/xdg' }, 'linux'), '/xdg/Cursor/User/settings.json')
  assert.strictEqual(defaultCursorSettingsPath({ USERPROFILE: 'C:\\Users\\tester' }, 'win32'), 'C:\\Users\\tester\\AppData\\Roaming\\Cursor\\User\\settings.json')
  assert.strictEqual(defaultCursorSettingsPath({ APPDATA: 'D:\\Profiles\\tester' }, 'win32'), 'D:\\Profiles\\tester\\Cursor\\User\\settings.json')
  assert.strictEqual(defaultCursorSettingsPath({ BOXDOWN_CURSOR_SETTINGS: '/tmp/cursor.json' }, 'darwin'), '/tmp/cursor.json')
})

test('builds encoded Cursor folder URIs and platform commands', () => {
  const uri = cursorRemoteFolderUri('demo-devcontainer', "repo 100%'s")
  assert.strictEqual(uri, 'vscode-remote://ssh-remote+demo-devcontainer/workspaces/repo%20100%25%27s')
  assert.deepStrictEqual(formatCursorFolderCommand(uri, 'darwin'), {
    command: `cursor --folder-uri '${uri}'`
  })
  assert.deepStrictEqual(formatCursorFolderCommand(uri, 'win32'), {
    label: 'PowerShell',
    command: `cursor --folder-uri '${uri}'`
  })
})
```

- [ ] **Step 3: Run the new suite and verify RED**

Run:

```sh
node --import tsx --test __tests__/cursor-app-config.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/cursor-app-config.ts`.

- [ ] **Step 4: Implement path, URI, and command functions**

Start the module with the exact public types and platform behavior:

```ts
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import { applyEdits, createScanner, findNodeAtLocation, getNodeValue, modify, parseTree, printParseErrorCode, SyntaxKind, type FormattingOptions, type Node as JsonNode, type ParseError } from 'jsonc-parser'

import { shellQuote } from './shell.ts'
import { defaultSshConfigPath, validateSshAlias } from './ssh-config.ts'

export function defaultCursorSettingsPath (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.BOXDOWN_CURSOR_SETTINGS !== undefined) return env.BOXDOWN_CURSOR_SETTINGS
  if (platform === 'win32') {
    const home = env.USERPROFILE ?? env.HOME
    const appData = env.APPDATA ?? (home === undefined ? undefined : win32.join(home, 'AppData', 'Roaming'))
    if (appData === undefined) throw new Error('Cannot resolve the Windows Cursor settings directory')
    return win32.join(appData, 'Cursor', 'User', 'settings.json')
  }
  const home = env.HOME ?? homedir()
  return platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json')
    : join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Cursor', 'User', 'settings.json')
}

export function cursorRemoteFolderUri (alias: string, workspaceBasename: string): string {
  validateSshAlias(alias)
  return `vscode-remote://ssh-remote+${alias}/workspaces/${encodeURIComponent(workspaceBasename)}`
}

export function formatCursorFolderCommand (folderUri: string, platform: NodeJS.Platform = process.platform): { label?: 'PowerShell', command: string } {
  if (platform === 'win32') {
    const quoted = `'${folderUri.replaceAll("'", "''")}'`
    return { label: 'PowerShell', command: `cursor --folder-uri ${quoted}` }
  }
  return { command: `cursor --folder-uri ${shellQuote(folderUri)}` }
}
```

- [ ] **Step 5: Write failing compatibility and JSONC tests**

Add separate tests that prove:

```ts
test('validates Cursor and Boxdown SSH config paths before editing', () => {
  assert.deepStrictEqual(validateCursorSshConfigCompatibility('{}', '/tmp/settings.json', '/home/tester/.ssh/config', {
    platform: 'linux', env: { HOME: '/home/tester' }
  }), { cursorSshConfigPath: '/home/tester/.ssh/config', source: 'default' })
  assert.deepStrictEqual(validateCursorSshConfigCompatibility('{"remote.SSH.configFile":"/tmp/custom"}', '/tmp/settings.json', '/tmp/custom', {
    platform: 'linux', env: { HOME: '/home/tester' }
  }), { cursorSshConfigPath: '/tmp/custom', source: 'setting' })
  assert.throws(() => validateCursorSshConfigCompatibility('{"remote.SSH.configFile":"relative"}', '/tmp/settings.json', '/tmp/custom', {
    platform: 'linux', env: { HOME: '/home/tester' }
  }), /must be an absolute path/)
  assert.throws(() => validateCursorSshConfigCompatibility('{"remote.SSH.configFile":"/tmp/other"}', '/tmp/settings.json', '/tmp/custom', {
    platform: 'linux', env: { HOME: '/home/tester' }
  }), /Cursor SSH config.*\/tmp\/other.*Boxdown SSH config.*\/tmp\/custom/s)
})

test('surgically inserts and removes a Cursor Linux platform hint', () => {
  const original = '\ufeff{\r\n\t// keep me\r\n\t"editor.fontSize": 14,\r\n\t"remote.SSH.remotePlatform": {\r\n\t\t"other": "linux",\r\n\t},\r\n}\r\n'
  const installed = mergeCursorRemotePlatform(original, 'demo-devcontainer')
  assert.strictEqual(installed.changed, true)
  assert.strictEqual(installed.state, 'inserted')
  assert.match(installed.text, /"demo-devcontainer": "linux"/)
  assert.match(installed.text, /\/\/ keep me/)
  assert.ok(installed.text.startsWith('\ufeff'))
  assert.ok(installed.text.includes('\r\n\t\t'))
  const removed = removeCursorRemotePlatform(installed.text, 'demo-devcontainer')
  assert.strictEqual(removed.changed, true)
  assert.doesNotMatch(removed.text, /demo-devcontainer/)
  assert.match(removed.text, /"other": "linux"/)
})

test('retains an owned alias when its trivia contains a comment', () => {
  const text = '{\n  "remote.SSH.remotePlatform": {\n    // user note\n    "demo-devcontainer": "linux"\n  }\n}\n'
  assert.deepStrictEqual(removeCursorRemotePlatform(text, 'demo-devcontainer'), {
    text,
    changed: false,
    retainedBecause: 'attached-comment'
  })
})
```

Also add named cases for whitespace-only input, comment-only input failing closed, malformed JSONC, duplicate relevant keys, non-object root/parent, existing Linux no-op, conflicting platform, CRLF, tabs, trailing commas, and unrelated byte preservation.

- [ ] **Step 6: Implement strict parsing, compatibility, and one-edit JSONC mutations**

Implement private helpers with these exact rules:

```ts
const REMOTE_PLATFORM_PATH = ['remote.SSH.remotePlatform'] as const

function parseCursorRoot (text: string, settingsPath = 'Cursor settings'): { bom: string, body: string, root: JsonNode } {
  const bom = text.startsWith('\ufeff') ? '\ufeff' : ''
  const body = bom === '' ? text : text.slice(1)
  const source = body.trim().length === 0 ? '{}' : body
  const errors: ParseError[] = []
  const root = parseTree(source, errors, { allowTrailingComma: true })
  if (errors.length > 0 || root === undefined || root.type !== 'object') {
    const detail = errors[0] === undefined ? 'top-level value must be an object' : printParseErrorCode(errors[0].error)
    throw new Error(`Invalid Cursor settings JSONC: ${settingsPath} (${detail})`)
  }
  return { bom, body: source, root }
}

function formattingOptionsFor (text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const indented = text.match(/(?:^|\r?\n)([\t ]+)"/u)?.[1] ?? '  '
  return indented.includes('\t')
    ? { eol, insertSpaces: false, tabSize: 1, keepLines: true }
    : { eol, insertSpaces: true, tabSize: Math.max(1, indented.length), keepLines: true }
}
```

Before using `findNodeAtLocation`, walk object property children and reject duplicate `remote.SSH.configFile`, duplicate `remote.SSH.remotePlatform`, or duplicate selected alias keys. Require `remote.SSH.remotePlatform` to be an object when present. Call `modify` exactly once for each document state, with the array path `['remote.SSH.remotePlatform', alias]`, then `applyEdits`. Scan the selected property's conservative sibling trivia with `createScanner(text, false)`; any `LineCommentTrivia` or `BlockCommentTrivia` retains the property during removal. Reparse the result and assert the selected value/state before returning it.

Compatibility uses the platform-specific `isAbsolute`/`resolve` functions, treats absent or empty `remote.SSH.configFile` as `defaultSshConfigPath(env, platform)`, rejects non-string/non-absolute settings, normalizes Windows comparisons case-insensitively, and includes both paths in mismatch errors.

- [ ] **Step 7: Run Task 2 tests and commit**

Run:

```sh
node --import tsx --test __tests__/cursor-app-config.test.ts
node --import tsx --test __tests__/app.test.ts __tests__/cursor-app-config.test.ts
```

Expected: PASS.

```sh
git add package.json pnpm-lock.yaml src/cursor-app-config.ts __tests__/cursor-app-config.test.ts
git commit -m "feat: add Cursor settings integration core"
```

---

### Task 3: Cursor ownership, locking, and filesystem lifecycle

**Files:**

- Modify: `src/cursor-app-config.ts`
- Modify: `__tests__/cursor-app-config.test.ts`

**Interfaces:**

- Consumes: Task 2's settings validation/edit and URI functions.
- Produces:

```ts
export const CURSOR_INTEGRATION_VERSION = 1
export const CURSOR_INTEGRATION_FILENAME = 'cursor-integration.json'
export interface CursorRemotePlatformMapping { alias: string, settingsPath: string, remotePlatformOwned: boolean }
export interface CursorIntegrationRecord { version: 1, mappings: CursorRemotePlatformMapping[] }
export type CursorMappingDisposition = 'installed' | 'already-boxdown-managed' | 'preserved-user-owned'
export interface CursorInstallResult { settingsPath: string, sshConfigPath: string, folderUri: string, commandLabel?: 'PowerShell', command: string, disposition: CursorMappingDisposition, settingsChanged: boolean, ownershipChanged: boolean }
export interface CursorUninstallResult { settingsPath: string, aliases: readonly string[], settingsChanged: boolean, ownershipChanged: boolean, retainedBecause?: 'user-owned' | 'shared-owner' | 'user-modified' | 'uncertain-peer' }
export interface CursorOperationOptions { env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, settingsPath?: string, sshConfigPath?: string, lockTimeoutMs?: number, staleLockMs?: number, now?: () => Date, sleep?: (milliseconds: number) => Promise<void>, pidIsAlive?: (pid: number) => boolean, createNonce?: () => string }
export function cursorIntegrationPath(context: WorkspaceContext): string
export async function installCursorSshTarget(context: WorkspaceContext, alias: string, options?: CursorOperationOptions): Promise<CursorInstallResult>
export async function uninstallCursorSshTarget(context: WorkspaceContext, alias: string, options?: CursorOperationOptions): Promise<CursorUninstallResult[]>
export async function uninstallCursorWorkspaceTarget(context: WorkspaceContext, options?: CursorOperationOptions): Promise<CursorUninstallResult[]>
```

- [ ] **Step 1: Write failing ownership lifecycle tests**

Use real temporary `BOXDOWN_DATA_HOME`, settings, and SSH config paths. Cover these explicit state transitions:

```ts
test('shares Boxdown ownership and removes only the last owner', async () => {
  const first = fixture('first')
  const second = fixture('second', first.env)
  const alias = 'shared-devcontainer'
  await installCursorSshTarget(first.context, alias, first.options)
  await installCursorSshTarget(second.context, alias, second.options)
  assert.strictEqual(readMapping(first.settingsPath, alias), 'linux')
  await uninstallCursorSshTarget(first.context, alias, first.options)
  assert.strictEqual(readMapping(first.settingsPath, alias), 'linux')
  await uninstallCursorSshTarget(second.context, alias, second.options)
  assert.strictEqual(readMapping(first.settingsPath, alias), undefined)
})

test('complete cleanup processes old and current aliases', async () => {
  const item = fixture('aliases')
  await installCursorSshTarget(item.context, 'alias-a', item.options)
  await installCursorSshTarget(item.context, 'alias-b', item.options)
  const results = await uninstallCursorWorkspaceTarget(item.context, item.options)
  assert.deepStrictEqual(results.map((result) => result.aliases[0]).sort(), ['alias-a', 'alias-b'])
  assert.strictEqual(readMapping(item.settingsPath, 'alias-a'), undefined)
  assert.strictEqual(readMapping(item.settingsPath, 'alias-b'), undefined)
})
```

Add independent cases for pre-existing user-owned Linux, propagated Boxdown ownership, conflicting value, multiple settings paths, idempotence, valid peer without metadata, malformed/unreadable peer, changed user value, attached comment, missing settings, symlink target, existing/new modes, record-write failure before settings, settings-write failure restoring the prior record, cleanup failure retaining the record, active lock timeout, stale dead-PID lock reclaim, malformed lock fail-closed, and lock nonce ownership.

- [ ] **Step 2: Run the ownership cases and verify RED**

Run:

```sh
node --import tsx --test --test-name-pattern='ownership|complete cleanup|lock|atomic|symlink' __tests__/cursor-app-config.test.ts
```

Expected: FAIL because the high-level lifecycle exports do not exist.

- [ ] **Step 3: Implement records, direct scanning, and atomic writes**

Use the versioned record shape verbatim:

```ts
export const CURSOR_INTEGRATION_VERSION = 1
export const CURSOR_INTEGRATION_FILENAME = 'cursor-integration.json'

export interface CursorRemotePlatformMapping {
  alias: string
  settingsPath: string
  remotePlatformOwned: boolean
}

export interface CursorIntegrationRecord {
  version: 1
  mappings: CursorRemotePlatformMapping[]
}

export function cursorIntegrationPath (context: WorkspaceContext): string {
  return join(context.workspaceDataDir, CURSOR_INTEGRATION_FILENAME)
}
```

Validate every field when reading. Scan `join(context.dataRoot, 'workspaces')` directly with `readdirSync(..., { withFileTypes: true })`; do not call `listWorkspaceMetadata`. Return scan completeness separately from valid records so one unreadable record makes deletion conservative.

Atomic writes resolve an existing symbolic-link target, create a sibling temporary file with `wx`, use the existing mode masked with `0o777` or `0o600`, rename, and remove a leftover temporary file in `finally`. Record writes happen before required settings writes; restore the previous record snapshot if the settings write fails. Cleanup changes settings before removing its ownership entry so failures are retryable.

- [ ] **Step 4: Implement the serialized install/uninstall algorithms**

Use one data-root lock directory containing `{ pid, timestamp, nonce }`. Acquire with atomic `mkdir`, wait no more than 5,000 ms, and reclaim only after 600,000 ms when `process.kill(pid, 0)` proves the process absent. Treat `EPERM` as alive. Release only after rereading and matching the nonce.

Inside the lock:

1. reread settings and all ownership records;
2. validate SSH config compatibility before mutation;
3. determine whether existing Linux is user-owned or backed by any matching owned record;
4. upsert the current `(normalized settingsPath, alias)` entry without losing older entries;
5. insert Linux only when absent; and
6. return the encoded URI and platform command.

Alias cleanup processes every current-record entry with the selected alias. Complete cleanup processes every entry. Remove a Linux property only for the last proven owner, only when its value is unchanged, only when its trivia has no comment, and only when the peer scan is complete. Otherwise retain the property and report the exact conservative reason.

- [ ] **Step 5: Run Task 3 tests and commit**

Run:

```sh
node --import tsx --test __tests__/cursor-app-config.test.ts
node --import tsx --test __tests__/app.test.ts __tests__/cursor-app-config.test.ts
```

Expected: PASS with no access to real Cursor files.

```sh
git add src/cursor-app-config.ts __tests__/cursor-app-config.test.ts
git commit -m "feat: manage Cursor SSH target ownership"
```

---

### Task 4: Target registry, profile eligibility, prerequisite warning, and purge

**Files:**

- Modify: `src/ssh-install-targets.ts`
- Modify: `src/setup-agent-profile.ts`
- Modify: `src/main.ts`
- Modify: `src/purge.ts`
- Modify: `__tests__/setup-agent-profile.test.ts`
- Modify: `__tests__/app.test.ts`

**Interfaces:**

- Consumes: Task 3's three high-level Cursor lifecycle functions/results.
- Produces: registry capability metadata and complete-workspace cleanup dispatch.

- [ ] **Step 1: Write failing registry and profile tests**

Change the old Cursor rejection assertion into parsing/deduplication coverage:

```ts
assert.deepStrictEqual(parseCliArgs(['ssh', 'install', '--target', 'cursor', '--target', 'cursor']), {
  command: 'ssh-install', workspace: undefined, alias: undefined,
  targets: ['cursor'], recreate: false, json: false, verbose: false
})
```

Add profile cases:

```ts
test('does not prompt for Cursor alone but prompts for mixed agent targets', async () => {
  const cursorStreams = linePromptStreams()
  assert.deepStrictEqual(await resolveSetupAgentProfile({
    recordedProfile: 'full', targets: ['cursor'], input: cursorStreams.input,
    output: cursorStreams.output, env: { CI: 'false' }
  }), { cancelled: false, profile: 'full' })
  assert.strictEqual(cursorStreams.outputText(), '')

  for (const targets of [['cursor', 'codex'], ['cursor', 'claude']] as const) {
    const streams = linePromptStreams()
    const result = resolveSetupAgentProfile({ targets, input: streams.input, output: streams.output, env: { CI: 'false' } })
    streams.input.write('2\n')
    assert.deepStrictEqual(await result, { cancelled: false, profile: 'auth' })
  }
})
```

Add CLI process cases proving explicit Cursor install writes settings and prints the raw URI plus command without launching Cursor; targeted uninstall preserves the SSH config; absent/failed extension probing warns only; and unqualified uninstall cleans all recorded Cursor mappings.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```sh
node --import tsx --test __tests__/setup-agent-profile.test.ts
node --import tsx --test --test-name-pattern='Cursor|cursor' __tests__/app.test.ts
```

Expected: FAIL because `cursor` is not registered and raw target count still controls the profile prompt.

- [ ] **Step 3: Add registry capabilities and Cursor wrappers**

Extend the registry contract:

```ts
export type SshConfigInstallTarget = 'codex' | 'claude' | 'cursor'

export interface SshInstallTargetDefinition {
  value: SshConfigInstallTarget
  label: string
  description: string
  flag: string
  usesContainerAgentProfile: boolean
  install: (context: WorkspaceContext, alias: string, options?: SshInstallTargetOptions) => Promise<void> | void
  uninstall: (context: WorkspaceContext, alias: string, options?: SshInstallTargetOptions) => Promise<void> | void
  uninstallWorkspace: (context: WorkspaceContext, aliases: readonly string[], options?: SshInstallTargetOptions) => Promise<void> | void
}
```

Set `usesContainerAgentProfile: true` for Codex/Claude and `false` for Cursor. Export:

```ts
export function sshInstallTargetsUseContainerAgentProfile (targets: readonly SshConfigInstallTarget[]): boolean {
  return targets.some((value) => SSH_INSTALL_TARGETS.find((target) => target.value === value)?.usesContainerAgentProfile === true)
}
```

Cursor install calls `installCursorSshTarget`, prints settings/disposition/URI/command, then probes with `runBuffered('cursor', ['--list-extensions'], { timeoutMs: 5_000, mirrorStdout: false, mirrorStderr: false, logOutput: false })`. Code `127`, timeout, nonzero, or missing `anysphere.remote-ssh` prints a warning; no case runs `--install-extension`. Targeted uninstall calls `uninstallCursorSshTarget`. Complete uninstall calls `uninstallCursorWorkspaceTarget`.

Codex/Claude `uninstallWorkspace` loop the supplied alias set and reuse their existing uninstall functions.

- [ ] **Step 4: Use capability metadata for the setup profile**

Change only the eligibility condition:

```ts
if (
  options.explicitProfile !== undefined ||
  !sshInstallTargetsUseContainerAgentProfile(options.targets)
) {
  return { cancelled: false, profile: current }
}
```

All prompt content, explicit precedence, non-interactive behavior, and cancellation stay unchanged.

- [ ] **Step 5: Make unqualified uninstall and purge use complete cleanup**

Add a registry dispatcher:

```ts
export async function uninstallWorkspaceSshInstallTarget (
  context: WorkspaceContext,
  aliases: readonly string[],
  targetValue: SshConfigInstallTarget,
  options: SshInstallTargetOptions = {}
): Promise<void> {
  const target = SSH_INSTALL_TARGETS.find((candidate) => candidate.value === targetValue)
  if (target === undefined) throw new Error(`Unsupported ssh install target: ${targetValue}`)
  await target.uninstallWorkspace(context, aliases, options)
}
```

In `main.ts`, targeted `ssh uninstall` keeps alias dispatch; unqualified uninstall removes the SSH alias and calls `uninstallWorkspaceSshInstallTarget` for each registry target.

In `purge.ts`, separate SSH alias removal from target cleanup. Build the unique alias array once, remove each SSH block, then call every target's `uninstallWorkspace` once before Docker/state deletion. Update purge plan wording to `Codex, Claude, and Cursor integrations for those SSH connections, when installed`.

- [ ] **Step 6: Add purge regression tests**

Add a process-level test that installs Cursor alias A, installs alias B, invokes purge, and asserts both settings properties and `cursor-integration.json` are gone before workspace data removal. Add a second workspace sharing alias A and assert purging the first retains A until the second is cleaned. Preserve existing partial-failure exit semantics.

- [ ] **Step 7: Run Task 4 tests and commit**

Run:

```sh
node --import tsx --test __tests__/setup-agent-profile.test.ts __tests__/cursor-app-config.test.ts __tests__/app.test.ts
```

Expected: PASS.

```sh
git add src/ssh-install-targets.ts src/setup-agent-profile.ts src/main.ts src/purge.ts __tests__/setup-agent-profile.test.ts __tests__/app.test.ts
git commit -m "feat: register Cursor SSH target"
```

---

### Task 5: Public documentation and policy assertions

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/features/setup.md`
- Modify: `docs/features/ssh-config-and-proxy.md`
- Modify: `docs/features/generated-config-and-state.md`
- Modify: `docs/testing.md`
- Modify: `__tests__/app.test.ts`

**Interfaces:**

- Consumes: final CLI names, output, paths, and cleanup behavior from Tasks 1–4.
- Produces: user-facing Cursor setup, recovery, ownership, and manual verification guidance.

- [ ] **Step 1: Write failing documentation-policy assertions**

Extend the feature-doc assertions with exact public guarantees:

```ts
assert.match(setupDocs, /boxdown setup --target cursor/)
assert.match(setupDocs, /Cursor alone.*does not.*agent-profile/is)
assert.match(sshDocs, /remote\.SSH\.remotePlatform/)
assert.match(sshDocs, /cursor --folder-uri/)
assert.match(sshDocs, /anysphere\.remote-ssh/)
assert.match(sshDocs, /does not.*(?:SQLite|workspaceStorage)/is)
assert.match(stateDocs, /BOXDOWN_CURSOR_SETTINGS/)
assert.match(stateDocs, /cursor-integration\.json/)
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run:

```sh
node --import tsx --test --test-name-pattern='documents|README|feature docs' __tests__/app.test.ts
```

Expected: FAIL because the public documents do not mention Cursor.

- [ ] **Step 3: Update all public documents**

Document these exact items without implying GUI automation:

- `boxdown setup --target cursor`, `ssh install`, targeted uninstall, and repeatable mixed targets;
- macOS, Linux/XDG, and Windows Cursor settings paths plus `BOXDOWN_CURSOR_SETTINGS`;
- the Linux platform mapping and strict `remote.SSH.configFile` compatibility error/remedies;
- raw URI, POSIX command, and PowerShell-labelled Windows command;
- Cursor-only profile-prompt exclusion;
- `anysphere.remote-ssh` warning and manual install suggestion;
- multi-alias ownership records, shared-owner cleanup, lock, and stable data-root requirement;
- unqualified uninstall/purge complete-workspace cleanup;
- external refresh/restart advice; and
- explicit prohibition on Cursor launch, extension installation, SQLite, `workspaceStorage`, remote history, and synthesized Dev Containers authority.

Update architecture/testing inventories and every hard-coded “Codex and Claude” target list that now also includes Cursor. Do not change references specifically describing container agent profiles, because Cursor remains excluded from those profiles.

- [ ] **Step 4: Run docs tests and lint**

Run:

```sh
node --import tsx --test __tests__/app.test.ts
/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```sh
git add README.md docs/architecture.md docs/features/setup.md docs/features/ssh-config-and-proxy.md docs/features/generated-config-and-state.md docs/testing.md __tests__/app.test.ts
git commit -m "docs: document Cursor SSH support"
```

---

## Final Verification

Run with the bundled Node 24 runtime first on `PATH` so the toolchain fixture does not inherit a host executable path containing spaces:

```sh
PATH="/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" /Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm test
PATH="/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" /Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm run lint
PATH="/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" /Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm run build
```

Expected: all tests pass, lint exits zero, and the package builds without TypeScript or bundling errors.

The approved execution mode is **Subagent-Driven**: dispatch a fresh implementation subagent per task, generate a review package from that task's exact base/head commits, run a separate task reviewer for spec compliance and code quality, fix Critical/Important findings, update the durable ledger, and continue without pausing between tasks.
