import {readFileSync, writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'

interface ImageProperty {
  valueStart: number
  valueEnd: number
}

function skipWhitespace(source: string, index: number): number {
  while ([' ', '\t', '\r', '\n'].includes(source[index] ?? '')) index += 1
  return index
}

function findClosingQuote(source: string, openingQuote: number): number | undefined {
  let isEscaped = false

  for (let index = openingQuote + 1; index < source.length; index += 1) {
    const character = source[index]!
    if (isEscaped) {
      isEscaped = false
    } else if (character === '\\') {
      isEscaped = true
    } else if (character === '"') {
      return index
    }
  }
}

function isTopLevelJsoncPropertyAt(source: string, offset: number): boolean {
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

  return depth === 1 && !inBlockComment && !inLineComment && !inString
}

function findTopLevelImageProperty(source: string): ImageProperty | undefined {
  let propertyStart = source.indexOf('"image"')

  while (propertyStart !== -1) {
    let index = skipWhitespace(source, propertyStart + '"image"'.length)
    if (isTopLevelJsoncPropertyAt(source, propertyStart) && source[index] === ':') {
      index = skipWhitespace(source, index + 1)
      if (source[index] === '"') {
        const valueEnd = findClosingQuote(source, index)
        if (valueEnd !== undefined) return {valueStart: index + 1, valueEnd}
      }
    }

    propertyStart = source.indexOf('"image"', propertyStart + '"image"'.length)
  }
}

export function syncDevcontainerImage(packageJsonPath: string, devcontainerPath: string): void {
  const {version} = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {version: string}
  const source = readFileSync(devcontainerPath, 'utf8')
  const imageProperty = findTopLevelImageProperty(source)

  if (imageProperty === undefined) {
    throw new Error(`Packaged devcontainer image is missing: ${devcontainerPath}`)
  }

  const synchronizedSource = `${source.slice(0, imageProperty.valueStart)}ghcr.io/lirantal/boxdown:${version}${source.slice(imageProperty.valueEnd)}`
  writeFileSync(devcontainerPath, synchronizedSource)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  syncDevcontainerImage('package.json', 'assets/devcontainer/devcontainer.json')
}
