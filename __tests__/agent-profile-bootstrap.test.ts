import assert from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const bootstrapPath = fileURLToPath(new URL(
  '../assets/devcontainer/utils/agent-profile-bootstrap.mjs',
  import.meta.url
))

interface BootstrapRoots {
  source: string
  home: string
  marker: string
}

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `boxdown-agent-profile-${name}-`))
}

function roots(name: string): BootstrapRoots {
  const root = tempDir(name)
  return {
    source: join(root, 'source'),
    home: join(root, 'home'),
    marker: join(root, 'state', 'agent-profile')
  }
}

function runBootstrap(
  profile: string | undefined,
  paths: BootstrapRoots
): ReturnType<typeof spawnSync> {
  mkdirSync(paths.source, { recursive: true })
  mkdirSync(paths.home, { recursive: true })
  const env = {
    ...process.env,
    BOXDOWN_AGENT_PROFILE_SOURCE_DIR: paths.source,
    BOXDOWN_AGENT_PROFILE_HOME: paths.home,
    BOXDOWN_AGENT_PROFILE_MARKER_PATH: paths.marker
  }
  if (profile === undefined) {
    delete env.BOXDOWN_AGENT_PROFILE
  } else {
    env.BOXDOWN_AGENT_PROFILE = profile
  }
  return spawnSync(process.execPath, [bootstrapPath], {
    encoding: 'utf8',
    env
  })
}

function assertSucceeded(result: ReturnType<typeof spawnSync>): void {
  assert.ifError(result.error)
  assert.strictEqual(result.status, 0, result.stderr)
}

function writeSourceFile(root: string, path: string, contents: string): string {
  const destination = join(root, path)
  mkdirSync(join(destination, '..'), { recursive: true })
  writeFileSync(destination, contents)
  return destination
}

function treeSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {}

  function visit(path: string): void {
    const entry = lstatSync(path)
    const name = relative(root, path) || '.'
    if (entry.isSymbolicLink()) {
      result[name] = `link:${readlinkSync(path)}`
      return
    }
    if (entry.isDirectory()) {
      result[name] = `dir:${(entry.mode & 0o777).toString(8)}`
      for (const child of readdirSync(path).sort()) visit(join(path, child))
      return
    }
    if (entry.isFile()) {
      result[name] = `file:${(entry.mode & 0o777).toString(8)}:${readFileSync(path).toString('base64')}`
      return
    }
    result[name] = 'special'
  }

  visit(root)
  return result
}

test('none copies nothing and writes the selected profile marker', () => {
  const paths = roots('none')
  writeSourceFile(paths.source, 'agents/instructions.md', 'host instructions\n')

  const result = runBootstrap('none', paths)

  assertSucceeded(result)
  assert.deepStrictEqual(readdirSync(paths.home), [])
  assert.strictEqual(readFileSync(paths.marker, 'utf8'), 'none\n')
})

test('auth copies only credentials and all agent content', () => {
  const paths = roots('auth')
  writeSourceFile(paths.source, 'agents/skills/nested.md', 'nested\n')
  writeSourceFile(paths.source, 'agents/AGENTS.md', 'instructions\n')
  writeSourceFile(paths.source, 'codex-auth.json', '{"token":"codex"}\n')
  writeSourceFile(paths.source, 'claude-credentials.json', '{"token":"claude"}\n')
  writeSourceFile(paths.source, 'codex/config.toml', 'host config\n')
  writeSourceFile(paths.source, 'claude/settings.json', '{"host":true}\n')
  writeSourceFile(paths.source, 'claude-config.json', '{"host":true}\n')

  const result = runBootstrap('auth', paths)

  assertSucceeded(result)
  assert.strictEqual(readFileSync(join(paths.home, '.agents', 'skills', 'nested.md'), 'utf8'), 'nested\n')
  assert.strictEqual(readFileSync(join(paths.home, '.agents', 'AGENTS.md'), 'utf8'), 'instructions\n')
  assert.strictEqual(readFileSync(join(paths.home, '.codex', 'auth.json'), 'utf8'), '{"token":"codex"}\n')
  assert.strictEqual(readFileSync(join(paths.home, '.claude', '.credentials.json'), 'utf8'), '{"token":"claude"}\n')
  assert.deepStrictEqual(readdirSync(join(paths.home, '.codex')), ['auth.json'])
  assert.deepStrictEqual(readdirSync(join(paths.home, '.claude')), ['.credentials.json'])
  assert.strictEqual(lstatSync(join(paths.home, '.claude.json'), { throwIfNoEntry: false }), undefined)
  assert.strictEqual(readFileSync(paths.marker, 'utf8'), 'auth\n')
})

