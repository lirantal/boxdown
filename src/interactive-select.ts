import { createInterface } from 'node:readline'

export interface MultiSelectChoice<T extends string> {
  value: T
  label: string
  description: string
}

export type MultiSelectPromptResult<T extends string> =
  | { status: 'selected', values: T[] }
  | { status: 'skipped', values: [] }
  | { status: 'cancelled', values: [] }
  | { status: 'non-interactive', values: [] }

export type PromptInput = NodeJS.ReadableStream & {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => void
  resume: () => PromptInput
  pause: () => PromptInput
}

export type PromptOutput = NodeJS.WritableStream & {
  isTTY?: boolean
  columns?: number
}

export interface MultiSelectPromptOptions<T extends string> {
  title: string
  choices: readonly MultiSelectChoice<T>[]
  skipLabel: string
  input?: PromptInput
  output?: PromptOutput
  env?: NodeJS.ProcessEnv
}

function isCiEnvironment (env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI
  return ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false'
}

function canPromptInteractively (input: PromptInput, output: PromptOutput, env: NodeJS.ProcessEnv): boolean {
  return !isCiEnvironment(env) && input.isTTY === true && output.isTTY === true
}

const ansi = {
  bold: '\u001B[1m',
  cyan: '\u001B[36m',
  dim: '\u001B[2m',
  green: '\u001B[32m',
  reset: '\u001B[0m'
}

function color (value: string, colorName: keyof typeof ansi): string {
  return `${ansi[colorName]}${value}${ansi.reset}`
}

function selectedMark (): string {
  return color('■', 'green')
}

function emptyMark (isFocused: boolean): string {
  return color('□', isFocused ? 'cyan' : 'dim')
}

function promptRail (): string {
  return color('│', 'cyan')
}

function formatPromptTitle (title: string): string {
  return `${color('◆', 'cyan')}  ${color(title, 'bold')}`
}

function formatPromptEnd (): string {
  return color('└', 'cyan')
}

function formatLabel (label: string, isFocused: boolean): string {
  return color(label, isFocused ? 'bold' : 'dim')
}

function formatChoiceLine <T extends string> (
  choice: MultiSelectChoice<T>,
  isFocused: boolean,
  isSelected: boolean
): string {
  const mark = isSelected ? selectedMark() : emptyMark(isFocused)
  const description = color(` - ${choice.description}`, 'dim')
  return `${promptRail()}  ${mark} ${formatLabel(choice.label, isFocused)}${description}`
}

function formatSkipLine (skipLabel: string, isFocused: boolean, selectedCount: number): string {
  const mark = selectedCount === 0 ? selectedMark() : emptyMark(isFocused)
  return `${promptRail()}  ${mark} ${formatLabel(skipLabel, isFocused)}`
}

function formatFinalLine <T extends string> (
  result: MultiSelectPromptResult<T>,
  choices: readonly MultiSelectChoice<T>[]
): string {
  if (result.status === 'cancelled') {
    return 'Optional SSH targets: canceled'
  }

  if (result.status !== 'selected') {
    return 'Optional SSH targets: skipped'
  }

  const selectedLabels = choices
    .filter((choice) => result.values.includes(choice.value))
    .map((choice) => choice.label)
    .join(', ')

  return `Optional SSH targets: ${selectedLabels}`
}

function resultFromValues <T extends string> (values: T[]): MultiSelectPromptResult<T> {
  return values.length === 0
    ? { status: 'skipped', values: [] }
    : { status: 'selected', values }
}

function parseLineSelection <T extends string> (
  answer: string,
  choices: readonly MultiSelectChoice<T>[]
): { values: T[] } | { error: string } {
  const trimmed = answer.trim()

  if (trimmed === '' || trimmed === '0' || /^skip$/iu.test(trimmed)) {
    return { values: [] }
  }

  const selected = new Set<T>()
  const tokens = trimmed.split(/[,\s]+/u).filter((token) => token.length > 0)

  for (const token of tokens) {
    const byNumber = /^[0-9]+$/u.test(token) ? Number(token) : undefined
    const choice = byNumber === undefined
      ? choices.find((candidate) => candidate.value === token)
      : choices[byNumber - 1]

    if (choice === undefined) {
      return { error: `Unknown selection: ${token}` }
    }

    selected.add(choice.value)
  }

  return { values: [...selected] }
}

function askLine (input: PromptInput, output: PromptOutput, question: string): Promise<string | undefined> {
  const rl = createInterface({
    input,
    output,
    terminal: false
  })

  return new Promise((resolve) => {
    let settled = false

    function settle (answer: string | undefined): void {
      if (settled) {
        return
      }

      settled = true
      rl.close()
      resolve(answer)
    }

    rl.once('close', () => {
      settle(undefined)
    })

    rl.question(question, (answer) => {
      settle(answer)
    })
  })
}

