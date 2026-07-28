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
  inspectDevcontainerMount,
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

test('fails closed when any structured serialized field contains unresolved substitution', () => {
  const mounts = [
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
    },
    {
      type: 'bind',
      source: '${localEnv:PROFILE_SOURCE}',
      target: '/var/lib/unrelated'
    },
    {
      type: '${localEnv:MOUNT_TYPE}',
      source: '/tmp/profile',
      target: '/var/lib/unrelated'
    }
  ]

  for (const mount of mounts) {
    assertConflictsWithEveryProfileDestination(mount)
  }
})

test('fails closed on structured CSV injection and control characters', () => {
  const mounts = [
    {
      type: 'bind',
      source: '/tmp/profile,target=/home/node/.codex',
      target: '/var/lib/unrelated'
    },
    {
      type: 'bind,dst=/home/node/.codex',
      source: '/tmp/profile',
      target: '/var/lib/unrelated'
    },
    {
      type: 'tmpfs',
      target: '/var/lib/unrelated,dst=/home/node/.codex'
    },
    {
      type: 'bind"',
      source: '/tmp/profile',
      target: '/var/lib/unrelated'
    },
    {
      type: 'bind\r',
      source: '/tmp/profile',
      target: '/var/lib/unrelated'
    },
    {
      type: 'bind',
      source: '/tmp/profile\ninjected',
      target: '/var/lib/unrelated'
    },
    {
      type: 'bind',
      source: '/tmp/profile',
      target: '/var/lib/unrelated\0dst=/home/node/.codex'
    }
  ]

  for (const mount of mounts) {
    assertConflictsWithEveryProfileDestination(mount)
  }
})

test('fails closed on non-string structured serialized fields', () => {
  const mounts = [
    {
      type: 42,
      source: '/tmp/profile',
      target: '/var/lib/unrelated'
    },
    {
      type: 'bind',
      source: {
        path: '/tmp/profile'
      },
      target: '/var/lib/unrelated'
    },
    {
      type: 'bind',
      source: '/tmp/profile',
      target: ['/var/lib/unrelated']
    }
  ]

  for (const mount of mounts) {
    assertConflictsWithEveryProfileDestination(mount)
  }
})

test('matches structured aliases case-insensitively and retains safe destinations while uncertain', () => {
  const mount = {
    TyPe: 'bind',
    SoUrCe: '/tmp/profile,target=/home/node/.agents',
    TARGET: BOXDOWN_CONTAINER_CODEX_DIR,
    destination: BOXDOWN_CONTAINER_CLAUDE_DIR,
    arbitrary: {
      preserve: true,
      serializedLooking: 'target=/home/node/.agents,${localEnv:OPAQUE}'
    }
  }
  const original = structuredClone(mount)

  assert.deepStrictEqual(inspectDevcontainerMount(mount), {
    destinations: [
      BOXDOWN_CONTAINER_CODEX_DIR,
      BOXDOWN_CONTAINER_CLAUDE_DIR
    ],
    destinationIndeterminate: true
  })
  assert.deepStrictEqual(mount, original)
  assertConflictsWithEveryProfileDestination(mount)
})

test('ignores opaque structured metadata that Dev Containers does not serialize as mount grammar', () => {
  const mount = {
    type: 'bind',
    source: '/tmp/profile',
    target: '/var/lib/unrelated',
    arbitrary: {
      value: 'target=/home/node/.codex,${localEnv:OPAQUE}',
      quote: '"',
      nul: '\0'
    }
  }
  const original = structuredClone(mount)

  assert.deepStrictEqual(inspectDevcontainerMount(mount), {
    destinations: ['/var/lib/unrelated'],
    destinationIndeterminate: false
  })
  assert.deepStrictEqual(mount, original)
  for (const destination of canonicalProfileDestinations) {
    assert.strictEqual(
      mountConflictsWithDestination(mount, destination),
      false,
      `opaque metadata must not claim ${destination}`
    )
  }
})