test('full copies all four opaque top-level sources', () => {
  const paths = roots('full')
  writeSourceFile(paths.source, 'agents/skill.md', 'skill\n')
  writeSourceFile(paths.source, 'codex/config.toml', '[features]\n')
  writeSourceFile(paths.source, 'claude/settings.json', '{"theme":"dark"}\n')
  writeSourceFile(paths.source, 'claude-config.json', '{"mcpServers":{}}\n')

  const result = runBootstrap('full', paths)

  assertSucceeded(result)
  assert.strictEqual(readFileSync(join(paths.home, '.agents', 'skill.md'), 'utf8'), 'skill\n')
  assert.strictEqual(readFileSync(join(paths.home, '.codex', 'config.toml'), 'utf8'), '[features]\n')
  assert.strictEqual(readFileSync(join(paths.home, '.claude', 'settings.json'), 'utf8'), '{"theme":"dark"}\n')
  assert.strictEqual(readFileSync(join(paths.home, '.claude.json'), 'utf8'), '{"mcpServers":{}}\n')
  assert.strictEqual(readFileSync(paths.marker, 'utf8'), 'full\n')
})

test('source trees remain byte-for-byte unchanged after bootstrap and canonical writes', () => {
  const paths = roots('source-immutable')
  writeSourceFile(paths.source, 'agents/notes.txt', 'source notes\n')
  writeSourceFile(paths.source, 'codex/config.toml', 'source codex\n')
  writeSourceFile(paths.source, 'claude/settings.json', 'source claude\n')
  writeSourceFile(paths.source, 'claude-config.json', 'source config\n')
  const before = treeSnapshot(paths.source)

  const result = runBootstrap('full', paths)
  assertSucceeded(result)
  writeFileSync(join(paths.home, '.agents', 'notes.txt'), 'container notes\n')
  writeFileSync(join(paths.home, '.codex', 'config.toml'), 'container codex\n')
  writeFileSync(join(paths.home, '.claude', 'settings.json'), 'container claude\n')
  writeFileSync(join(paths.home, '.claude.json'), 'container config\n')

  assert.deepStrictEqual(treeSnapshot(paths.source), before)
})

test('two homes copied from one source are independently writable', () => {
  const sharedRoot = tempDir('independent')
  const source = join(sharedRoot, 'source')
  const first = { source, home: join(sharedRoot, 'home-one'), marker: join(sharedRoot, 'state-one', 'agent-profile') }
  const second = { source, home: join(sharedRoot, 'home-two'), marker: join(sharedRoot, 'state-two', 'agent-profile') }
  writeSourceFile(source, 'agents/shared.txt', 'shared\n')

  assertSucceeded(runBootstrap('auth', first))
  assertSucceeded(runBootstrap('auth', second))
  writeFileSync(join(first.home, '.agents', 'shared.txt'), 'first\n')

  assert.strictEqual(readFileSync(join(second.home, '.agents', 'shared.txt'), 'utf8'), 'shared\n')
  assert.strictEqual(readFileSync(join(source, 'agents', 'shared.txt'), 'utf8'), 'shared\n')
})

test('relative and absolute symlinks remain links without copying their targets', () => {
  const paths = roots('symlinks')
  const external = join(tempDir('external'), 'secret.txt')
  writeFileSync(external, 'external secret\n')
  writeSourceFile(paths.source, 'agents/local.txt', 'local\n')
  symlinkSync('local.txt', join(paths.source, 'agents', 'relative-link'))
  symlinkSync(external, join(paths.source, 'agents', 'absolute-link'))

  const result = runBootstrap('auth', paths)

  assertSucceeded(result)
  const relativeLink = join(paths.home, '.agents', 'relative-link')
  const absoluteLink = join(paths.home, '.agents', 'absolute-link')
  assert.strictEqual(lstatSync(relativeLink).isSymbolicLink(), true)
  assert.strictEqual(readlinkSync(relativeLink), 'local.txt')
  assert.strictEqual(lstatSync(absoluteLink).isSymbolicLink(), true)
  assert.strictEqual(readlinkSync(absoluteLink), external)
})

