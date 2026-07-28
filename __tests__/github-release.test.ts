import assert from 'node:assert'
import {test} from 'node:test'

import {
  ensureGitHubRelease,
  releaseNotesForVersion,
  remoteAnnotatedTagTarget,
  type CommandResult
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

function commandQueue(...results: CommandResult[]) {
  const calls: Array<{program: string, arguments_: string[], input?: string}> = []
  const command = (program: string, arguments_: string[], input?: string): CommandResult => {
    calls.push({program, arguments_, input})
    const result = results.shift()
    if (result === undefined) throw new Error(`unexpected command: ${program} ${arguments_.join(' ')}`)
    return result
  }
  return {calls, command}
}

const release = {
  packageName: 'boxdown',
  version: '2.1.0',
  revision: 'a'.repeat(40),
  repository: 'lirantal/boxdown'
}

test('leaves a correctly tagged existing GitHub Release untouched', () => {
  const {calls, command} = commandQueue(
    {stdout: `tag-object\trefs/tags/v2.1.0\n${release.revision}\trefs/tags/v2.1.0^{}`, stderr: '', status: 0},
    {stdout: '{}', stderr: '', status: 0}
  )

  ensureGitHubRelease(release, command)

  assert.deepEqual(calls.map(call => call.program), ['git', 'gh'])
})

test('creates an annotated tag and release when both are missing', () => {
  const {calls, command} = commandQueue(
    {stdout: '', stderr: '', status: 0},
    {stdout: '', stderr: '', status: 0},
    {stdout: '', stderr: '', status: 0},
    {stdout: '', stderr: 'HTTP 404: Not Found', status: 1},
    {stdout: '', stderr: '', status: 0}
  )

  ensureGitHubRelease(release, command)

  assert.deepEqual(calls.map(call => call.program), ['git', 'git', 'git', 'gh', 'gh'])
  assert.deepEqual(calls[1]?.arguments_, ['tag', '--annotate', 'v2.1.0', release.revision, '--message', 'v2.1.0'])
  assert.match(calls[4]?.input ?? '', /### Minor Changes/)
})

test('rejects a tag that targets another release revision', () => {
  const {calls, command} = commandQueue({
    stdout: `tag-object\trefs/tags/v2.1.0\n${'b'.repeat(40)}\trefs/tags/v2.1.0^{}`,
    stderr: '',
    status: 0
  })

  assert.throws(
    () => ensureGitHubRelease(release, command),
    new RegExp(`expected ${release.revision}`)
  )
  assert.equal(calls.length, 1)
})

test('fails closed when GitHub Release inspection does not return 404', () => {
  const {command} = commandQueue(
    {stdout: `tag-object\trefs/tags/v2.1.0\n${release.revision}\trefs/tags/v2.1.0^{}`, stderr: '', status: 0},
    {stdout: '', stderr: 'HTTP 502: Bad Gateway', status: 1}
  )

  assert.throws(() => ensureGitHubRelease(release, command), /could not inspect GitHub Release/)
})
