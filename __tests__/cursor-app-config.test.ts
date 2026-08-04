import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, test } from 'node:test'

import {
  CURSOR_INTEGRATION_FILENAME,
  cursorIntegrationPath,
  cursorRemoteFolderUri,
  defaultCursorSettingsPath,
  formatCursorFolderCommand,
  installCursorSshTarget,
  mergeCursorRemotePlatform,
  removeCursorRemotePlatform,
  uninstallCursorSshTarget,
  uninstallCursorWorkspaceTarget,
  validateCursorSshConfigCompatibility
} from '../src/cursor-app-config.ts'
import { createWorkspaceContext } from '../src/paths.ts'

const temporaryDirectories: string[] = []

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
})

interface CursorFixture {
  root: string
  env: NodeJS.ProcessEnv
  context: ReturnType<typeof createWorkspaceContext>
  settingsPath: string
  sshConfigPath: string
  options: {
    env: NodeJS.ProcessEnv
    platform: NodeJS.Platform
    settingsPath: string
    sshConfigPath: string
  }
}

function cursorFixture (name: string, sharedEnv?: NodeJS.ProcessEnv, settingsPath?: string): CursorFixture {
  const root = sharedEnv?.BOXDOWN_DATA_HOME === undefined
    ? mkdtempSync(join(tmpdir(), `boxdown-cursor-${name}-`))
    : dirname(sharedEnv.BOXDOWN_DATA_HOME)
  if (sharedEnv === undefined) temporaryDirectories.push(root)
  const workspace = join(root, `workspace-${name}`)
  mkdirSync(workspace, { recursive: true })
  const sshConfigPath = sharedEnv?.BOXDOWN_SSH_CONFIG ?? join(root, '.ssh', 'config')
  const selectedSettingsPath = settingsPath ?? sharedEnv?.BOXDOWN_CURSOR_SETTINGS ?? join(root, 'Cursor', 'settings.json')
  const env = sharedEnv ?? {
    HOME: root,
    BOXDOWN_DATA_HOME: join(root, 'data'),
    BOXDOWN_CACHE_HOME: join(root, 'cache'),
    BOXDOWN_RUNTIME_HOME: join(root, 'runtime'),
    BOXDOWN_CURSOR_SETTINGS: selectedSettingsPath,
    BOXDOWN_SSH_CONFIG: sshConfigPath
  }
  mkdirSync(dirname(sshConfigPath), { recursive: true })
  if (!existsSync(sshConfigPath)) writeFileSync(sshConfigPath, '', { mode: 0o600 })
  const context = createWorkspaceContext({ workspace, env, platform: 'linux' })
  return {
    root,
    env,
    context,
    settingsPath: selectedSettingsPath,
    sshConfigPath,
    options: { env, platform: 'linux', settingsPath: selectedSettingsPath, sshConfigPath }
  }
}

function readMapping (settingsPath: string, alias: string): unknown {
  if (!existsSync(settingsPath)) return undefined
  const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
  const remotePlatform = parsed['remote.SSH.remotePlatform'] as Record<string, unknown> | undefined
  return remotePlatform?.[alias]
}

