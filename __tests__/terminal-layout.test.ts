import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  terminalColumns,
  visibleLength,
  wrapText,
  wrapTextSegments,
  wrapWithPrefixes
} from '../src/terminal-layout.ts'

describe('terminal layout', () => {
  test('measures visible ANSI text and resolves terminal columns', () => {
    assert.strictEqual(visibleLength('\u001B[32mgreen\u001B[0m'), 5)
    assert.strictEqual(terminalColumns(42), 42)

    for (const value of [undefined, 0, -1, 3.5, Number.NaN]) {
      assert.strictEqual(terminalColumns(value), 80)
    }
  })

  test('wraps words and hard-wraps an overlong token without losing text', () => {
    assert.deepStrictEqual(wrapText('alpha beta gamma', 10), ['alpha beta', 'gamma'])

    const path = '/Users/demo/projects/a-very-long-workspace-name'
    const lines = wrapText(path, 12)
    assert.ok(lines.every((line) => visibleLength(line) <= 12))
    assert.strictEqual(lines.join(''), path)
    assert.deepStrictEqual(wrapText('abcd', 0), ['a', 'b', 'c', 'd'])
  })

  test('accounts for different first and continuation prefixes', () => {
    assert.deepStrictEqual(
      wrapWithPrefixes('alpha beta gamma delta', '◆  ', '│  ', 12),
      ['◆  alpha', '│  beta', '│  gamma', '│  delta']
    )
  })

  test('preserves styles across word and hard-wrap boundaries', () => {
    const lines = wrapTextSegments([
      { text: '(running)', style: 'green' },
      { text: ' /tmp/a-very-long-workspace', style: 'dim' }
    ], 12)

    assert.strictEqual(
      lines.flat().map((segment) => segment.text).join('').replaceAll(' ', ''),
      '(running)/tmp/a-very-long-workspace'
    )
    assert.ok(lines.flat().some((segment) => segment.style === 'green'))
    assert.ok(lines.flat().some((segment) => segment.style === 'dim'))
    assert.ok(lines.every((line) => (
      line.reduce((length, segment) => length + segment.text.length, 0) <= 12
    )))
  })
})
