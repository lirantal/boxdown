import assert from 'node:assert'
import { test } from 'node:test'

import {
  BOXDOWN_CONTAINER_AGENTS_DIR,
  BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH,
  BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH,
  BOXDOWN_CONTAINER_CLAUDE_DIR,
  BOXDOWN_CONTAINER_CODEX_AUTH_PATH,
  BOXDOWN_CONTAINER_CODEX_DIR,
  BOXDOWN_CONTAINER_GITCONFIG_PATH
} from '../src/constants.ts'
import {
  mountConflictsWithDestination,
  mountTargetsDestination,
  normalizedMountDestinations
} from '../src/devcontainer-mount.ts'

const canonicalProfileDestinations = [
  BOXDOWN_CONTAINER_AGENTS_DIR,
  BOXDOWN_CONTAINER_CODEX_DIR,
  BOXDOWN_CONTAINER_CODEX_AUTH_PATH,
  BOXDOWN_CONTAINER_CLAUDE_DIR,
  BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH,
  BOXDOWN_CONTAINER_CLAUDE_CONFIG_PATH
] as const

function assertConflictsWithEveryProfileDestination (mount: unknown): void {
  for (const destination of canonicalProfileDestinations) {
    assert.strictEqual(
      mountConflictsWithDestination(mount, destination),
      true,
      `expected fail-closed conflict with ${destination}`
    )
  }
}

test('decodes Docker RFC-4180 mount fields before reading destination aliases', () => {
  const mount = 'type=tmpfs,"source=/tmp/source ""quoted"",with-comma","dst=/home/node/.codex/cache ""quoted"",with-comma"'

  assert.deepStrictEqual(normalizedMountDestinations(mount), [
    '/home/node/.codex/cache "quoted",with-comma'
  ])
  assert.strictEqual(
    mountConflictsWithDestination(mount, BOXDOWN_CONTAINER_CODEX_DIR),
    true
  )
})

test('matches decoded destination aliases case-insensitively and retains every repeated alias', () => {
  const mount = 'type=bind, target=/var/lib/unrelated ,"DST=/home/node/.codex",DESTINATION=/home/node/.claude'

  assert.deepStrictEqual(normalizedMountDestinations(mount), [
    '/var/lib/unrelated',
    BOXDOWN_CONTAINER_CODEX_DIR,
    BOXDOWN_CONTAINER_CLAUDE_DIR
  ])
  assert.strictEqual(
    mountConflictsWithDestination(mount, BOXDOWN_CONTAINER_CODEX_DIR),
    true
  )
  assert.strictEqual(
    mountConflictsWithDestination(mount, BOXDOWN_CONTAINER_CLAUDE_DIR),
    true
  )

  const lastAliasIsUnrelated = 'type=bind,target=/home/node/.codex,target=/var/lib/unrelated'
  assert.strictEqual(
    mountConflictsWithDestination(lastAliasIsUnrelated, BOXDOWN_CONTAINER_CODEX_DIR),
    true,
    'an earlier conflicting alias must win the policy check even when Docker uses the last alias'
  )
})

test('fails closed for every profile destination on any malformed CSV mount', () => {
  const mounts = [
    'type=bind,"source=/tmp',
    'type=bind,source=/tmp"broken",dst=/var/lib/unrelated',
    '"type=bind""unterminated'
  ]

  for (const mount of mounts) {
    assert.deepStrictEqual(normalizedMountDestinations(mount), [])
    assertConflictsWithEveryProfileDestination(mount)
    assert.strictEqual(
      mountTargetsDestination(mount, BOXDOWN_CONTAINER_GITCONFIG_PATH),
      false,
      'uncertain user input must not be removed by exact-target filtering'
    )
  }
})

test('fails closed when an unresolved substitution can change string mount grammar or destination', () => {
  const mounts = [
    'type=bind,source=/tmp,target=${localEnv:PROFILE_DESTINATION}',
    'type=bind,source=${localWorkspaceFolder}',
    '${localEnv:CUSTOM_MOUNT_FIELD}',
    'type=bind,"source=${containerWorkspaceFolder}",target=/var/lib/unrelated'
  ]

  for (const mount of mounts) {
    assertConflictsWithEveryProfileDestination(mount)
  }

  const uncertainGitconfig = 'type=bind,source=${localEnv:SOURCE},target=/home/node/.gitconfig'
  assertConflictsWithEveryProfileDestination(uncertainGitconfig)
  assert.strictEqual(
    mountTargetsDestination(uncertainGitconfig, BOXDOWN_CONTAINER_GITCONFIG_PATH),
    false,
    'a known target on an otherwise uncertain string mount must remain user-owned'
  )
})

test('fails closed only for structured destination substitutions', () => {
  const uncertainDestinations = [
    {
      type: 'bind',
      source: '/tmp/profile',
      target: '${localEnv:PROFILE_DESTINATION}'
    },
    {
      type: 'bind',
      src: '/tmp/profile',
      dst: '${containerWorkspaceFolder}/.codex'
    },
    {
      type: 'bind',
      source: '/tmp/profile',
      destination: '${workspaceFolder}/.claude'
    }
  ]

  for (const mount of uncertainDestinations) {
    assertConflictsWithEveryProfileDestination(mount)
  }

  const sourceOnlySubstitution = {
    type: 'bind',
    source: '${localEnv:PROFILE_SOURCE}',
    target: '/var/lib/unrelated'
  }
  for (const destination of canonicalProfileDestinations) {
    assert.strictEqual(
      mountConflictsWithDestination(sourceOnlySubstitution, destination),
      false,
      `source-only substitution must not claim ${destination}`
    )
  }
})