function readRecord (item: CursorFixture): { version: number, mappings: Array<{ alias: string, settingsPath: string, remotePlatformOwned: boolean }> } | undefined {
  const path = cursorIntegrationPath(item.context)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

function writePeerRecord (item: CursorFixture, name: string, value: unknown): string {
  const peerDir = join(item.context.dataRoot, 'workspaces', name)
  mkdirSync(peerDir, { recursive: true })
  const recordPath = join(peerDir, CURSOR_INTEGRATION_FILENAME)
  writeFileSync(recordPath, JSON.stringify(value), { mode: 0o600 })
  return recordPath
}

test('resolves Cursor settings paths by platform', () => {
  assert.strictEqual(defaultCursorSettingsPath({ HOME: '/Users/tester' }, 'darwin'), '/Users/tester/Library/Application Support/Cursor/User/settings.json')
  assert.strictEqual(defaultCursorSettingsPath({ HOME: '/home/tester' }, 'linux'), '/home/tester/.config/Cursor/User/settings.json')
  assert.strictEqual(defaultCursorSettingsPath({ HOME: '/home/tester', XDG_CONFIG_HOME: '/xdg' }, 'linux'), '/xdg/Cursor/User/settings.json')
  assert.strictEqual(defaultCursorSettingsPath({ USERPROFILE: 'C:\\Users\\tester' }, 'win32'), 'C:\\Users\\tester\\AppData\\Roaming\\Cursor\\User\\settings.json')
  assert.strictEqual(defaultCursorSettingsPath({ APPDATA: 'D:\\Profiles\\tester' }, 'win32'), 'D:\\Profiles\\tester\\Cursor\\User\\settings.json')
  assert.strictEqual(defaultCursorSettingsPath({ BOXDOWN_CURSOR_SETTINGS: '/tmp/cursor.json' }, 'darwin'), '/tmp/cursor.json')
})

test('rejects empty or missing Cursor settings path environment values', () => {
  assert.throws(
    () => defaultCursorSettingsPath({ BOXDOWN_CURSOR_SETTINGS: '' }, 'darwin'),
    /BOXDOWN_CURSOR_SETTINGS.*non-empty/
  )
  assert.throws(
    () => defaultCursorSettingsPath({}, 'darwin'),
    /Cannot resolve.*Cursor settings directory/
  )
  assert.throws(
    () => defaultCursorSettingsPath({ HOME: '' }, 'darwin'),
    /Cannot resolve.*Cursor settings directory/
  )
  assert.throws(
    () => defaultCursorSettingsPath({}, 'linux'),
    /Cannot resolve.*Cursor settings directory/
  )
  assert.throws(
    () => defaultCursorSettingsPath({ HOME: '' }, 'linux'),
    /Cannot resolve.*Cursor settings directory/
  )
  assert.throws(
    () => defaultCursorSettingsPath({ USERPROFILE: '', HOME: '' }, 'win32'),
    /Cannot resolve the Windows Cursor settings directory/
  )
})

test('treats empty platform variables as absent when a safe fallback exists', () => {
  assert.strictEqual(
    defaultCursorSettingsPath({ HOME: '/home/tester', XDG_CONFIG_HOME: '' }, 'linux'),
    '/home/tester/.config/Cursor/User/settings.json'
  )
  assert.strictEqual(
    defaultCursorSettingsPath({ XDG_CONFIG_HOME: '/xdg' }, 'linux'),
    '/xdg/Cursor/User/settings.json'
  )
  assert.strictEqual(
    defaultCursorSettingsPath({ APPDATA: '', USERPROFILE: 'C:\\Users\\tester' }, 'win32'),
    'C:\\Users\\tester\\AppData\\Roaming\\Cursor\\User\\settings.json'
  )
  assert.strictEqual(
    defaultCursorSettingsPath({ USERPROFILE: '', HOME: 'C:\\Users\\fallback' }, 'win32'),
    'C:\\Users\\fallback\\AppData\\Roaming\\Cursor\\User\\settings.json'
  )
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

test('treats an empty Cursor SSH config setting as the platform default', () => {
  assert.deepStrictEqual(validateCursorSshConfigCompatibility('{"remote.SSH.configFile":""}', '/tmp/settings.json', '/home/tester/.ssh/config', {
    platform: 'linux', env: { HOME: '/home/tester' }
  }), { cursorSshConfigPath: '/home/tester/.ssh/config', source: 'default' })
})

test('normalizes Windows SSH config paths case-insensitively', () => {
  assert.deepStrictEqual(validateCursorSshConfigCompatibility('{"remote.SSH.configFile":"C:\\\\Users\\\\Tester\\\\.ssh\\\\config"}', 'C:\\settings.json', 'c:\\users\\tester\\.ssh\\config', {
    platform: 'win32', env: { USERPROFILE: 'C:\\Users\\Tester' }
  }), { cursorSshConfigPath: 'C:\\Users\\Tester\\.ssh\\config', source: 'setting' })
})

test('rejects invalid and duplicate Cursor SSH config settings', () => {
  assert.throws(
    () => validateCursorSshConfigCompatibility('{"remote.SSH.configFile":42}', '/tmp/settings.json', '/tmp/config'),
    /must be a string/
  )
  assert.throws(
    () => validateCursorSshConfigCompatibility('{"remote.SSH.configFile":"/tmp/a","remote.SSH.configFile":"/tmp/b"}', '/tmp/settings.json', '/tmp/a'),
    /Duplicate Cursor setting.*remote\.SSH\.configFile/
  )
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

test('accepts whitespace-only settings as an empty object', () => {
  const result = mergeCursorRemotePlatform('  \r\n\t', 'demo-devcontainer')
  assert.strictEqual(result.changed, true)
  assert.strictEqual(result.state, 'inserted')
  assert.match(result.text, /"remote\.SSH\.remotePlatform"/)
  assert.match(result.text, /"demo-devcontainer": "linux"/)
})

test('fails closed for comment-only and malformed JSONC', () => {
  assert.throws(
    () => mergeCursorRemotePlatform('// no root value\n', 'demo-devcontainer'),
    /Invalid Cursor settings JSONC/
  )
  assert.throws(
    () => mergeCursorRemotePlatform('{"editor.fontSize": }', 'demo-devcontainer'),
    /Invalid Cursor settings JSONC/
  )
})

test('reports malformed JSONC with settings path and precise parser location', () => {
  assert.throws(
    () => validateCursorSshConfigCompatibility('{\n  "remote.SSH.configFile":\n}', '/tmp/cursor-settings.json', '/tmp/config'),
    /\/tmp\/cursor-settings\.json.*ValueExpected.*offset \d+.*line \d+.*column \d+/s
  )
})

test('requires object roots and remote platform parents', () => {
  assert.throws(
    () => mergeCursorRemotePlatform('[]', 'demo-devcontainer'),
    /top-level value must be an object/
  )
  assert.throws(
    () => mergeCursorRemotePlatform('{"remote.SSH.remotePlatform":"linux"}', 'demo-devcontainer'),
    /remote\.SSH\.remotePlatform.*must be an object/
  )
})

test('rejects duplicate remote platform and selected alias keys', () => {
  assert.throws(
    () => mergeCursorRemotePlatform('{"remote.SSH.remotePlatform":{},"remote.SSH.remotePlatform":{}}', 'demo-devcontainer'),
    /Duplicate Cursor setting.*remote\.SSH\.remotePlatform/
  )
  assert.throws(
    () => mergeCursorRemotePlatform('{"remote.SSH.remotePlatform":{"demo-devcontainer":"linux","demo-devcontainer":"linux"}}', 'demo-devcontainer'),
    /Duplicate Cursor setting.*demo-devcontainer/
  )
})

test('leaves an existing Linux platform hint unchanged', () => {
  const text = '{\n  "remote.SSH.remotePlatform": {\n    "demo-devcontainer": "linux",\n  },\n}\n'
  assert.deepStrictEqual(mergeCursorRemotePlatform(text, 'demo-devcontainer'), {
    text,
    changed: false,
    state: 'existing-linux'
  })
})

test('rejects conflicting remote platform values', () => {
  assert.throws(
    () => mergeCursorRemotePlatform('{"remote.SSH.remotePlatform":{"demo-devcontainer":"windows"}}', 'demo-devcontainer'),
    /demo-devcontainer.*windows.*linux/s
  )
})

test('preserves unrelated bytes, tabs, CRLF, and trailing commas', () => {
  const text = '{\r\n\t"alpha": [ 1, 2, ],\r\n\t"remote.SSH.remotePlatform": {\r\n\t\t"other": "linux",\r\n\t},\r\n\t"omega": { "nested": true, },\r\n}\r\n'
  const installed = mergeCursorRemotePlatform(text, 'demo-devcontainer')
  assert.ok(installed.text.includes('\t"alpha": [ 1, 2, ],\r\n'))
  assert.ok(installed.text.includes('\t"omega": { "nested": true, },\r\n'))
  assert.ok(installed.text.includes('\r\n\t\t"demo-devcontainer": "linux",\r\n'))
  const removed = removeCursorRemotePlatform(installed.text, 'demo-devcontainer')
  assert.strictEqual(removed.text, text)
})

test('preserves compact document bytes outside the alias edit', () => {
  const text = '{"alpha":1,"remote.SSH.remotePlatform":{"other":"linux"},"omega":2}'
  const installed = mergeCursorRemotePlatform(text, 'demo-devcontainer')
  assert.strictEqual(
    installed.text,
    '{"alpha":1,"remote.SSH.remotePlatform":{"other":"linux","demo-devcontainer": "linux"},"omega":2}'
  )
  assert.strictEqual(removeCursorRemotePlatform(installed.text, 'demo-devcontainer').text, text)
})

test('reports conservative removal reasons without rewriting', () => {
  const missing = '{"remote.SSH.remotePlatform":{"other":"linux"}}'
  assert.deepStrictEqual(removeCursorRemotePlatform(missing, 'demo-devcontainer'), {
    text: missing,
    changed: false,
    retainedBecause: 'missing'
  })
  const changed = '{"remote.SSH.remotePlatform":{"demo-devcontainer":"windows"}}'
  assert.deepStrictEqual(removeCursorRemotePlatform(changed, 'demo-devcontainer'), {
    text: changed,
    changed: false,
    retainedBecause: 'changed-value'
  })
})

test('shares Boxdown ownership and removes only the last owner', async () => {
  const first = cursorFixture('first')
  const second = cursorFixture('second', first.env)
  const alias = 'shared-devcontainer'
  await installCursorSshTarget(first.context, alias, first.options)
  const propagated = await installCursorSshTarget(second.context, alias, second.options)
  assert.strictEqual(propagated.disposition, 'already-boxdown-managed')
  assert.strictEqual(readRecord(second)?.mappings[0]?.remotePlatformOwned, true)
  assert.strictEqual(readMapping(first.settingsPath, alias), 'linux')
  const firstCleanup = await uninstallCursorSshTarget(first.context, alias, first.options)
  assert.strictEqual(firstCleanup[0]?.retainedBecause, 'shared-owner')
  assert.strictEqual(readMapping(first.settingsPath, alias), 'linux')
  await uninstallCursorSshTarget(second.context, alias, second.options)
  assert.strictEqual(readMapping(first.settingsPath, alias), undefined)
})

test('complete cleanup processes old and current aliases', async () => {
  const item = cursorFixture('aliases')
  await installCursorSshTarget(item.context, 'alias-a', item.options)
  await installCursorSshTarget(item.context, 'alias-b', item.options)
  const results = await uninstallCursorWorkspaceTarget(item.context, item.options)
  assert.deepStrictEqual(results.map((result) => result.aliases[0]).sort(), ['alias-a', 'alias-b'])
  assert.strictEqual(readMapping(item.settingsPath, 'alias-a'), undefined)
  assert.strictEqual(readMapping(item.settingsPath, 'alias-b'), undefined)
  assert.strictEqual(existsSync(cursorIntegrationPath(item.context)), false)
})

test('preserves pre-existing user-owned Linux ownership', async () => {
  const item = cursorFixture('user-owned')
  mkdirSync(dirname(item.settingsPath), { recursive: true })
  writeFileSync(item.settingsPath, '{"remote.SSH.remotePlatform":{"user-devcontainer":"linux"}}')
  const installed = await installCursorSshTarget(item.context, 'user-devcontainer', item.options)
  assert.strictEqual(installed.disposition, 'preserved-user-owned')
  assert.strictEqual(readRecord(item)?.mappings[0]?.remotePlatformOwned, false)
  const [removed] = await uninstallCursorSshTarget(item.context, 'user-devcontainer', item.options)
  assert.strictEqual(removed?.retainedBecause, 'user-owned')
  assert.strictEqual(readMapping(item.settingsPath, 'user-devcontainer'), 'linux')
})

test('rejects a conflicting value without changing ownership', async () => {
  const item = cursorFixture('conflict')
  mkdirSync(dirname(item.settingsPath), { recursive: true })
  const original = '{"remote.SSH.remotePlatform":{"conflict-devcontainer":"windows"}}'
  writeFileSync(item.settingsPath, original)
  await assert.rejects(installCursorSshTarget(item.context, 'conflict-devcontainer', item.options), /expected "linux"/)
  assert.strictEqual(readFileSync(item.settingsPath, 'utf8'), original)
  assert.strictEqual(existsSync(cursorIntegrationPath(item.context)), false)
})

test('complete cleanup handles multiple settings paths and aliases', async () => {
  const item = cursorFixture('settings-paths')
  const otherSettingsPath = join(item.root, 'Cursor-Insiders', 'settings.json')
  await installCursorSshTarget(item.context, 'alias-one', item.options)
  await installCursorSshTarget(item.context, 'alias-two', { ...item.options, settingsPath: otherSettingsPath })
  assert.strictEqual(readRecord(item)?.mappings.length, 2)
  const results = await uninstallCursorWorkspaceTarget(item.context, item.options)
  assert.strictEqual(results.length, 2)
  assert.strictEqual(readMapping(item.settingsPath, 'alias-one'), undefined)
  assert.strictEqual(readMapping(otherSettingsPath, 'alias-two'), undefined)
})

test('install and uninstall ownership operations are idempotent and preserve modes', async () => {
  const item = cursorFixture('idempotent')
  mkdirSync(dirname(item.settingsPath), { recursive: true })
  writeFileSync(item.settingsPath, '{}', { mode: 0o640 })
  const first = await installCursorSshTarget(item.context, 'mode-devcontainer', item.options)
  const second = await installCursorSshTarget(item.context, 'mode-devcontainer', item.options)
  assert.strictEqual(first.settingsChanged, true)
  assert.strictEqual(second.settingsChanged, false)
  assert.strictEqual(second.ownershipChanged, false)
  assert.strictEqual(statSync(item.settingsPath).mode & 0o777, 0o640)
  assert.strictEqual(statSync(cursorIntegrationPath(item.context)).mode & 0o777, 0o600)
  await uninstallCursorSshTarget(item.context, 'mode-devcontainer', item.options)
  assert.deepStrictEqual(await uninstallCursorSshTarget(item.context, 'mode-devcontainer', item.options), [])

  const fresh = cursorFixture('new-mode')
  await installCursorSshTarget(fresh.context, 'fresh-devcontainer', fresh.options)
  assert.strictEqual(statSync(fresh.settingsPath).mode & 0o777, 0o600)
})

test('discovers direct peer ownership without metadata', async () => {
  const item = cursorFixture('peer-no-metadata')
  mkdirSync(dirname(item.settingsPath), { recursive: true })
  writeFileSync(item.settingsPath, '{"remote.SSH.remotePlatform":{"peer-devcontainer":"linux"}}')
  writePeerRecord(item, 'orphan-peer', {
    version: 1,
    mappings: [{ alias: 'peer-devcontainer', settingsPath: item.settingsPath, remotePlatformOwned: true }]
  })
  const installed = await installCursorSshTarget(item.context, 'peer-devcontainer', item.options)
  assert.strictEqual(installed.disposition, 'already-boxdown-managed')
  assert.strictEqual(readRecord(item)?.mappings[0]?.remotePlatformOwned, true)
})

test('keeps POSIX ownership paths case-sensitive', async () => {
  const item = cursorFixture('case-sensitive-peer')
  mkdirSync(dirname(item.settingsPath), { recursive: true })
  writeFileSync(item.settingsPath, '{"remote.SSH.remotePlatform":{"peer-devcontainer":"linux"}}')
  writePeerRecord(item, 'different-case-peer', {
    version: 1,
    mappings: [{ alias: 'peer-devcontainer', settingsPath: item.settingsPath.toUpperCase(), remotePlatformOwned: true }]
  })
  const installed = await installCursorSshTarget(item.context, 'peer-devcontainer', item.options)
  assert.strictEqual(installed.disposition, 'preserved-user-owned')
  assert.strictEqual(readRecord(item)?.mappings[0]?.remotePlatformOwned, false)
})

test('fails closed when existing Linux ownership is uncertain during install', async () => {
  const first = cursorFixture('uncertain-install-owner')
  const second = cursorFixture('uncertain-install-consumer', first.env)
  const alias = 'uncertain-devcontainer'
  await installCursorSshTarget(first.context, alias, first.options)
  const firstRecordPath = cursorIntegrationPath(first.context)
  const validRecord = readFileSync(firstRecordPath, 'utf8')
  writeFileSync(firstRecordPath, '{malformed')
  await assert.rejects(
    installCursorSshTarget(second.context, alias, second.options),
    /ownership.*uncertain|uncertain.*ownership/i
  )
  assert.strictEqual(existsSync(cursorIntegrationPath(second.context)), false)
  assert.strictEqual(readMapping(first.settingsPath, alias), 'linux')

  writeFileSync(firstRecordPath, validRecord)
  const installed = await installCursorSshTarget(second.context, alias, second.options)
  assert.strictEqual(installed.disposition, 'already-boxdown-managed')
  await uninstallCursorSshTarget(first.context, alias, first.options)
  assert.strictEqual(readMapping(first.settingsPath, alias), 'linux')
})

test('retains ownership conservatively for malformed or unreadable peers', async () => {
  const malformed = cursorFixture('malformed-peer')
  await installCursorSshTarget(malformed.context, 'safe-devcontainer', malformed.options)
  writePeerRecord(malformed, 'bad-peer', { version: 1, mappings: [{ alias: 42 }] })
  const malformedResult = await uninstallCursorSshTarget(malformed.context, 'safe-devcontainer', malformed.options)
  assert.strictEqual(malformedResult[0]?.retainedBecause, 'uncertain-peer')
  assert.strictEqual(readMapping(malformed.settingsPath, 'safe-devcontainer'), 'linux')

  const unreadable = cursorFixture('unreadable-peer')
  await installCursorSshTarget(unreadable.context, 'safe-devcontainer', unreadable.options)
  const unreadablePath = join(unreadable.context.dataRoot, 'workspaces', 'unreadable', CURSOR_INTEGRATION_FILENAME)
  mkdirSync(unreadablePath, { recursive: true })
  const unreadableResult = await uninstallCursorSshTarget(unreadable.context, 'safe-devcontainer', unreadable.options)
  assert.strictEqual(unreadableResult[0]?.retainedBecause, 'uncertain-peer')
  assert.strictEqual(readMapping(unreadable.settingsPath, 'safe-devcontainer'), 'linux')
})

test('retains ownership after user value and comment changes or missing settings', async () => {
  const changed = cursorFixture('changed-value')
  await installCursorSshTarget(changed.context, 'changed-devcontainer', changed.options)
  writeFileSync(changed.settingsPath, '{"remote.SSH.remotePlatform":{"changed-devcontainer":"windows"}}')
  const changedResult = await uninstallCursorSshTarget(changed.context, 'changed-devcontainer', changed.options)
  assert.strictEqual(changedResult[0]?.retainedBecause, 'user-modified')
  assert.strictEqual(readMapping(changed.settingsPath, 'changed-devcontainer'), 'windows')

  const commented = cursorFixture('attached-comment')
  await installCursorSshTarget(commented.context, 'comment-devcontainer', commented.options)
  writeFileSync(commented.settingsPath, '{\n  "remote.SSH.remotePlatform": {\n    // keep this\n    "comment-devcontainer": "linux"\n  }\n}\n')
  const commentResult = await uninstallCursorSshTarget(commented.context, 'comment-devcontainer', commented.options)
  assert.strictEqual(commentResult[0]?.retainedBecause, 'user-modified')
  assert.match(readFileSync(commented.settingsPath, 'utf8'), /"comment-devcontainer": "linux"/)

  const missing = cursorFixture('missing-settings')
  await installCursorSshTarget(missing.context, 'missing-devcontainer', missing.options)
  rmSync(missing.settingsPath)
  const missingResult = await uninstallCursorSshTarget(missing.context, 'missing-devcontainer', missing.options)
  assert.strictEqual(missingResult[0]?.retainedBecause, 'user-modified')
  assert.strictEqual(existsSync(cursorIntegrationPath(missing.context)), false)
})

test('atomic settings updates preserve an existing symlink target', async () => {
  const item = cursorFixture('symlink')
  const targetPath = join(item.root, 'actual-settings.json')
  mkdirSync(dirname(item.settingsPath), { recursive: true })
  writeFileSync(targetPath, '{}', { mode: 0o640 })
  symlinkSync(targetPath, item.settingsPath)
  await installCursorSshTarget(item.context, 'link-devcontainer', item.options)
  assert.strictEqual(lstatSync(item.settingsPath).isSymbolicLink(), true)
  assert.strictEqual(readlinkSync(item.settingsPath), targetPath)
  assert.strictEqual(readMapping(targetPath, 'link-devcontainer'), 'linux')
  assert.strictEqual(statSync(targetPath).mode & 0o777, 0o640)
})

test('atomic settings updates preserve a dangling relative symlink', async () => {
  const item = cursorFixture('dangling-relative-symlink')
  const relativeTarget = '../targets/settings.json'
  const targetPath = join(item.root, 'targets', 'settings.json')
  mkdirSync(dirname(item.settingsPath), { recursive: true })
  symlinkSync(relativeTarget, item.settingsPath)

  await installCursorSshTarget(item.context, 'dangling-devcontainer', item.options)

  assert.strictEqual(lstatSync(item.settingsPath).isSymbolicLink(), true)
  assert.strictEqual(readlinkSync(item.settingsPath), relativeTarget)
  assert.strictEqual(readMapping(targetPath, 'dangling-devcontainer'), 'linux')
  assert.strictEqual(statSync(targetPath).mode & 0o777, 0o600)
})

test('atomic settings updates preserve a dangling symlink chain', async () => {
  const item = cursorFixture('dangling-symlink-chain')
  const intermediatePath = join(item.root, 'links', 'cursor-settings.json')
  const targetPath = join(item.root, 'targets', 'chained-settings.json')
  mkdirSync(dirname(item.settingsPath), { recursive: true })
  mkdirSync(dirname(intermediatePath), { recursive: true })
  symlinkSync('../links/cursor-settings.json', item.settingsPath)
  symlinkSync(targetPath, intermediatePath)

  await installCursorSshTarget(item.context, 'chain-devcontainer', item.options)

  assert.strictEqual(lstatSync(item.settingsPath).isSymbolicLink(), true)
  assert.strictEqual(lstatSync(intermediatePath).isSymbolicLink(), true)
  assert.strictEqual(readlinkSync(intermediatePath), targetPath)
  assert.strictEqual(readMapping(targetPath, 'chain-devcontainer'), 'linux')
})

test('atomic settings updates reject a symbolic link cycle', async () => {
  const item = cursorFixture('symlink-cycle')
  const otherPath = join(dirname(item.settingsPath), 'other-settings.json')
  mkdirSync(dirname(item.settingsPath), { recursive: true })
  symlinkSync('other-settings.json', item.settingsPath)
  symlinkSync('settings.json', otherPath)

  await assert.rejects(
    installCursorSshTarget(item.context, 'cycle-devcontainer', item.options),
    /Cursor settings symbolic link cycle/
  )
  assert.strictEqual(lstatSync(item.settingsPath).isSymbolicLink(), true)
  assert.strictEqual(lstatSync(otherPath).isSymbolicLink(), true)
  assert.strictEqual(existsSync(cursorIntegrationPath(item.context)), false)
})

test('atomic settings updates reject excessive symbolic link depth', async () => {
  const item = cursorFixture('symlink-depth')
  const chainDirectory = join(item.root, 'deep-links')
  mkdirSync(dirname(item.settingsPath), { recursive: true })
  mkdirSync(chainDirectory, { recursive: true })
  let linkPath = item.settingsPath
  for (let index = 0; index < 41; index++) {
    const nextPath = join(chainDirectory, `link-${index}.json`)
    symlinkSync(relative(dirname(linkPath), nextPath), linkPath)
    linkPath = nextPath
  }

  await assert.rejects(
    installCursorSshTarget(item.context, 'depth-devcontainer', item.options),
    /Cursor settings symbolic link depth exceeds 40/
  )
  assert.strictEqual(lstatSync(item.settingsPath).isSymbolicLink(), true)
  assert.strictEqual(existsSync(cursorIntegrationPath(item.context)), false)
})

test('atomic install does not touch settings when record persistence fails', async () => {
  const item = cursorFixture('record-write-failure')
  mkdirSync(item.context.workspaceDataDir, { recursive: true })
  chmodSync(item.context.workspaceDataDir, 0o500)
  try {
    await assert.rejects(installCursorSshTarget(item.context, 'atomic-devcontainer', item.options))
    assert.strictEqual(existsSync(item.settingsPath), false)
  } finally {
    chmodSync(item.context.workspaceDataDir, 0o700)
  }
})

test('atomic install restores the prior record when the settings write fails', async () => {
  const item = cursorFixture('settings-write-failure')
  mkdirSync(dirname(item.settingsPath), { recursive: true })
  writeFileSync(item.settingsPath, '{}')
  const prior = { version: 1, mappings: [{ alias: 'old-devcontainer', settingsPath: item.settingsPath, remotePlatformOwned: false }] }
  mkdirSync(item.context.workspaceDataDir, { recursive: true })
  writeFileSync(cursorIntegrationPath(item.context), JSON.stringify(prior), { mode: 0o600 })
  chmodSync(dirname(item.settingsPath), 0o500)
  try {
    await assert.rejects(installCursorSshTarget(item.context, 'atomic-devcontainer', item.options))
    assert.deepStrictEqual(readRecord(item), prior)
    assert.strictEqual(readMapping(item.settingsPath, 'atomic-devcontainer'), undefined)
  } finally {
    chmodSync(dirname(item.settingsPath), 0o700)
  }
})

test('atomic cleanup failure retains the ownership record for retry', async () => {
  const item = cursorFixture('cleanup-failure')
  await installCursorSshTarget(item.context, 'atomic-devcontainer', item.options)
  chmodSync(dirname(item.settingsPath), 0o500)
  try {
    await assert.rejects(uninstallCursorSshTarget(item.context, 'atomic-devcontainer', item.options))
    assert.strictEqual(readRecord(item)?.mappings[0]?.alias, 'atomic-devcontainer')
    assert.strictEqual(readMapping(item.settingsPath, 'atomic-devcontainer'), 'linux')
  } finally {
    chmodSync(dirname(item.settingsPath), 0o700)
  }
})

test('active integration lock times out without mutation', async () => {
  const item = cursorFixture('active-lock')
  const lockPath = join(item.context.dataRoot, 'cursor-integration.lock')
  mkdirSync(lockPath, { recursive: true })
  let milliseconds = 0
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 123, timestamp: new Date(0).toISOString(), nonce: 'active' }))
  await assert.rejects(installCursorSshTarget(item.context, 'lock-devcontainer', {
    ...item.options,
    lockTimeoutMs: 100,
    staleLockMs: 1_000,
    now: () => new Date(milliseconds),
    sleep: async delay => { milliseconds += delay },
    pidIsAlive: () => true
  }), /lock.*timed out/i)
  assert.strictEqual(existsSync(item.settingsPath), false)
})

test('transient lock owner creation race waits until timeout', async () => {
  const item = cursorFixture('lock-owner-race')
  const lockPath = join(item.context.dataRoot, 'cursor-integration.lock')
  mkdirSync(lockPath, { recursive: true })
  let milliseconds = 0
  let suppliedOwner = false
  await assert.rejects(installCursorSshTarget(item.context, 'lock-devcontainer', {
    ...item.options,
    lockTimeoutMs: 100,
    now: () => new Date(milliseconds),
    sleep: async delay => {
      milliseconds += delay
      if (!suppliedOwner) {
        suppliedOwner = true
        writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
          pid: 123,
          timestamp: new Date(milliseconds).toISOString(),
          nonce: 'active'
        }))
      }
    },
    pidIsAlive: () => true
  }), /lock.*timed out/i)
  assert.strictEqual(suppliedOwner, true)
  assert.strictEqual(existsSync(item.settingsPath), false)
})

