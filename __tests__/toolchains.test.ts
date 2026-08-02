import assert from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { TOOLCHAIN_DEFAULTS } from '../src/toolchains/defaults.ts'
import { detectToolchains, resolveDetectedVersion } from '../src/toolchains/detect.ts'

function withWorkspace (run: (workspace: string) => void): void {
  const workspace = mkdtempSync(join(tmpdir(), 'boxdown-toolchains-'))

  try {
    run(workspace)
  } finally {
    rmSync(workspace, {recursive: true, force: true})
  }
}

test('detects a Volta Node pin ahead of engines and lockfile evidence', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({
      volta: {node: '24.17.0'},
      engines: {node: '>=22'}
    }))
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')

    assert.deepStrictEqual(detectToolchains(workspace), [{
      id: 'node',
      exactVersion: '24.17.0',
      constraint: '>=22',
      evidence: [
        {path: 'package.json', source: 'volta.node', value: '24.17.0', exact: true},
        {path: 'package.json', source: 'engines.node', value: '>=22', exact: false},
        {path: 'pnpm-lock.yaml', source: 'lockfile', value: 'pnpm', exact: false}
      ]
    }])
  })
})

test('uses a compatible default only when the constraint accepts it', () => {
  const compatible = resolveDetectedVersion({
    id: 'python',
    constraint: '>=3.11',
    evidence: [{path: 'pyproject.toml', source: 'requires-python', value: '>=3.11', exact: false}]
  })
  assert.strictEqual(compatible.kind, 'resolved')
  assert.strictEqual(compatible.version, '3.14.6')

  const incompatible = resolveDetectedVersion({
    id: 'python',
    constraint: '<3.12',
    evidence: [{path: 'pyproject.toml', source: 'requires-python', value: '<3.12', exact: false}]
  })
  assert.deepStrictEqual(incompatible, {
    kind: 'incompatible-default',
    defaultVersion: '3.14.6',
    constraint: '<3.12'
  })
})

test('detects Go toolchain and Rust channel files as exact declarations', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'go.mod'), 'module example.com/app\n\ntoolchain go1.26.5\n')
    writeFileSync(join(workspace, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.97.1"\n')

    const detections = detectToolchains(workspace)
    assert.strictEqual(detections.find(item => item.id === 'go')?.exactVersion, '1.26.5')
    assert.strictEqual(detections.find(item => item.id === 'rust')?.exactVersion, '1.97.1')
  })
})

test('keeps contradictory Go and Rust exact pins unresolved', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'go.mod'), 'module example.com/app\n\ntoolchain go1.26.5\n')
    writeFileSync(join(workspace, '.go-version'), '1.25.0\n')
    writeFileSync(join(workspace, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.97.1"\n')
    writeFileSync(join(workspace, 'rust-toolchain'), '1.96.0\n')

    const detections = detectToolchains(workspace)
    for (const id of ['go', 'rust'] as const) {
      const detection = detections.find(item => item.id === id)
      assert.strictEqual(detection?.exactVersion, undefined)
      assert.match(detection?.diagnostics?.[0]?.message ?? '', /conflicting/i)
      assert.deepStrictEqual(resolveDetectedVersion(detection!), {
        kind: 'unchecked',
        defaultVersion: TOOLCHAIN_DEFAULTS[id].version
      })
    }
  })
})

test('detects exact versions from individual version files', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, '.nvmrc'), 'v24.17.0\n')
    writeFileSync(join(workspace, '.python-version'), '3.14.6\n')
    writeFileSync(join(workspace, '.go-version'), '1.26.5\n')
    writeFileSync(join(workspace, 'rust-toolchain'), '1.97.1\n')

    assert.deepStrictEqual(detectToolchains(workspace).map(item => [item.id, item.exactVersion]), [
      ['node', '24.17.0'],
      ['python', '3.14.6'],
      ['go', '1.26.5'],
      ['rust', '1.97.1']
    ])
  })
})

