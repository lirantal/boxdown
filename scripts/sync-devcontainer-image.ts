import {readFileSync, writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'

const imageLine = /^(\s*"image"\s*:\s*)"[^"]*"(\s*,?\s*)$/gm

function jsoncObjectDepthAt(source: string, offset: number): number {
  let depth = 0
  let inBlockComment = false
  let inLineComment = false
  let inString = false
  let isEscaped = false

  for (let index = 0; index < offset; index += 1) {
    const character = source[index]!
    const nextCharacter = source[index + 1]

    if (inLineComment) {
      if (character === '\n') inLineComment = false
      continue
    }

    if (inBlockComment) {
      if (character === '*' && nextCharacter === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      if (isEscaped) {
        isEscaped = false
      } else if (character === '\\') {
        isEscaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '/' && nextCharacter === '/') {
      inLineComment = true
      index += 1
    } else if (character === '/' && nextCharacter === '*') {
      inBlockComment = true
      index += 1
    } else if (character === '"') {
      inString = true
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
    }
  }

  return depth
}

export function syncDevcontainerImage(packageJsonPath: string, devcontainerPath: string): void {
  const {version} = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {version: string}
  const source = readFileSync(devcontainerPath, 'utf8')
  const match = [...source.matchAll(imageLine)].find(candidate =>
    jsoncObjectDepthAt(source, candidate.index ?? 0) === 1
  )

  if (match === undefined || match.index === undefined) {
    throw new Error(`Packaged devcontainer image is missing: ${devcontainerPath}`)
  }

  const replacement = `${match[1]!}"ghcr.io/lirantal/boxdown:${version}"${match[2]!}`
  const synchronizedSource = `${source.slice(0, match.index)}${replacement}${source.slice(match.index + match[0].length)}`
  writeFileSync(devcontainerPath, synchronizedSource)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  syncDevcontainerImage('package.json', 'assets/devcontainer/devcontainer.json')
}
