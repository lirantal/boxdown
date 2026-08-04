import { posix, win32 } from 'node:path'
import { applyEdits, createScanner, findNodeAtLocation, getNodeValue, modify, parseTree, printParseErrorCode, type FormattingOptions, type ModificationOptions, type Node as JsonNode, type ParseError } from 'jsonc-parser'

import { shellQuote } from './shell.ts'
import { defaultSshConfigPath, validateSshAlias } from './ssh-config.ts'

export function defaultCursorSettingsPath (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.BOXDOWN_CURSOR_SETTINGS !== undefined) {
    if (env.BOXDOWN_CURSOR_SETTINGS.length === 0) {
      throw new Error('BOXDOWN_CURSOR_SETTINGS must be a non-empty path')
    }
    return env.BOXDOWN_CURSOR_SETTINGS
  }
  if (platform === 'win32') {
    const home = nonEmptyEnvironmentValue(env.USERPROFILE) ?? nonEmptyEnvironmentValue(env.HOME)
    const appData = nonEmptyEnvironmentValue(env.APPDATA) ?? (home === undefined ? undefined : win32.join(home, 'AppData', 'Roaming'))
    if (appData === undefined) throw new Error('Cannot resolve the Windows Cursor settings directory')
    return win32.join(appData, 'Cursor', 'User', 'settings.json')
  }
  const home = nonEmptyEnvironmentValue(env.HOME)
  if (platform === 'darwin') {
    if (home === undefined) throw new Error('Cannot resolve the macOS Cursor settings directory')
    return posix.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json')
  }
  const configHome = nonEmptyEnvironmentValue(env.XDG_CONFIG_HOME) ?? (home === undefined ? undefined : posix.join(home, '.config'))
  if (configHome === undefined) throw new Error('Cannot resolve the Linux Cursor settings directory')
  return posix.join(configHome, 'Cursor', 'User', 'settings.json')
}

function nonEmptyEnvironmentValue (value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value
}

export function cursorRemoteFolderUri (alias: string, workspaceBasename: string): string {
  validateSshAlias(alias)
  const encodedBasename = encodeURIComponent(workspaceBasename).replaceAll("'", '%27')
  return `vscode-remote://ssh-remote+${alias}/workspaces/${encodedBasename}`
}

export function formatCursorFolderCommand (folderUri: string, platform: NodeJS.Platform = process.platform): { label?: 'PowerShell', command: string } {
  if (platform === 'win32') {
    const quoted = `'${folderUri.replaceAll("'", "''")}'`
    return { label: 'PowerShell', command: `cursor --folder-uri ${quoted}` }
  }
  return { command: `cursor --folder-uri ${shellQuote(folderUri)}` }
}

const REMOTE_PLATFORM_PATH = ['remote.SSH.remotePlatform'] as const

function parseCursorRoot (text: string, settingsPath = 'Cursor settings'): { bom: string, body: string, formattingText: string, root: JsonNode } {
  const bom = text.startsWith('\ufeff') ? '\ufeff' : ''
  const formattingText = bom === '' ? text : text.slice(1)
  const source = formattingText.trim().length === 0 ? '{}' : formattingText
  const errors: ParseError[] = []
  const root = parseTree(source, errors, { allowTrailingComma: true })
  if (errors.length > 0 || root === undefined || root.type !== 'object') {
    const detail = errors[0] === undefined
      ? 'top-level value must be an object'
      : parseErrorDetail(source, errors[0])
    throw new Error(`Invalid Cursor settings JSONC: ${settingsPath} (${detail})`)
  }
  return { bom, body: source, formattingText, root }
}

function parseErrorDetail (text: string, error: ParseError): string {
  const prefix = text.slice(0, error.offset)
  const lines = prefix.split(/\r\n|\r|\n/u)
  const column = (lines.at(-1)?.length ?? 0) + 1
  return `${printParseErrorCode(error.error)} at offset ${error.offset}, line ${lines.length}, column ${column}`
}

