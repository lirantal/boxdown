import assert from 'node:assert'
import {test} from 'node:test'

import {
  releaseAction,
  releaseNotesForVersion,
  remoteAnnotatedTagTarget
} from '../scripts/create-github-release.ts'

const changelog = `# boxdown

## 2.1.0

### Minor Changes

- New release behavior.

## 2.0.0

### Major Changes

- Previous release behavior.
`

test('extracts only the requested changelog entry', () => {
  assert.equal(
    releaseNotesForVersion(changelog, '2.1.0'),
    '### Minor Changes\n\n- New release behavior.'
  )
})

test('rejects a missing changelog entry', () => {
  assert.throws(
    () => releaseNotesForVersion(changelog, '9.9.9'),
    /could not find changelog entry/
  )
})

test('creates a release after publishing or when GitHub is missing it', () => {
  assert.equal(releaseAction(true, true), 'create')
  assert.equal(releaseAction(false, false), 'create')
})

test('skips an existing synchronized GitHub Release', () => {
  assert.equal(releaseAction(false, true), 'skip')
})

test('uses the peeled object for an annotated tag', () => {
  const output = [
    'tag-object\trefs/tags/v2.1.0',
    'release-commit\trefs/tags/v2.1.0^{}'
  ].join('\n')

  assert.equal(remoteAnnotatedTagTarget(output, 'v2.1.0'), 'release-commit')
})

test('rejects a lightweight tag', () => {
  assert.throws(
    () => remoteAnnotatedTagTarget('commit\trefs/tags/v2.1.0', 'v2.1.0'),
    /annotated tag/
  )
})