test('special files are skipped with logical, secret-safe warnings', {
  skip: process.platform === 'win32'
}, () => {
  const paths = roots('fifo')
  const fifo = join(paths.source, 'agents', 'private-pipe')
  mkdirSync(join(paths.source, 'agents'), { recursive: true })
  execFileSync('mkfifo', [fifo])

  const result = runBootstrap('auth', paths)

  assertSucceeded(result)
  assert.match(result.stderr, /agent-profile-bootstrap:.*~\/\.agents.*private-pipe/)
  assert.ok(!result.stderr.includes(paths.source))
  assert.strictEqual(lstatSync(join(paths.home, '.agents', 'private-pipe'), { throwIfNoEntry: false }), undefined)
})

test('missing sources are non-fatal', () => {
  const paths = roots('missing')

  const result = runBootstrap('full', paths)

  assertSucceeded(result)
  assert.deepStrictEqual(readdirSync(paths.home), [])
  assert.strictEqual(readFileSync(paths.marker, 'utf8'), 'full\n')
})

test('an unreadable credential is a non-fatal warning when reproducible', {
  skip: typeof process.getuid !== 'function' || process.getuid() === 0
}, () => {
  const paths = roots('unreadable-credential')
  const credential = writeSourceFile(paths.source, 'codex-auth.json', '{"token":"secret"}\n')
  mkdirSync(join(paths.home, '.codex'), { recursive: true })
  writeFileSync(join(paths.home, '.codex', 'auth.json'), '{"token":"stale"}\n')
  chmodSync(credential, 0o000)
  try {
    const result = runBootstrap('auth', paths)

    assertSucceeded(result)
    assert.match(result.stderr, /agent-profile-bootstrap:.*\$CODEX_HOME/)
    assert.doesNotMatch(result.stderr, /secret/)
    assert.strictEqual(lstatSync(join(paths.home, '.codex', 'auth.json'), { throwIfNoEntry: false }), undefined)
    assert.strictEqual(readFileSync(paths.marker, 'utf8'), 'auth\n')
  } finally {
    chmodSync(credential, 0o600)
  }
})

test('a failed required directory copy preserves the previous destination and omits the marker', {
  skip: typeof process.getuid !== 'function' || process.getuid() === 0
}, () => {
  const paths = roots('failed-required-copy')
  const blocked = join(paths.source, 'agents', 'blocked')
  mkdirSync(blocked, { recursive: true })
  writeSourceFile(blocked, 'secret.txt', 'secret\n')
  mkdirSync(join(paths.home, '.agents'), { recursive: true })
  writeFileSync(join(paths.home, '.agents', 'sentinel.txt'), 'previous\n')
  mkdirSync(join(paths.marker, '..'), { recursive: true })
  writeFileSync(paths.marker, 'auth\n')
  chmodSync(blocked, 0o000)
  try {
    const result = runBootstrap('auth', paths)

    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /agent-profile-bootstrap:.*~\/\.agents/)
    assert.doesNotMatch(result.stderr, /secret/)
    assert.strictEqual(readFileSync(join(paths.home, '.agents', 'sentinel.txt'), 'utf8'), 'previous\n')
    assert.strictEqual(lstatSync(paths.marker, { throwIfNoEntry: false }), undefined)
    assert.deepStrictEqual(
      readdirSync(paths.home).filter(name => name.includes('boxdown-agent-profile')),
      []
    )
  } finally {
    chmodSync(blocked, 0o700)
  }
})

test('a marker invalidation failure stops before profile copies begin', {
  skip: typeof process.getuid !== 'function' || process.getuid() === 0
}, () => {
  const paths = roots('failed-marker-invalidation')
  const markerParent = join(paths.marker, '..')
  writeSourceFile(paths.source, 'agents/new.txt', 'new profile\n')
  mkdirSync(join(paths.home, '.agents'), { recursive: true })
  writeFileSync(join(paths.home, '.agents', 'sentinel.txt'), 'previous\n')
  mkdirSync(markerParent, { recursive: true })
  writeFileSync(paths.marker, 'auth\n')
  chmodSync(markerParent, 0o500)
  try {
    const result = runBootstrap('auth', paths)

    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /agent-profile-bootstrap: failed to invalidate agent profile marker/)
    assert.ok(!result.stderr.includes(markerParent))
    assert.strictEqual(readFileSync(join(paths.home, '.agents', 'sentinel.txt'), 'utf8'), 'previous\n')
    assert.strictEqual(lstatSync(join(paths.home, '.agents', 'new.txt'), { throwIfNoEntry: false }), undefined)
  } finally {
    chmodSync(markerParent, 0o700)
  }
})

