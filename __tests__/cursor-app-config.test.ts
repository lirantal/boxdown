import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  cursorRemoteFolderUri,
  defaultCursorSettingsPath,
  formatCursorFolderCommand,
  mergeCursorRemotePlatform,
  removeCursorRemotePlatform,
  validateCursorSshConfigCompatibility
} from '../src/cursor-app-config.ts'

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
