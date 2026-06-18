export function stripJsonComments (input: string): string {
  let output = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (char === undefined) {
      break
    }

    if (inString) {
      output += char

      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
      output += char
      continue
    }

    if (char === '/' && next === '/') {
      while (index < input.length && input[index] !== '\n') {
        index += 1
      }

      if (input[index] === '\n') {
        output += '\n'
      }

      continue
    }

    if (char === '/' && next === '*') {
      index += 2

      while (index < input.length) {
        if (input[index] === '\n') {
          output += '\n'
        }

        if (input[index] === '*' && input[index + 1] === '/') {
          index += 1
          break
        }

        index += 1
      }

      continue
    }

    output += char
  }

  return output
}

export function stripTrailingCommas (input: string): string {
  let output = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]

    if (char === undefined) {
      break
    }

    if (inString) {
      output += char

      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
      output += char
      continue
    }

    if (char === ',') {
      let nextIndex = index + 1

      while (/\s/.test(input[nextIndex] ?? '')) {
        nextIndex += 1
      }

      if (input[nextIndex] === '}' || input[nextIndex] === ']') {
        continue
      }
    }

    output += char
  }

  return output
}

export function parseJsonc <T> (input: string): T {
  return JSON.parse(stripTrailingCommas(stripJsonComments(input))) as T
}
