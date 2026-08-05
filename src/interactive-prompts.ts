import { createInterface } from 'node:readline'

import { color, emptyMark, formatPromptDetailLine, formatPromptEnd, formatPromptLabel, formatPromptTitle, formatPromptTitleLines, maybeColor, promptRail, selectedMark, type CliColor } from './cli-style.ts'
import { terminalColumns, visibleLength, wrapText, wrapTextSegments, type StyledTextSegment } from './terminal-layout.ts'

export interface MultiSelectDescriptionSegment {
  text: string
  color: CliColor
}

export interface MultiSelectChoice<T extends string> {
  value: T
  label: string
  description: string
  focusedDescription?: readonly MultiSelectDescriptionSegment[]
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
  initialValues?: readonly T[]
  summaryLabel?: string
  input?: PromptInput
  output?: PromptOutput
  env?: NodeJS.ProcessEnv
}

export interface SelectPromptChoice<T extends string> {
  value: T
  label: string
  description: string
}

export type SelectPromptResult<T extends string> =
  | { status: 'selected', value: T }
  | { status: 'cancelled' }
  | { status: 'non-interactive' }

export interface SelectPromptOptions<T extends string> {
  title: string
  choices: readonly SelectPromptChoice<T>[]
  defaultValue: T
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

function renderedRowCount (lines: readonly string[], output: PromptOutput): number {
  const columns = terminalColumns(output.columns)
  return lines.reduce((rows, line) => rows + Math.max(1, Math.ceil(visibleLength(line) / columns)), 0)
}

function renderPromptLines (
  output: PromptOutput,
  lines: readonly string[],
  previousRows: number
): number {
  if (previousRows > 0) {
    output.write(`\u001B[${previousRows}A\r\u001B[J`)
  }

  for (const line of lines) {
    output.write(`\u001B[2K\r${line}\n`)
  }

  return renderedRowCount(lines, output)
}

function renderDescriptionSegments (
  segments: readonly StyledTextSegment<CliColor>[],
  colorEnabled: boolean
): string {
  return segments
    .map((segment) => maybeColor(segment.text, segment.style, colorEnabled))
    .join('')
}

function formatPromptChoiceLines (
  label: string,
  descriptionSegments: readonly StyledTextSegment<CliColor>[],
  inlineDescription: string,
  mark: string,
  isFocused: boolean,
  output: PromptOutput,
  colorEnabled: boolean
): string[] {
  const columns = terminalColumns(output.columns)
  const firstPrefix = `${promptRail(colorEnabled)}  ${mark} `
  const continuationPrefix = `${promptRail(colorEnabled)}    `
  const inline = `${firstPrefix}${formatPromptLabel(label, isFocused, colorEnabled)}${inlineDescription}`
  if (visibleLength(inline) <= columns) return [inline]

  const labelLines = wrapText(
    label,
    columns - visibleLength(firstPrefix),
    columns - visibleLength(continuationPrefix)
  ).map((line, index) => (
    `${index === 0 ? firstPrefix : continuationPrefix}${formatPromptLabel(line, isFocused, colorEnabled)}`
  ))
  const descriptionWidth = columns - visibleLength(continuationPrefix)
  const descriptionLines = wrapTextSegments(
    descriptionSegments,
    descriptionWidth
  ).map((line) => (
    `${continuationPrefix}${renderDescriptionSegments(line, colorEnabled)}`
  ))

  return [...labelLines, ...descriptionLines]
}

function formatSelectChoiceLines <T extends string> (
  choice: SelectPromptChoice<T>,
  isFocused: boolean,
  output: PromptOutput,
  colorEnabled: boolean
): string[] {
  return formatPromptChoiceLines(
    choice.label,
    [{ text: choice.description, style: 'dim' }],
    maybeColor(` - ${choice.description}`, 'dim', colorEnabled),
    isFocused ? selectedMark(colorEnabled) : emptyMark(false, colorEnabled),
    isFocused,
    output,
    colorEnabled
  )
}

function formatMultiSelectChoiceLines <T extends string> (
  choice: MultiSelectChoice<T>,
  isFocused: boolean,
  isSelected: boolean,
  output: PromptOutput,
  colorEnabled: boolean
): string[] {
  const descriptionSegments: readonly StyledTextSegment<CliColor>[] = isFocused && choice.focusedDescription !== undefined
    ? choice.focusedDescription.map((segment) => ({
        text: segment.text,
        style: segment.color
      }))
    : [{ text: choice.description, style: 'dim' }]
  const inlineDescription = isFocused && choice.focusedDescription !== undefined
    ? `${maybeColor(' - ', 'dim', colorEnabled)}${renderDescriptionSegments(descriptionSegments, colorEnabled)}`
    : maybeColor(` - ${choice.description}`, 'dim', colorEnabled)
  const mark = isSelected ? selectedMark(colorEnabled) : emptyMark(isFocused, colorEnabled)

  return formatPromptChoiceLines(
    choice.label,
    descriptionSegments,
    inlineDescription,
    mark,
    isFocused,
    output,
    colorEnabled
  )
}

function formatSkipLines (
  skipLabel: string,
  isFocused: boolean,
  selectedCount: number,
  output: PromptOutput,
  colorEnabled: boolean
): string[] {
  const mark = selectedCount === 0 ? selectedMark(colorEnabled) : emptyMark(isFocused, colorEnabled)
  const columns = terminalColumns(output.columns)
  const firstPrefix = `${promptRail(colorEnabled)}  ${mark} `
  const continuationPrefix = `${promptRail(colorEnabled)}    `

  return wrapText(
    skipLabel,
    columns - visibleLength(firstPrefix),
    columns - visibleLength(continuationPrefix)
  ).map((line, index) => (
    `${index === 0 ? firstPrefix : continuationPrefix}${formatPromptLabel(line, isFocused, colorEnabled)}`
  ))
}

function formatConfirmLine (
  label: string,
  isFocused: boolean
): string {
  const mark = isFocused ? selectedMark() : emptyMark(false)
  return `${promptRail()}  ${mark} ${formatPromptLabel(label, isFocused)}`
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

function formatSelectFinalLine <T extends string> (
  result: SelectPromptResult<T>,
  choices: readonly SelectPromptChoice<T>[],
  summaryLabel: string
): string {
  if (result.status === 'cancelled') return `${summaryLabel}: canceled`
  if (result.status === 'non-interactive') return `${summaryLabel}: skipped`

  const label = choices.find((choice) => choice.value === result.value)?.label
  return `${summaryLabel}: ${label ?? result.value}`
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
  choices: readonly MultiSelectChoice<T>[],
  initialValues: readonly T[] = []
): { values: T[] } | { error: string } {
  const trimmed = answer.trim()

  if (trimmed === '') {
    return {values: [...initialValues]}
  }

  if (trimmed === '0' || /^skip$/iu.test(trimmed)) {
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

function parseLineSelect <T extends string> (
  answer: string,
  choices: readonly SelectPromptChoice<T>[],
  defaultValue: T
): { value: T } | { error: string } {
  const trimmed = answer.trim()
  if (trimmed === '') return { value: defaultValue }

  const byNumber = /^[0-9]+$/u.test(trimmed) ? Number(trimmed) : undefined
  const choice = byNumber === undefined
    ? choices.find((candidate) => candidate.value === trimmed)
    : choices[byNumber - 1]

  return choice === undefined
    ? { error: `Unknown selection: ${trimmed}` }
    : { value: choice.value }
}

const bufferedLineAnswers = new WeakMap<PromptInput, string[]>()

function askLine (input: PromptInput, output: PromptOutput, question: string): Promise<string | undefined> {
  const buffered = bufferedLineAnswers.get(input)
  const answer = buffered?.shift()

  if (answer !== undefined) {
    output.write(question)
    return Promise.resolve(answer)
  }

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

    output.write(question)
    rl.on('line', (line) => {
      if (settled) {
        const answers = bufferedLineAnswers.get(input) ?? []
        answers.push(line)
        bufferedLineAnswers.set(input, answers)
        return
      }

      settle(line)
    })
  })
}

async function promptLineSelect <T extends string> (
  options: Required<Pick<SelectPromptOptions<T>, 'title' | 'choices' | 'defaultValue' | 'summaryLabel' | 'input' | 'output'>>
): Promise<SelectPromptResult<T>> {
  options.output.write(`${formatPromptTitle(options.title)}\n`)
  options.choices.forEach((choice, index) => {
    const current = choice.value === options.defaultValue ? ' (current)' : ''
    options.output.write(
      `${promptRail()}  ${index + 1}) ${choice.label}${current} - ${choice.description}\n`
    )
  })

  while (true) {
    const answer = await askLine(options.input, options.output, `${promptRail()}  `)
    if (answer === undefined) return { status: 'cancelled' }

    const parsed = parseLineSelect(answer, options.choices, options.defaultValue)
    if ('value' in parsed) {
      const result = { status: 'selected', value: parsed.value } as const
      options.output.write(
        `${formatPromptEnd()}\n${formatSelectFinalLine(result, options.choices, options.summaryLabel)}\n`
      )
      return result
    }

    options.output.write(`${promptRail()}  ${parsed.error}\n`)
  }
}

async function promptLineMultiSelect <T extends string> (
  options: Required<Pick<MultiSelectPromptOptions<T>, 'title' | 'choices' | 'skipLabel' | 'summaryLabel' | 'input' | 'output'>> & {initialValues: readonly T[], colorEnabled: boolean}
): Promise<MultiSelectPromptResult<T>> {
  options.output.write(`${formatPromptTitle(options.title, options.colorEnabled)}\n`)

  options.choices.forEach((choice, index) => {
    const current = options.initialValues.includes(choice.value) ? ' (selected)' : ''
    options.output.write(`${promptRail(options.colorEnabled)}  ${index + 1}) ${choice.label}${current} - ${choice.description}\n`)
  })

  options.output.write(`${promptRail(options.colorEnabled)}  0) ${options.skipLabel}\n`)

  while (true) {
    const answer = await askLine(options.input, options.output, `${promptRail(options.colorEnabled)}  `)

    if (answer === undefined) {
      return { status: 'cancelled', values: [] }
    }

    const parsed = parseLineSelection(answer, options.choices, options.initialValues)

    if ('values' in parsed) {
      const result = resultFromValues(parsed.values)
      options.output.write(`${formatPromptEnd(options.colorEnabled)}\n${formatMultiSelectFinalLine(result, options.choices, options.summaryLabel)}\n`)
      return result
    }

    options.output.write(`${promptRail(options.colorEnabled)}  ${parsed.error}\n`)
  }
}

function promptRawSelect <T extends string> (
  options: Required<Pick<SelectPromptOptions<T>, 'title' | 'choices' | 'defaultValue' | 'summaryLabel' | 'input' | 'output'>> & {colorEnabled: boolean}
): Promise<SelectPromptResult<T>> {
  return new Promise((resolve) => {
    let focusedIndex = options.choices.findIndex(
      (choice) => choice.value === options.defaultValue
    )
    let settled = false
    let renderedRows = 0

    function lines (): string[] {
      return [
        ...formatPromptTitleLines(
          options.title,
          terminalColumns(options.output.columns),
          options.colorEnabled
        ),
        promptRail(options.colorEnabled),
        ...options.choices.flatMap((choice, index) => formatSelectChoiceLines(
          choice,
          focusedIndex === index,
          options.output,
          options.colorEnabled
        )),
        formatPromptEnd(options.colorEnabled)
      ]
    }

    function render (): void {
      renderedRows = renderPromptLines(options.output, lines(), renderedRows)
    }

    function cleanup (): void {
      options.input.removeListener('data', onData)
      try {
        options.input.setRawMode?.(false)
      } catch {
        // Continue restoring the remaining terminal state.
      }
      options.input.pause()
      options.output.write('\u001B[?25h')
    }

    function finish (result: SelectPromptResult<T>): void {
      if (settled) return
      settled = true
      cleanup()
      options.output.write(
        `${formatSelectFinalLine(result, options.choices, options.summaryLabel)}\n`
      )
      resolve(result)
    }

    function moveFocus (direction: 1 | -1): void {
      focusedIndex = (
        focusedIndex + direction + options.choices.length
      ) % options.choices.length
      render()
    }

    function handleKey (key: string): void {
      if (key === '\u0003' || key === '\u0004' || key === '\u001B') {
        finish({ status: 'cancelled' })
      } else if (key === '\r' || key === '\n') {
        const choice = options.choices[focusedIndex]
        if (choice !== undefined) {
          finish({ status: 'selected', value: choice.value })
        }
      } else if (key === 'k') {
        moveFocus(-1)
      } else if (key === 'j') {
        moveFocus(1)
      }
    }

    function handleText (text: string): void {
      for (let index = 0; index < text.length && !settled;) {
        if (text.startsWith('\u001B[A', index)) {
          moveFocus(-1)
          index += 3
        } else if (text.startsWith('\u001B[B', index)) {
          moveFocus(1)
          index += 3
        } else {
          handleKey(text[index] ?? '')
          index += 1
        }
      }
    }

    function onData (chunk: string | Buffer): void {
      handleText(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    }

    try {
      options.output.write('\u001B[?25l')
      options.input.setRawMode?.(true)
      options.input.resume()
      options.input.on('data', onData)
      render()
    } catch (error) {
      cleanup()
      throw error
    }
  })
}

function promptRawMultiSelect <T extends string> (
  options: Required<Pick<MultiSelectPromptOptions<T>, 'title' | 'choices' | 'skipLabel' | 'summaryLabel' | 'input' | 'output'>> & {initialValues: readonly T[], colorEnabled: boolean}
): Promise<MultiSelectPromptResult<T>> {
  return new Promise((resolve) => {
    const selected = new Set<T>(options.initialValues)
    let focusedIndex = options.choices.findIndex((choice) => selected.has(choice.value))
    if (focusedIndex === -1) focusedIndex = options.choices.length
    let settled = false
    let renderedRows = 0

    function lines (): string[] {
      return [
        ...formatPromptTitleLines(
          options.title,
          terminalColumns(options.output.columns),
          options.colorEnabled
        ),
        promptRail(options.colorEnabled),
        ...options.choices.flatMap((choice, index) => formatMultiSelectChoiceLines(
          choice,
          focusedIndex === index,
          selected.has(choice.value),
          options.output,
          options.colorEnabled
        )),
        ...formatSkipLines(
          options.skipLabel,
          focusedIndex === options.choices.length,
          selected.size,
          options.output,
          options.colorEnabled
        ),
        formatPromptEnd(options.colorEnabled)
      ]
    }

    function render (): void {
      const nextLines = lines()
      renderedRows = renderPromptLines(options.output, nextLines, renderedRows)
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

export async function promptSelect <T extends string> (
  options: SelectPromptOptions<T>
): Promise<SelectPromptResult<T>> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const env = options.env ?? process.env
  const summaryLabel = options.summaryLabel ?? 'Selection'
  const colorEnabled = env.NO_COLOR === undefined

  if (!options.choices.some((choice) => choice.value === options.defaultValue)) {
    throw new Error(
      `Select prompt default is not one of its choices: ${options.defaultValue}`
    )
  }

  if (!canPromptInteractively(input, output, env)) {
    return { status: 'non-interactive' }
  }

  const resolved = {
    title: options.title,
    choices: options.choices,
    defaultValue: options.defaultValue,
    summaryLabel,
    input,
    output,
    colorEnabled
  }

  if (typeof input.setRawMode !== 'function') {
    return promptLineSelect({
      title: resolved.title,
      choices: resolved.choices,
      defaultValue: resolved.defaultValue,
      summaryLabel: resolved.summaryLabel,
      input: resolved.input,
      output: resolved.output
    })
  }

  try {
    return await promptRawSelect(resolved)
  } catch {
    return promptLineSelect({
      title: resolved.title,
      choices: resolved.choices,
      defaultValue: resolved.defaultValue,
      summaryLabel: resolved.summaryLabel,
      input: resolved.input,
      output: resolved.output
    })
  }
}

export async function promptMultiSelect <T extends string> (
  options: MultiSelectPromptOptions<T>
): Promise<MultiSelectPromptResult<T>> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const env = options.env ?? process.env
  const summaryLabel = options.summaryLabel ?? 'Selection'
  const initialValues = options.initialValues ?? []
  const colorEnabled = env.NO_COLOR === undefined

  for (const value of initialValues) {
    if (!options.choices.some((choice) => choice.value === value)) {
      throw new Error(`Multi-select initial value is not one of its choices: ${value}`)
    }
  }

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
      output,
      initialValues,
      colorEnabled
    })
  }

  try {
    return await promptRawMultiSelect({
      title: options.title,
      choices: options.choices,
      skipLabel: options.skipLabel,
      summaryLabel,
      input,
      output,
      initialValues,
      colorEnabled
    })
  } catch {
    return promptLineMultiSelect({
      title: options.title,
      choices: options.choices,
      skipLabel: options.skipLabel,
      summaryLabel,
      input,
      output,
      initialValues,
      colorEnabled
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
    output.write(`${formatPromptDetailLine(detail)}\n`)
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
    options.output.write(`${formatPromptDetailLine(detail)}\n`)
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
    let renderedRows = 0

    function lines (): string[] {
      return [
        formatPromptTitle(options.title),
        promptRail(),
        ...options.details.map((detail) => formatPromptDetailLine(detail)),
        formatConfirmLine(options.cancelLabel, focusedIndex === 0),
        formatConfirmLine(options.confirmLabel, focusedIndex === 1),
        formatPromptEnd()
      ]
    }

    function render (): void {
      const nextLines = lines()
      renderedRows = renderPromptLines(options.output, nextLines, renderedRows)
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