test('integration lock rereads settings after contention', async () => {
  const item = cursorFixture('lock-recheck')
  const lockPath = join(item.context.dataRoot, 'cursor-integration.lock')
  mkdirSync(lockPath, { recursive: true })
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 123, timestamp: new Date().toISOString(), nonce: 'first-owner' }))
  let released = false
  const installed = await installCursorSshTarget(item.context, 'recheck-devcontainer', {
    ...item.options,
    sleep: async () => {
      if (!released) {
        released = true
        mkdirSync(dirname(item.settingsPath), { recursive: true })
        writeFileSync(item.settingsPath, '{"remote.SSH.remotePlatform":{"recheck-devcontainer":"linux"}}')
        rmSync(lockPath, { recursive: true })
      }
    },
    pidIsAlive: () => true
  })
  assert.strictEqual(installed.disposition, 'preserved-user-owned')
  assert.strictEqual(installed.settingsChanged, false)
})

test('stale live and EPERM integration locks are not reclaimed', async () => {
  for (const [name, pidIsAlive] of [
    ['live', () => true],
    ['eperm', () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }) }]
  ] as const) {
    const item = cursorFixture(`stale-${name}`)
    const lockPath = join(item.context.dataRoot, 'cursor-integration.lock')
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 456, timestamp: new Date(0).toISOString(), nonce: name }))
    let milliseconds = 700_000
    await assert.rejects(installCursorSshTarget(item.context, 'lock-devcontainer', {
      ...item.options,
      lockTimeoutMs: 50,
      staleLockMs: 600_000,
      now: () => new Date(milliseconds),
      sleep: async delay => { milliseconds += delay },
      pidIsAlive
    }), /lock.*timed out/i)
    assert.strictEqual(existsSync(lockPath), true)
  }
})

