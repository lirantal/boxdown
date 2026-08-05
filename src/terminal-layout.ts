const ansiPattern = /\u001B\[[0-?]*[ -/]*[@-~]/gu
const DEFAULT_TERMINAL_COLUMNS = 80

export interface StyledTextSegment<T> {
  text: string
  style: T
}

interface StyledCharacter<T> {
  text: string
  style: T
}

export function visibleLength (value: string): number {
  return Array.from(value.replace(ansiPattern, '')).length
}

export function terminalColumns (columns?: number): number {
  return Number.isInteger(columns) && columns !== undefined && columns > 0
    ? columns
    : DEFAULT_TERMINAL_COLUMNS
}

function normalizedCharacters<T> (
  segments: readonly StyledTextSegment<T>[]
): StyledCharacter<T>[] {
  const characters: StyledCharacter<T>[] = []
  let whitespace = true

  for (const segment of segments) {
    for (const character of Array.from(segment.text)) {
      if (/\s/u.test(character)) {
        if (!whitespace) characters.push({ text: ' ', style: segment.style })
        whitespace = true
      } else {
        characters.push({ text: character, style: segment.style })
        whitespace = false
      }
    }
  }

  if (characters.at(-1)?.text === ' ') characters.pop()
  return characters
}

function coalesce<T> (
  characters: readonly StyledCharacter<T>[]
): StyledTextSegment<T>[] {
  const segments: StyledTextSegment<T>[] = []

  for (const character of characters) {
    const previous = segments.at(-1)
    if (previous !== undefined && Object.is(previous.style, character.style)) {
      previous.text += character.text
    } else {
      segments.push({ ...character })
    }
  }

  return segments
}

export function wrapTextSegments<T> (
  segments: readonly StyledTextSegment<T>[],
  firstWidth: number,
  continuationWidth: number = firstWidth
): StyledTextSegment<T>[][] {
  let remaining = normalizedCharacters(segments)
  const lines: StyledTextSegment<T>[][] = []
  let width = Math.max(1, firstWidth)

  while (remaining.length > 0) {
    if (remaining.length <= width) {
      lines.push(coalesce(remaining))
      break
    }

    const candidate = remaining.slice(0, width + 1)
    const lastSpace = candidate.map((entry) => entry.text).lastIndexOf(' ')
    const splitAt = lastSpace > 0 && lastSpace <= width ? lastSpace : width
    lines.push(coalesce(remaining.slice(0, splitAt)))
    remaining = remaining.slice(splitAt)
    while (remaining[0]?.text === ' ') remaining.shift()
    width = Math.max(1, continuationWidth)
  }

  return lines
}

export function wrapText (
  value: string,
  firstWidth: number,
  continuationWidth: number = firstWidth
): string[] {
  return wrapTextSegments(
    [{ text: value, style: undefined }],
    firstWidth,
    continuationWidth
  ).map((line) => line.map((segment) => segment.text).join(''))
}

export function wrapWithPrefixes (
  value: string,
  firstPrefix: string,
  continuationPrefix: string,
  columns: number
): string[] {
  const lines = wrapText(
    value,
    Math.max(1, columns - visibleLength(firstPrefix)),
    Math.max(1, columns - visibleLength(continuationPrefix))
  )

  return lines.map((line, index) => (
    `${index === 0 ? firstPrefix : continuationPrefix}${line}`
  ))
}