test('uses supported .tool-versions names and ignores unsupported names', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, '.tool-versions'), [
      'nodejs 24.17.0',
      'python 3.14.6',
      'golang 1.26.5',
      'rust 1.97.1',
      'ruby 3.4.0'
    ].join('\n'))

    assert.deepStrictEqual(detectToolchains(workspace).map(item => [item.id, item.exactVersion]), [
      ['node', '24.17.0'],
      ['python', '3.14.6'],
      ['go', '1.26.5'],
      ['rust', '1.97.1']
    ])
  })
})

test('normalizes Go and Cargo minimum-version declarations', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'go.mod'), 'module example.com/app\n\ngo 1.26\n')
    writeFileSync(join(workspace, 'Cargo.toml'), '[package]\nrust-version = "1.97"\n')

    assert.deepStrictEqual(detectToolchains(workspace), [
      {
        id: 'go',
        constraint: '>=1.26',
        evidence: [{path: 'go.mod', source: 'go', value: '1.26', exact: false}]
      },
      {
        id: 'rust',
        constraint: '>=1.97',
        evidence: [{path: 'Cargo.toml', source: 'package.rust-version', value: '1.97', exact: false}]
      }
    ])
  })
})

test('supports Node comparator, caret, tilde, and joined constraints', () => {
  for (const constraint of ['>=22 <25', '^24.17.0', '~24.17', '>=24.17.0, <25']) {
    const resolution = resolveDetectedVersion({
      id: 'node',
      constraint,
      evidence: [{path: 'package.json', source: 'engines.node', value: constraint, exact: false}]
    })

    assert.strictEqual(resolution.kind, 'resolved', constraint)
    assert.strictEqual(resolution.version, '24.17.0', constraint)
  }
})

test('keeps unsupported constraints visible and unchecked with a diagnostic', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({engines: {node: '>=22 || <18'}}))

    const node = detectToolchains(workspace)[0]
    assert.strictEqual(node?.constraint, undefined)
    assert.deepStrictEqual(node?.evidence, [
      {path: 'package.json', source: 'engines.node', value: '>=22 || <18', exact: false}
    ])
    assert.match(node?.diagnostics?.[0]?.message ?? '', /unsupported/i)
    assert.deepStrictEqual(resolveDetectedVersion(node!), {
      kind: 'unchecked',
      defaultVersion: '24.17.0'
    })
  })
})

test('rejects wildcard, prerelease, and unsupported PEP 440 constraints', () => {
  for (const constraint of ['3.14.*', '>=3.14.0-rc.1', '~=3.14']) {
    withWorkspace(workspace => {
      writeFileSync(join(workspace, 'pyproject.toml'), `[project]\nrequires-python = "${constraint}"\n`)

      const python = detectToolchains(workspace)[0]
      assert.strictEqual(python?.constraint, undefined, constraint)
      assert.match(python?.diagnostics?.[0]?.message ?? '', /unsupported/i, constraint)
      assert.deepStrictEqual(resolveDetectedVersion(python!), {
        kind: 'unchecked',
        defaultVersion: '3.14.6'
      }, constraint)
    })
  }
})

test('keeps repeated TOML constraints unchecked instead of selecting the first declaration', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'pyproject.toml'), [
      '[project]',
      'requires-python = ">=3.11"',
      'requires-python = "<3.12"'
    ].join('\n'))
    writeFileSync(join(workspace, 'Cargo.toml'), [
      '[package]',
      'rust-version = "1.90"',
      'rust-version = "1.98"'
    ].join('\n'))

    for (const id of ['python', 'rust'] as const) {
      const detection = detectToolchains(workspace).find(item => item.id === id)
      assert.strictEqual(detection?.constraint, undefined, id)
      assert.match(detection?.diagnostics?.[0]?.message ?? '', /conflicting/i, id)
      assert.deepStrictEqual(resolveDetectedVersion(detection!), {
        kind: 'unchecked',
        defaultVersion: TOOLCHAIN_DEFAULTS[id].version
      }, id)
    }
  })
})

