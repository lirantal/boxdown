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
  summaryLabel?: string
  input?: PromptInput
  output?: PromptOutput
  env?: NodeJS.ProcessEnv
}

export type TextPromptResult =
  | { status: 'submitted', value: string }
  | { status: 'cancelled', value?: undefined }
  | { status: 'non-interactive', value?: undefined }

export interface TextPromptOptions {
  title: string
  details?: readonly string[]
  defaultValue?: string
  summaryLabel: string
  validate?: (value: string) => string | undefined
  input?: PromptInput
  output?: PromptOutput
  env?: NodeJS.ProcessEnv
}

export type ConfirmPromptResult =
  | { status: 'confirmed' }
  | { status: 'denied' }
  | { status: 'cancelled' }
  | { status: 'non-interactive' }

export interface ConfirmPromptOptions {
  title: string
  details?: readonly string[]
  confirmLabel: string
  cancelLabel: string
  summaryLabel: string
  input?: PromptInput
  output?: PromptOutput
  env?: NodeJS.ProcessEnv
}

function isCiEnvironment (env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI
  return ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false'
}

export function canPromptInteractively (input: PromptInput, output: PromptOutput, env: NodeJS.ProcessEnv): boolean {
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

function formatDetailLine (detail: string): string {
  return `${promptRail()}  ${color(detail, 'dim')}`
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

function formatConfirmLine (
  label: string,
  isFocused: boolean
): string {
  const mark = isFocused ? selectedMark() : emptyMark(false)
  return `${promptRail()}  ${mark} ${formatLabel(label, isFocused)}`
}

function formatMultiSelectFinalLine <T extends string> (
  result: MultiSelectPromptResult<T>,
  choices: readonly MultiSelectChoice<T>[],
  summaryLabel: string
): string {
  if (result.status === 'cancelled') {
    return `${summaryLabel}: canceled`
  }

  if (result.status !== 'selected') {
    return `${summaryLabel}: skipped`
  }

  const selectedLabels = choices
    .filter((choice) => result.values.includes(choice.value))
    .map((choice) => choice.label)
    .join(', ')

  return `${summaryLabel}: ${selectedLabels}`
}

function formatTextFinalLine (result: TextPromptResult, summaryLabel: string): string {
  if (result.status === 'cancelled') {
    return `${summaryLabel}: canceled`
  }

  if (result.status === 'non-interactive') {
    return `${summaryLabel}: skipped`
  }

  return `${summaryLabel}: ${result.value}`
}

function formatConfirmFinalLine (result: ConfirmPromptResult, summaryLabel: string): string {
  if (result.status === 'confirmed') {
    return `${summaryLabel}: confirmed`
  }

  if (result.status === 'cancelled') {
    return `${summaryLabel}: canceled`
  }

  return `${summaryLabel}: canceled`
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
  options: Required<Pick<MultiSelectPromptOptions<T>, 'title' | 'choices' | 'skipLabel' | 'summaryLabel' | 'input' | 'output'>>
): Promise<MultiSelectPromptResult<T>> {
  options.output.write(`${formatPromptTitle(options.title)}\n`)

  options.choices.forEach((choice, index) => {
    options.output.write(`${promptRail()}  ${index + 1}) ${choice.label} - ${choice.description}\n`)
  })

  options.output.write(`${promptRail()}  0) ${options.skipLabel}\n`)

  while (true) {
    const answer = await askLine(options.input, options.output, `${promptRail()}  `)

    if (answer === undefined) {
      return { status: 'cancelled', values: [] }
    }

    const parsed = parseLineSelection(answer, options.choices)

    if ('values' in parsed) {
      const result = resultFromValues(parsed.values)
      options.output.write(`${formatPromptEnd()}\n${formatMultiSelectFinalLine(result, options.choices, options.summaryLabel)}\n`)
      return result
    }

    options.output.write(`${promptRail()}  ${parsed.error}\n`)
  }
}

function promptRawMultiSelect <T extends string> (
  options: Required<Pick<MultiSelectPromptOptions<T>, 'title' | 'choices' | 'skipLabel' | 'summaryLabel' | 'input' | 'output'>>
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
      options.output.write(`${formatMultiSelectFinalLine(result, options.choices, options.summaryLabel)}\n`)
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
  const summaryLabel = options.summaryLabel ?? 'Selection'

  if (!canPromptInteractively(input, output, env)) {
    return { status: 'non-interactive', values: [] }
  }

  if (typeof input.setRawMode !== 'function') {
    return promptLineMultiSelect({
      title: options.title,
      choices: options.choices,
      skipLabel: options.skipLabel,
      summaryLabel,
      input,
      output
    })
  }

  try {
    return await promptRawMultiSelect({
      title: options.title,
      choices: options.choices,
      skipLabel: options.skipLabel,
      summaryLabel,
      input,
      output
    })
  } catch {
    return promptLineMultiSelect({
      title: options.title,
      choices: options.choices,
      skipLabel: options.skipLabel,
      summaryLabel,
      input,
      output
    })
  }
}

export async function promptText (options: TextPromptOptions): Promise<TextPromptResult> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const env = options.env ?? process.env

  if (!canPromptInteractively(input, output, env)) {
    return { status: 'non-interactive' }
  }

  output.write(`${formatPromptTitle(options.title)}\n`)

  for (const detail of options.details ?? []) {
    output.write(`${formatDetailLine(detail)}\n`)
  }

  while (true) {
    const defaultText = options.defaultValue === undefined ? '' : color(` (${options.defaultValue})`, 'dim')
    const answer = await askLine(input, output, `${promptRail()}  ${defaultText} `)

    if (answer === undefined || answer === '\u0003' || answer === '\u0004' || answer === '\u001B') {
      const result: TextPromptResult = { status: 'cancelled' }
      output.write(`${formatPromptEnd()}\n${formatTextFinalLine(result, options.summaryLabel)}\n`)
      return result
    }

    const value = answer.trim() === '' && options.defaultValue !== undefined
      ? options.defaultValue
      : answer.trim()
    const error = options.validate?.(value)

    if (error === undefined) {
      const result: TextPromptResult = { status: 'submitted', value }
      output.write(`${formatPromptEnd()}\n${formatTextFinalLine(result, options.summaryLabel)}\n`)
      return result
    }

    output.write(`${promptRail()}  ${error}\n`)
  }
}

function promptLineConfirm (
  options: Required<Pick<ConfirmPromptOptions, 'title' | 'details' | 'confirmLabel' | 'cancelLabel' | 'summaryLabel' | 'input' | 'output'>>
): Promise<ConfirmPromptResult> {
  options.output.write(`${formatPromptTitle(options.title)}\n`)

  for (const detail of options.details) {
    options.output.write(`${formatDetailLine(detail)}\n`)
  }

  return new Promise((resolve) => {
    async function ask (): Promise<void> {
      const answer = await askLine(options.input, options.output, `${promptRail()}  ${options.confirmLabel}? [y/N] `)

      if (answer === undefined || answer === '\u0003' || answer === '\u0004' || answer === '\u001B') {
        const result: ConfirmPromptResult = { status: 'cancelled' }
        options.output.write(`${formatPromptEnd()}\n${formatConfirmFinalLine(result, options.summaryLabel)}\n`)
        resolve(result)
        return
      }

      if (answer.trim() === '' || /^n(?:o)?$/iu.test(answer.trim())) {
        const result: ConfirmPromptResult = { status: 'denied' }
        options.output.write(`${formatPromptEnd()}\n${formatConfirmFinalLine(result, options.summaryLabel)}\n`)
        resolve(result)
        return
      }

      if (/^y(?:es)?$/iu.test(answer.trim())) {
        const result: ConfirmPromptResult = { status: 'confirmed' }
        options.output.write(`${formatPromptEnd()}\n${formatConfirmFinalLine(result, options.summaryLabel)}\n`)
        resolve(result)
        return
      }

      options.output.write(`${promptRail()}  Enter y or n.\n`)
      await ask()
    }

    void ask()
  })
}

function promptRawConfirm (
  options: Required<Pick<ConfirmPromptOptions, 'title' | 'details' | 'confirmLabel' | 'cancelLabel' | 'summaryLabel' | 'input' | 'output'>>
): Promise<ConfirmPromptResult> {
  return new Promise((resolve) => {
    let focusedIndex = 0
    let settled = false
    let renderedLineCount = 0

    function lines (): string[] {
      return [
        formatPromptTitle(options.title),
        promptRail(),
        ...options.details.map((detail) => formatDetailLine(detail)),
        formatConfirmLine(options.cancelLabel, focusedIndex === 0),
        formatConfirmLine(options.confirmLabel, focusedIndex === 1),
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

    function finish (result: ConfirmPromptResult): void {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      options.output.write(`${formatConfirmFinalLine(result, options.summaryLabel)}\n`)
      resolve(result)
    }

    function moveFocus (): void {
      focusedIndex = focusedIndex === 0 ? 1 : 0
      render()
    }

    function submit (): void {
      finish(focusedIndex === 1 ? { status: 'confirmed' } : { status: 'denied' })
    }

    function handleKey (key: string): void {
      if (key === '\u0003' || key === '\u0004' || key === '\u001B') {
        finish({ status: 'cancelled' })
        return
      }

      if (key === '\r' || key === '\n') {
        submit()
        return
      }

      if (key === ' ' || key === 'j' || key === 'k' || key === 'h' || key === 'l') {
        moveFocus()
        return
      }

      if (key === 'y' || key === 'Y') {
        finish({ status: 'confirmed' })
        return
      }

      if (key === 'n' || key === 'N') {
        finish({ status: 'denied' })
      }
    }

    function handleText (text: string): void {
      for (let index = 0; index < text.length;) {
        if (text.startsWith('\u001B[A', index) || text.startsWith('\u001B[B', index) || text.startsWith('\u001B[C', index) || text.startsWith('\u001B[D', index)) {
          moveFocus()
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

export async function promptConfirm (options: ConfirmPromptOptions): Promise<ConfirmPromptResult> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const env = options.env ?? process.env
  const details = options.details ?? []

  if (!canPromptInteractively(input, output, env)) {
    return { status: 'non-interactive' }
  }

  if (typeof input.setRawMode !== 'function') {
    return promptLineConfirm({
      title: options.title,
      details,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      summaryLabel: options.summaryLabel,
      input,
      output
    })
  }

  try {
    return await promptRawConfirm({
      title: options.title,
      details,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      summaryLabel: options.summaryLabel,
      input,
      output
    })
  } catch {
    return promptLineConfirm({
      title: options.title,
      details,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      summaryLabel: options.summaryLabel,
      input,
      output
    })
  }
}
