import assert from 'node:assert'
import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'

import type { PromptInput, PromptOutput } from '../src/interactive-prompts.ts'
import { resolveSetupAgentProfile } from '../src/setup-agent-profile.ts'

function linePromptStreams (): {
  input: PassThrough & PromptInput
  output: PassThrough & PromptOutput
  outputText: () => string
} {
  const input = new PassThrough() as PassThrough & PromptInput
  const output = new PassThrough() as PassThrough & PromptOutput
  const chunks: Buffer[] = []
  input.isTTY = true
  output.isTTY = true
  output.on('data', (chunk: Buffer) => chunks.push(chunk))
  return { input, output, outputText: () => Buffer.concat(chunks).toString('utf8') }
}

describe('setup agent profile resolution', () => {
  test('uses explicit profile without prompting', async () => {
    const streams = linePromptStreams()
    assert.deepStrictEqual(await resolveSetupAgentProfile({
      explicitProfile: 'none',
      recordedProfile: 'full',
      targets: ['codex'],
      input: streams.input,
      output: streams.output,
      env: { CI: 'false' }
    }), { cancelled: false, profile: 'none' })
    assert.strictEqual(streams.outputText(), '')
  })

  test('uses recorded or default profile when no targets are selected', async () => {
    assert.deepStrictEqual(await resolveSetupAgentProfile({
      recordedProfile: 'full',
      targets: [],
      env: { CI: '1' }
    }), { cancelled: false, profile: 'full' })
    assert.deepStrictEqual(await resolveSetupAgentProfile({
      targets: [],
      env: { CI: '1' }
    }), { cancelled: false, profile: 'auth' })
  })

  test('uses recorded or default profile non-interactively with targets', async () => {
    assert.deepStrictEqual(await resolveSetupAgentProfile({
      recordedProfile: 'none',
      targets: ['claude'],
      env: { CI: '1' }
    }), { cancelled: false, profile: 'none' })
    assert.deepStrictEqual(await resolveSetupAgentProfile({
      targets: ['codex'],
      env: { CI: '1' }
    }), { cancelled: false, profile: 'auth' })
  })

  test('prompts for a profile when final targets exist', async () => {
    const streams = linePromptStreams()
    const resultPromise = resolveSetupAgentProfile({
      targets: ['codex'],
      input: streams.input,
      output: streams.output,
      env: { CI: 'false' }
    })
    streams.input.write('3\n')

    assert.deepStrictEqual(await resultPromise, { cancelled: false, profile: 'full' })
    assert.match(streams.outputText(), /How much host agent data should Boxdown use in the container/)
    assert.match(streams.outputText(), /Authentication and ~\/\.agents/)
    assert.match(streams.outputText(), /Mount live read-write Codex, Claude, and ~\/\.agents host profiles/)
  })

  test('defaults the prompt to the recorded profile', async () => {
    const streams = linePromptStreams()
    const resultPromise = resolveSetupAgentProfile({
      recordedProfile: 'full',
      targets: ['claude'],
      input: streams.input,
      output: streams.output,
      env: { CI: 'false' }
    })
    streams.input.write('\n')

    assert.deepStrictEqual(await resultPromise, { cancelled: false, profile: 'full' })
  })

  test('treats targets as an eligibility gate, not a copy filter', async () => {
    const streams = linePromptStreams()
    const resultPromise = resolveSetupAgentProfile({
      targets: ['codex'],
      input: streams.input,
      output: streams.output,
      env: { CI: 'false' }
    })
    streams.input.write('full\n')

    assert.deepStrictEqual(await resultPromise, { cancelled: false, profile: 'full' })
  })

  test('returns cancellation without a profile', async () => {
    const streams = linePromptStreams()
    const resultPromise = resolveSetupAgentProfile({
      targets: ['codex'],
      input: streams.input,
      output: streams.output,
      env: { CI: 'false' }
    })
    streams.input.end()

    assert.deepStrictEqual(await resultPromise, { cancelled: true })
  })
})