test('rejects empty comma clauses in a version constraint', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'pyproject.toml'), '[project]\nrequires-python = ">=3.11,,<4"\n')

    const python = detectToolchains(workspace)[0]
    assert.strictEqual(python?.constraint, undefined)
    assert.match(python?.diagnostics?.[0]?.message ?? '', /unsupported/i)
    assert.deepStrictEqual(resolveDetectedVersion(python!), {
      kind: 'unchecked',
      defaultVersion: '3.14.6'
    })
  })
})

test('returns diagnostics for structurally malformed known marker declarations', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, '.tool-versions'), 'nodejs\npython 3.14.6 extra\n')
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({
      volta: {node: 24},
      engines: {node: 24}
    }))
    writeFileSync(join(workspace, 'pyproject.toml'), '[project]\nrequires-python =\n')
    writeFileSync(join(workspace, 'go.mod'), 'module example.com/app\n\ngo bananas\n')
    writeFileSync(join(workspace, 'rust-toolchain.toml'), '[toolchain]\nchannel =\n')
    writeFileSync(join(workspace, 'Cargo.toml'), '[package]\nrust-version =\n')

    const detections = detectToolchains(workspace)

    for (const id of ['node', 'python', 'go', 'rust'] as const) {
      const detection = detections.find(item => item.id === id)
      assert.ok(detection?.diagnostics?.length, id)
      assert.deepStrictEqual(resolveDetectedVersion(detection!), {
        kind: 'unchecked',
        defaultVersion: TOOLCHAIN_DEFAULTS[id].version
      }, id)
    }
  })
})

test('keeps duplicate and conflicting exact pins unresolved', () => {
  for (const [first, second, message] of [
    ['24.17.0', '24.17.0', /repeated/i],
    ['24.17.0', '23.10.0', /conflicting/i]
  ]) {
    withWorkspace(workspace => {
      writeFileSync(join(workspace, '.nvmrc'), `${first}\n`)
      writeFileSync(join(workspace, '.node-version'), `${second}\n`)

      const node = detectToolchains(workspace)[0]
      assert.strictEqual(node?.exactVersion, undefined)
      assert.match(node?.diagnostics?.[0]?.message ?? '', message)
      assert.deepStrictEqual(resolveDetectedVersion(node!), {
        kind: 'unchecked',
        defaultVersion: '24.17.0'
      })
    })
  }
})

test('keeps repeated identical exact declarations in one marker file unresolved', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'rust-toolchain.toml'), [
      '[toolchain]',
      'channel = "1.97.1"',
      'channel = "1.97.1"'
    ].join('\n'))

    const rust = detectToolchains(workspace)[0]
    assert.strictEqual(rust?.exactVersion, undefined)
    assert.match(rust?.diagnostics?.[0]?.message ?? '', /repeated/i)
    assert.deepStrictEqual(resolveDetectedVersion(rust!), {
      kind: 'unchecked',
      defaultVersion: '1.97.1'
    })
  })
})

test('keeps an exact pin unresolved when a project constraint excludes it', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({
      volta: {node: '24.17.0'},
      engines: {node: '<20'}
    }))

    const node = detectToolchains(workspace)[0]
    assert.strictEqual(node?.exactVersion, undefined)
    assert.strictEqual(node?.constraint, undefined)
    assert.match(node?.diagnostics?.[0]?.message ?? '', /incompatible/i)
    assert.deepStrictEqual(resolveDetectedVersion(node!), {
      kind: 'unchecked',
      defaultVersion: '24.17.0'
    })
  })
})