test('stale dead-PID integration lock is reclaimed', async () => {
  const item = cursorFixture('stale-lock')
  const lockPath = join(item.context.dataRoot, 'cursor-integration.lock')
  mkdirSync(lockPath, { recursive: true })
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 456, timestamp: new Date(0).toISOString(), nonce: 'stale' }))
  await installCursorSshTarget(item.context, 'lock-devcontainer', {
    ...item.options,
    now: () => new Date(700_000),
    pidIsAlive: () => false,
    createNonce: () => 'replacement'
  })
  assert.strictEqual(readMapping(item.settingsPath, 'lock-devcontainer'), 'linux')
  assert.strictEqual(existsSync(lockPath), false)
})

test('malformed integration lock fails closed', async () => {
  const item = cursorFixture('malformed-lock')
  const lockPath = join(item.context.dataRoot, 'cursor-integration.lock')
  mkdirSync(lockPath, { recursive: true })
  writeFileSync(join(lockPath, 'owner.json'), '{not json')
  await assert.rejects(installCursorSshTarget(item.context, 'lock-devcontainer', item.options), /malformed.*lock|lock.*malformed/i)
  assert.strictEqual(existsSync(item.settingsPath), false)
})

test('integration lock release requires nonce ownership', async () => {
  const item = cursorFixture('lock-nonce')
  const lockPath = join(item.context.dataRoot, 'cursor-integration.lock')
  let nonceCalls = 0
  await installCursorSshTarget(item.context, 'lock-devcontainer', {
    ...item.options,
    createNonce: () => {
      nonceCalls += 1
      if (nonceCalls === 1) {
        queueMicrotask(() => {
          writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            timestamp: new Date().toISOString(),
            nonce: 'replacement-owner'
          }))
        })
        return 'original-owner'
      }
      return `temporary-${nonceCalls}`
    }
  })
  assert.strictEqual(existsSync(lockPath), true)
  assert.match(readFileSync(join(lockPath, 'owner.json'), 'utf8'), /replacement-owner/)
})
