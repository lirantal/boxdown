import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseJsonc } from '../src/jsonc.ts'

const devcontainerPath = fileURLToPath(new URL('../assets/devcontainer/devcontainer.json', import.meta.url))

test('pins the packaged Node 24 devcontainer image to a SHA-256 digest', () => {
  const devcontainer = parseJsonc<{ image: string }>(readFileSync(devcontainerPath, 'utf8'))

  assert.match(devcontainer.image, /^node:24-trixie-slim@sha256:[a-f0-9]{64}$/)
})