test('diagnoses duplicate JSONC runtime declarations before JSON parsing collapses them', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'package.json'), `{
      // The quoted key in this comment must not count: "engines"
      "volta": {"node": "24.17.0"},
      "engines": {
        "node": ">=22",
        "node": "<20"
      }
    }`)

    const node = detectToolchains(workspace)[0]
    assert.strictEqual(node?.exactVersion, undefined)
    assert.strictEqual(node?.constraint, undefined)
    assert.match(node?.diagnostics?.map(item => item.message).join('\n') ?? '', /repeated.*engines\.node/i)
    assert.match(node?.diagnostics?.map(item => item.message).join('\n') ?? '', /incompatible/i)
    assert.deepStrictEqual(resolveDetectedVersion(node!), {
      kind: 'unchecked',
      defaultVersion: '24.17.0'
    })
  })
})

test('diagnoses invalid package.json containers and unreadable marker paths', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({
      volta: '24.17.0',
      engines: []
    }))

    const node = detectToolchains(workspace)[0]
    assert.match(node?.diagnostics?.map(item => item.message).join('\n') ?? '', /volta.*object/i)
    assert.match(node?.diagnostics?.map(item => item.message).join('\n') ?? '', /engines.*object/i)
    assert.deepStrictEqual(resolveDetectedVersion(node!), {
      kind: 'unchecked',
      defaultVersion: '24.17.0'
    })
  })

  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'package.json'), '"not an object"')

    const node = detectToolchains(workspace)[0]
    assert.match(node?.diagnostics?.[0]?.message ?? '', /object/i)
  })

  withWorkspace(workspace => {
    mkdirSync(join(workspace, 'package.json'))

    const node = detectToolchains(workspace)[0]
    assert.match(node?.diagnostics?.[0]?.message ?? '', /unable to read/i)
    assert.deepStrictEqual(resolveDetectedVersion(node!), {
      kind: 'unchecked',
      defaultVersion: '24.17.0'
    })
  })

  withWorkspace(workspace => {
    symlinkSync('missing-package.json', join(workspace, 'package.json'))

    const node = detectToolchains(workspace)[0]
    assert.match(node?.diagnostics?.[0]?.message ?? '', /unable to read/i)
    assert.deepStrictEqual(resolveDetectedVersion(node!), {
      kind: 'unchecked',
      defaultVersion: '24.17.0'
    })
  })
})

test('parses relevant TOML sections with trailing comments', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'pyproject.toml'), '[project] # workspace metadata\nrequires-python = ">=3.11"\n')
    writeFileSync(join(workspace, 'rust-toolchain.toml'), '[toolchain] # rust settings\nchannel = "1.97.1"\n')
    writeFileSync(join(workspace, 'Cargo.toml'), '[package] # crate metadata\nrust-version = "1.97"\n')

    const detections = detectToolchains(workspace)
    assert.strictEqual(detections.find(item => item.id === 'python')?.constraint, '>=3.11')
    assert.strictEqual(detections.find(item => item.id === 'rust')?.exactVersion, '1.97.1')
    assert.strictEqual(detections.find(item => item.id === 'rust')?.constraint, '>=1.97')
  })
})

test('diagnoses repeated relevant TOML section headers', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'pyproject.toml'), '[project]\nrequires-python = ">=3.11"\n[project]\n')
    writeFileSync(join(workspace, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.97.1"\n[toolchain]\n')
    writeFileSync(join(workspace, 'Cargo.toml'), '[package]\nrust-version = "1.97"\n[package]\n')

    for (const id of ['python', 'rust'] as const) {
      const detection = detectToolchains(workspace).find(item => item.id === id)
      assert.match(detection?.diagnostics?.map(item => item.message).join('\n') ?? '', /repeated.*section/i, id)
      assert.deepStrictEqual(resolveDetectedVersion(detection!), {
        kind: 'unchecked',
        defaultVersion: TOOLCHAIN_DEFAULTS[id].version
      }, id)
    }
  })
})