async function promptLineMultiSelect <T extends string> (
  options: Required<Pick<MultiSelectPromptOptions<T>, 'title' | 'choices' | 'skipLabel' | 'input' | 'output'>>
): Promise<MultiSelectPromptResult<T>> {
  options.output.write(`${options.title}\n`)

  options.choices.forEach((choice, index) => {
    options.output.write(`  ${index + 1}) ${choice.label} - ${choice.description}\n`)
  })

  options.output.write(`  0) ${options.skipLabel}\n`)

  while (true) {
    const answer = await askLine(options.input, options.output, 'Choose targets by number or name, separated by commas [0]: ')

    if (answer === undefined) {
      return { status: 'cancelled', values: [] }
    }

    const parsed = parseLineSelection(answer, options.choices)

    if ('values' in parsed) {
      const result = resultFromValues(parsed.values)
      options.output.write(`${formatFinalLine(result, options.choices)}\n`)
      return result
    }

    options.output.write(`${parsed.error}\n`)
  }
}

function promptRawMultiSelect <T extends string> (
  options: Required<Pick<MultiSelectPromptOptions<T>, 'title' | 'choices' | 'skipLabel' | 'input' | 'output'>>
): Promise<MultiSelectPromptResult<T>> {
  return new Promise((resolve) => {
    const selected = new Set<T>()
    let focusedIndex = options.choices.length
    let settled = false
    let renderedLineCount = 0

    function lines (): string[] {
      return [
        formatPromptTitle(options.title),
        promptRail(),
        ...options.choices.map((choice, index) => formatChoiceLine(
          choice,
          focusedIndex === index,
          selected.has(choice.value)
        )),
        formatSkipLine(options.skipLabel, focusedIndex === options.choices.length, selected.size),
        formatPromptEnd()
      ]
    }

    function render (): void {
      if (renderedLineCount > 0) {
        options.output.write(`\u001B[${renderedLineCount}A`)
      }

      const nextLines = lines()
      for (const line of nextLines) {
        options.output.write(`\u001B[2K\r${line}\n`)
      }
      renderedLineCount = nextLines.length
    }

    function cleanup (): void {
      options.input.removeListener('data', onData)
      options.input.setRawMode?.(false)
      options.input.pause()
      options.output.write('\u001B[?25h')
    }

    function finish (result: MultiSelectPromptResult<T>): void {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      options.output.write(`${formatFinalLine(result, options.choices)}\n`)
      resolve(result)
    }

    function submit (): void {
      if (focusedIndex === options.choices.length) {
        finish({ status: 'skipped', values: [] })
        return
      }

      finish(resultFromValues([...selected]))
    }

    function toggleFocused (): void {
      const focusedChoice = options.choices[focusedIndex]

      if (focusedChoice === undefined) {
        selected.clear()
        render()
        return
      }

      if (selected.has(focusedChoice.value)) {
        selected.delete(focusedChoice.value)
      } else {
        selected.add(focusedChoice.value)
      }

      render()
    }

    function moveFocus (direction: 1 | -1): void {
      const rowCount = options.choices.length + 1
      focusedIndex = (focusedIndex + direction + rowCount) % rowCount
      render()
    }

    function handleKey (key: string): void {
      if (key === '\u0003' || key === '\u0004' || key === '\u001B') {
        finish({ status: 'cancelled', values: [] })
        return
      }

      if (key === '\r' || key === '\n') {
        submit()
        return
      }

      if (key === ' ') {
        toggleFocused()
        return
      }

      if (key === 'k') {
        moveFocus(-1)
        return
      }

      if (key === 'j') {
        moveFocus(1)
      }
    }

    function handleText (text: string): void {
      for (let index = 0; index < text.length;) {
        if (text.startsWith('\u001B[A', index)) {
          moveFocus(-1)
          index += 3
          continue
        }

        if (text.startsWith('\u001B[B', index)) {
          moveFocus(1)
          index += 3
          continue
        }

        handleKey(text[index] ?? '')
        index += 1
      }
    }

    function onData (chunk: string | Buffer): void {
      handleText(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    }

    options.output.write('\u001B[?25l')
    options.input.setRawMode?.(true)
    options.input.resume()
    options.input.on('data', onData)
    render()
  })
}

export async function promptMultiSelect <T extends string> (
  options: MultiSelectPromptOptions<T>
): Promise<MultiSelectPromptResult<T>> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const env = options.env ?? process.env

  if (!canPromptInteractively(input, output, env)) {
    return { status: 'non-interactive', values: [] }
  }

  if (typeof input.setRawMode !== 'function') {
    return promptLineMultiSelect({
      title: options.title,
      choices: options.choices,
      skipLabel: options.skipLabel,
      input,
      output
    })
  }

  try {
    return await promptRawMultiSelect({
      title: options.title,
      choices: options.choices,
      skipLabel: options.skipLabel,
      input,
      output
    })
  } catch {
    return promptLineMultiSelect({
      title: options.title,
      choices: options.choices,
      skipLabel: options.skipLabel,
      input,
      output
    })
  }
}