test('failure to clear a stale canonical credential fails closed', {
  skip: typeof process.getuid !== 'function' || process.getuid() === 0
}, () => {
  const paths = roots('failed-stale-credential-removal')
  const credential = writeSourceFile(paths.source, 'codex-auth.json', '{"token":"secret"}\n')
  const codexHome = join(paths.home, '.codex')
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(join(codexHome, 'auth.json'), '{"token":"stale"}\n')
  chmodSync(credential, 0o000)
  chmodSync(codexHome, 0o500)
  try {
    const result = runBootstrap('auth', paths)

    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /agent-profile-bootstrap:.*\$CODEX_HOME/)
    assert.doesNotMatch(result.stderr, /secret|stale/)
    assert.ok(!result.stderr.includes(codexHome))
    assert.strictEqual(readFileSync(join(codexHome, 'auth.json'), 'utf8'), '{"token":"stale"}\n')
    assert.strictEqual(lstatSync(paths.marker, { throwIfNoEntry: false }), undefined)
  } finally {
    chmodSync(codexHome, 0o700)
    chmodSync(credential, 0o600)
  }
})

test('an absent staged source leaves a custom-destination sentinel unchanged', () => {
  const paths = roots('custom-destination')
  mkdirSync(join(paths.home, '.codex'), { recursive: true })
  writeFileSync(join(paths.home, '.codex', 'custom-sentinel'), 'custom mount\n')

  const result = runBootstrap('full', paths)

  assertSucceeded(result)
  assert.strictEqual(readFileSync(join(paths.home, '.codex', 'custom-sentinel'), 'utf8'), 'custom mount\n')
})

test('copied modes are writable by and owned by the current user while preserving executable bits', {
  skip: process.platform === 'win32'
}, () => {
  const paths = roots('modes')
  const sourceDir = join(paths.source, 'agents')
  const sourceFile = writeSourceFile(paths.source, 'agents/tool.sh', '#!/bin/sh\n')
  chmodSync(sourceFile, 0o555)
  chmodSync(sourceDir, 0o500)

  const result = runBootstrap('auth', paths)

  assertSucceeded(result)
  const copiedDir = statSync(join(paths.home, '.agents'))
  const copiedFile = statSync(join(paths.home, '.agents', 'tool.sh'))
  assert.strictEqual(copiedDir.mode & 0o777, 0o700)
  assert.strictEqual(copiedFile.mode & 0o777, 0o755)
  assert.strictEqual(copiedDir.uid, process.getuid?.())
  assert.strictEqual(copiedFile.uid, process.getuid?.())
})

test('only a truly absent profile variable defaults to auth', () => {
  const defaulted = roots('default-profile')
  writeSourceFile(defaulted.source, 'codex-auth.json', '{}\n')
  const defaultResult = runBootstrap(undefined, defaulted)
  assertSucceeded(defaultResult)
  assert.strictEqual(readFileSync(defaulted.marker, 'utf8'), 'auth\n')

  for (const invalid of ['', 'other']) {
    const paths = roots(`invalid-${invalid || 'empty'}`)
    const result = runBootstrap(invalid, paths)
    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /agent-profile-bootstrap: invalid agent profile/)
    assert.strictEqual(lstatSync(paths.marker, { throwIfNoEntry: false }), undefined)
  }
})

test('marker failures report no override path details', () => {
  const paths = roots('private-marker-diagnostic')
  const blockedParent = join(paths.home, 'private-marker-secret')
  mkdirSync(paths.home, { recursive: true })
  writeFileSync(blockedParent, 'not a directory\n')
  paths.marker = join(blockedParent, 'agent-profile')

  const result = runBootstrap('none', paths)

  assert.notStrictEqual(result.status, 0)
  assert.match(result.stderr, /agent-profile-bootstrap: failed to invalidate agent profile marker/)
  assert.doesNotMatch(result.stderr, /private-marker-secret/)
})