test('accepts Node zero-major caret ranges with a partial zero version', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({
      volta: {node: '0.5.0'},
      engines: {node: '^0'}
    }))

    const node = detectToolchains(workspace)[0]
    assert.strictEqual(node?.exactVersion, '0.5.0')
    assert.strictEqual(node?.constraint, '^0')
    assert.strictEqual(node?.diagnostics, undefined)
    assert.deepStrictEqual(resolveDetectedVersion(node!), {
      kind: 'resolved',
      version: '0.5.0',
      source: 'project'
    })
  })
})

test('supports Node shorthand ranges joined with AND clauses', () => {
  for (const [version, constraint] of [
    ['24.17.0', '^24.0 <25'],
    ['24.17.1', '~24.17 >=24.17.1']
  ]) {
    withWorkspace(workspace => {
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({
        volta: {node: version},
        engines: {node: constraint}
      }))

      const node = detectToolchains(workspace)[0]
      assert.strictEqual(node?.exactVersion, version, constraint)
      assert.strictEqual(node?.constraint, constraint, constraint)
      assert.deepStrictEqual(resolveDetectedVersion(node!), {
        kind: 'resolved',
        version,
        source: 'project'
      }, constraint)
    })
  }
})

test('resets TOML runtime context for dotted and array table headers', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'pyproject.toml'), [
      '[project]',
      'requires-python = ">=3.11"',
      '[tool."example]name"]',
      'requires-python = "<3"',
      '[tool.example]',
      'requires-python = "<3"'
    ].join('\n'))
    writeFileSync(join(workspace, 'rust-toolchain.toml'), [
      '[toolchain]',
      'channel = "1.97.1"',
      '[[tool.example]]',
      'channel = "1.96.0"'
    ].join('\n'))
    writeFileSync(join(workspace, 'Cargo.toml'), [
      '[package]',
      'rust-version = "1.97"',
      '[package.metadata]',
      'rust-version = "1.96"'
    ].join('\n'))

    const detections = detectToolchains(workspace)
    assert.strictEqual(detections.find(item => item.id === 'python')?.constraint, '>=3.11')
    const rust = detections.find(item => item.id === 'rust')
    assert.strictEqual(rust?.exactVersion, '1.97.1')
    assert.strictEqual(rust?.constraint, '>=1.97')
    assert.strictEqual(rust?.diagnostics, undefined)
  })
})

test('diagnoses an empty rust-toolchain.toml marker', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'rust-toolchain.toml'), ' \n\t')

    const rust = detectToolchains(workspace)[0]
    assert.strictEqual(rust?.exactVersion, undefined)
    assert.match(rust?.diagnostics?.[0]?.message ?? '', /empty/i)
    assert.deepStrictEqual(resolveDetectedVersion(rust!), {
      kind: 'unchecked',
      defaultVersion: '1.97.1'
    })
  })
})

test('rejects relevant TOML array and malformed headers without parsing later keys', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'pyproject.toml'), [
      '[project]',
      '[project] junk',
      'requires-python = ">=3.11"'
    ].join('\n'))
    writeFileSync(join(workspace, 'rust-toolchain.toml'), [
      '[[toolchain]]',
      'channel = "1.97.1"'
    ].join('\n'))
    writeFileSync(join(workspace, 'Cargo.toml'), [
      '[[package]]',
      'rust-version = "1.97"'
    ].join('\n'))

    for (const id of ['python', 'rust'] as const) {
      const detection = detectToolchains(workspace).find(item => item.id === id)
      assert.strictEqual(detection?.exactVersion, undefined, id)
      assert.strictEqual(detection?.constraint, undefined, id)
      assert.match(detection?.diagnostics?.map(item => item.message).join('\n') ?? '', /(?:malformed|unsupported).*(?:project|toolchain|package).*section/i, id)
      assert.deepStrictEqual(resolveDetectedVersion(detection!), {
        kind: 'unchecked',
        defaultVersion: TOOLCHAIN_DEFAULTS[id].version
      }, id)
    }
  })
})