function formattingOptionsFor (text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const indented = text.match(/(?:^|\r?\n)([\t ]+)"/u)?.[1] ?? '  '
  return indented.includes('\t')
    ? { eol, insertSpaces: false, tabSize: 1, keepLines: true }
    : { eol, insertSpaces: true, tabSize: Math.max(1, indented.length), keepLines: true }
}

function modificationOptionsFor (text: string, formattingText = text): ModificationOptions {
  return formattingText.trim().length === 0 || /[\r\n]/u.test(text)
    ? { formattingOptions: formattingOptionsFor(formattingText) }
    : {}
}

function objectPropertiesNamed (objectNode: JsonNode, propertyName: string): JsonNode[] {
  return (objectNode.children ?? []).filter(property => (
    property.type === 'property' &&
    property.children?.[0]?.value === propertyName
  ))
}

function requireUniqueProperty (objectNode: JsonNode, propertyName: string): JsonNode | undefined {
  const properties = objectPropertiesNamed(objectNode, propertyName)
  if (properties.length > 1) {
    throw new Error(`Duplicate Cursor setting is not safe to edit: ${propertyName}`)
  }
  return properties[0]
}

function propertyValueNode (property: JsonNode | undefined): JsonNode | undefined {
  return property?.children?.[1]
}

function validateRelevantRootProperties (root: JsonNode): {
  configFileNode: JsonNode | undefined
  remotePlatformNode: JsonNode | undefined
} {
  const configFileNode = propertyValueNode(requireUniqueProperty(root, 'remote.SSH.configFile'))
  const remotePlatformNode = propertyValueNode(requireUniqueProperty(root, REMOTE_PLATFORM_PATH[0]))
  return { configFileNode, remotePlatformNode }
}

function remoteAliasNode (remotePlatformNode: JsonNode | undefined, alias: string): JsonNode | undefined {
  if (remotePlatformNode === undefined) return undefined
  if (remotePlatformNode.type !== 'object') {
    throw new Error('Cursor setting remote.SSH.remotePlatform must be an object')
  }
  requireUniqueProperty(remotePlatformNode, alias)
  return findNodeAtLocation(remotePlatformNode, [alias])
}

function platformPathFunctions (platform: NodeJS.Platform): {
  isAbsolutePath: (path: string) => boolean
  resolvePath: (path: string) => string
} {
  return platform === 'win32'
    ? { isAbsolutePath: win32.isAbsolute, resolvePath: win32.resolve }
    : { isAbsolutePath: posix.isAbsolute, resolvePath: posix.resolve }
}

export function validateCursorSshConfigCompatibility (
  settingsText: string,
  settingsPath: string,
  boxdownSshConfigPath: string,
  options: { platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv } = {}
): { cursorSshConfigPath: string, source: 'default' | 'setting' } {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const { root } = parseCursorRoot(settingsText, settingsPath)
  const { configFileNode } = validateRelevantRootProperties(root)
  const configuredValue: unknown = configFileNode === undefined ? undefined : getNodeValue(configFileNode)

  if (configuredValue !== undefined && typeof configuredValue !== 'string') {
    throw new Error(`Cursor setting remote.SSH.configFile in ${settingsPath} must be a string`)
  }

  const usesDefault = configuredValue === undefined || configuredValue === ''
  const source = usesDefault ? 'default' : 'setting'
  const selectedPath: string = usesDefault
    ? defaultSshConfigPath(env, platform)
    : configuredValue as string
  const { isAbsolutePath, resolvePath } = platformPathFunctions(platform)
  if (source === 'setting' && !isAbsolutePath(selectedPath)) {
    throw new Error(`Cursor setting remote.SSH.configFile in ${settingsPath} must be an absolute path: ${selectedPath}`)
  }

  const cursorSshConfigPath = resolvePath(selectedPath)
  const resolvedBoxdownPath = resolvePath(boxdownSshConfigPath)
  const comparableCursorPath = platform === 'win32' ? cursorSshConfigPath.toLowerCase() : cursorSshConfigPath
  const comparableBoxdownPath = platform === 'win32' ? resolvedBoxdownPath.toLowerCase() : resolvedBoxdownPath
  if (comparableCursorPath !== comparableBoxdownPath) {
    throw new Error(
      `Cursor SSH config ${cursorSshConfigPath} does not match Boxdown SSH config ${resolvedBoxdownPath}. ` +
      'Point remote.SSH.configFile at the Boxdown SSH config, or run Boxdown with BOXDOWN_SSH_CONFIG set to the Cursor SSH config.'
    )
  }

  return { cursorSshConfigPath, source }
}

function assertMergedAlias (text: string, alias: string): void {
  const { root } = parseCursorRoot(text)
  const { remotePlatformNode } = validateRelevantRootProperties(root)
  const aliasNode = remoteAliasNode(remotePlatformNode, alias)
  if (aliasNode === undefined || getNodeValue(aliasNode) !== 'linux') {
    throw new Error(`Failed to set Cursor remote platform for ${alias}`)
  }
}

export function mergeCursorRemotePlatform (settingsText: string, alias: string): { text: string, changed: boolean, state: 'inserted' | 'existing-linux' } {
  validateSshAlias(alias)
  const { bom, body, formattingText, root } = parseCursorRoot(settingsText)
  const { remotePlatformNode } = validateRelevantRootProperties(root)
  const aliasNode = remoteAliasNode(remotePlatformNode, alias)
  if (aliasNode !== undefined) {
    const currentValue: unknown = getNodeValue(aliasNode)
    if (currentValue === 'linux') {
      return { text: settingsText, changed: false, state: 'existing-linux' }
    }
    throw new Error(`Cursor remote platform for ${alias} is ${JSON.stringify(currentValue)}; expected "linux"`)
  }

  const edits = modify(body, [...REMOTE_PLATFORM_PATH, alias], 'linux', modificationOptionsFor(body, formattingText))
  const mergedBody = applyEdits(body, edits)
  assertMergedAlias(mergedBody, alias)
  return { text: bom + mergedBody, changed: true, state: 'inserted' }
}

function propertyNodeForValue (valueNode: JsonNode): JsonNode {
  const propertyNode = valueNode.parent
  if (propertyNode === undefined || propertyNode.type !== 'property') {
    throw new Error('Invalid Cursor settings JSONC: alias value is not an object property')
  }
  return propertyNode
}

function selectedAliasHasCommentTrivia (text: string, remotePlatformNode: JsonNode, aliasValueNode: JsonNode): boolean {
  const propertyNode = propertyNodeForValue(aliasValueNode)
  const properties = remotePlatformNode.children ?? []
  const selectedIndex = properties.indexOf(propertyNode)
  if (selectedIndex < 0) {
    throw new Error('Invalid Cursor settings JSONC: alias property is detached from its parent')
  }

  const previousValue = propertyValueNode(properties[selectedIndex - 1])
  const nextKey = properties[selectedIndex + 1]?.children?.[0]
  const triviaStart = previousValue === undefined
    ? remotePlatformNode.offset + 1
    : previousValue.offset + previousValue.length
  const triviaEnd = nextKey === undefined
    ? remotePlatformNode.offset + remotePlatformNode.length - 1
    : nextKey.offset
  const scanner = createScanner(text, false)
  scanner.setPosition(triviaStart)
  const lineCommentTrivia = 12
  const blockCommentTrivia = 13
  const endOfFile = 17
  for (let token = scanner.scan(); token !== endOfFile && scanner.getTokenOffset() < triviaEnd; token = scanner.scan()) {
    if (token === lineCommentTrivia || token === blockCommentTrivia) return true
  }
  return false
}

function assertRemovedAlias (text: string, alias: string): void {
  const { root } = parseCursorRoot(text)
  const { remotePlatformNode } = validateRelevantRootProperties(root)
  if (remoteAliasNode(remotePlatformNode, alias) !== undefined) {
    throw new Error(`Failed to remove Cursor remote platform for ${alias}`)
  }
}

export function removeCursorRemotePlatform (settingsText: string, alias: string): { text: string, changed: boolean, retainedBecause?: 'attached-comment' | 'missing' | 'changed-value' } {
  validateSshAlias(alias)
  const { bom, body, root } = parseCursorRoot(settingsText)
  const { remotePlatformNode } = validateRelevantRootProperties(root)
  const aliasNode = remoteAliasNode(remotePlatformNode, alias)
  if (aliasNode === undefined) {
    return { text: settingsText, changed: false, retainedBecause: 'missing' }
  }
  if (getNodeValue(aliasNode) !== 'linux') {
    return { text: settingsText, changed: false, retainedBecause: 'changed-value' }
  }
  if (remotePlatformNode === undefined) {
    throw new Error('Invalid Cursor settings JSONC: missing remote platform parent')
  }
  if (selectedAliasHasCommentTrivia(body, remotePlatformNode, aliasNode)) {
    return { text: settingsText, changed: false, retainedBecause: 'attached-comment' }
  }

  const edits = modify(body, [...REMOTE_PLATFORM_PATH, alias], undefined, modificationOptionsFor(body))
  const removedBody = applyEdits(body, edits)
  assertRemovedAlias(removedBody, alias)
  return { text: bom + removedBody, changed: true }
}