test('diagnoses unterminated relevant TOML array headers', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'pyproject.toml'), '[[project]\nrequires-python = ">=3.11"\n')
    writeFileSync(join(workspace, 'rust-toolchain.toml'), '[[toolchain]\nchannel = "1.97.1"\n')
    writeFileSync(join(workspace, 'Cargo.toml'), '[[package]\nrust-version = "1.97"\n')

    for (const id of ['python', 'rust'] as const) {
      const detection = detectToolchains(workspace).find(item => item.id === id)
      assert.match(detection?.diagnostics?.map(item => item.message).join('\n') ?? '', /malformed.*(?:project|toolchain|package).*section/i, id)
      assert.deepStrictEqual(resolveDetectedVersion(detection!), {
        kind: 'unchecked',
        defaultVersion: TOOLCHAIN_DEFAULTS[id].version
      }, id)
    }
  })
})

test('diagnoses unterminated relevant TOML array headers with trailing content', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'pyproject.toml'), '[[project] trailing\nrequires-python = ">=3.11"\n')
    writeFileSync(join(workspace, 'rust-toolchain.toml'), '[[toolchain] trailing\nchannel = "1.97.1"\n')
    writeFileSync(join(workspace, 'Cargo.toml'), '[[package] trailing\nrust-version = "1.97"\n')

    for (const id of ['python', 'rust'] as const) {
      const detection = detectToolchains(workspace).find(item => item.id === id)
      assert.match(detection?.diagnostics?.map(item => item.message).join('\n') ?? '', /malformed.*(?:project|toolchain|package).*section/i, id)
      assert.deepStrictEqual(resolveDetectedVersion(detection!), {
        kind: 'unchecked',
        defaultVersion: TOOLCHAIN_DEFAULTS[id].version
      }, id)
    }
  })
})

test('returns diagnostics instead of throwing for malformed marker files', () => {
  withWorkspace(workspace => {
    writeFileSync(join(workspace, 'package.json'), '{ invalid')
    writeFileSync(join(workspace, 'pyproject.toml'), '[project]\nrequires-python = 3.14\n')

    const detections = detectToolchains(workspace)
    const node = detections.find(item => item.id === 'node')
    const python = detections.find(item => item.id === 'python')

    assert.match(node?.diagnostics?.[0]?.message ?? '', /package\.json/i)
    assert.deepStrictEqual(python?.evidence, [
      {path: 'pyproject.toml', source: 'requires-python', value: '3.14', exact: false}
    ])
    assert.match(python?.diagnostics?.[0]?.message ?? '', /malformed/i)
  })
})

test('diagnoses empty and multi-line version marker files', () => {
  for (const [file, id] of [
    ['.nvmrc', 'node'],
    ['.node-version', 'node'],
    ['.python-version', 'python'],
    ['.go-version', 'go'],
    ['rust-toolchain', 'rust']
  ] as const) {
    withWorkspace(workspace => {
      writeFileSync(join(workspace, file), '\n')

      const detection = detectToolchains(workspace).find(item => item.id === id)
      assert.strictEqual(detection?.exactVersion, undefined, file)
      assert.match(detection?.diagnostics?.[0]?.message ?? '', /empty/i, file)
      assert.deepStrictEqual(resolveDetectedVersion(detection!), {
        kind: 'unchecked',
        defaultVersion: TOOLCHAIN_DEFAULTS[id].version
      }, file)
    })
  }

  withWorkspace(workspace => {
    writeFileSync(join(workspace, '.python-version'), '3.14.6\n3.13.0\n')

    const python = detectToolchains(workspace)[0]
    assert.strictEqual(python?.exactVersion, undefined)
    assert.match(python?.diagnostics?.[0]?.message ?? '', /single/i)
  })
})

test('keeps defaults release-pinned', () => {
  assert.deepStrictEqual(TOOLCHAIN_DEFAULTS, {
    node: {version: '24.17.0', label: 'Node.js'},
    python: {version: '3.14.6', label: 'Python'},
    go: {version: '1.26.5', label: 'Go'},
    rust: {version: '1.97.1', label: 'Rust'}
  })
})
