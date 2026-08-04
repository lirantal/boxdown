import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { dirname, join } from 'node:path'
import { applyEdits, createScanner, findNodeAtLocation, getNodeValue, modify, parseTree, printParseErrorCode, type FormattingOptions, type ModificationOptions, type Node as JsonNode, type ParseError } from 'jsonc-parser'

import type { WorkspaceContext } from './paths.ts'
import { shellQuote } from './shell.ts'
import { defaultSshConfigPath, validateSshAlias } from './ssh-config.ts'

export const CURSOR_INTEGRATION_VERSION = 1
export const CURSOR_INTEGRATION_FILENAME = 'cursor-integration.json'

export interface CursorRemotePlatformMapping {
  alias: string
  settingsPath: string
  remotePlatformOwned: boolean
}

export interface CursorIntegrationRecord {
  version: 1
  mappings: CursorRemotePlatformMapping[]
}

export type CursorMappingDisposition = 'installed' | 'already-boxdown-managed' | 'preserved-user-owned'

export interface CursorInstallResult {
  settingsPath: string
  sshConfigPath: string
  folderUri: string
  commandLabel?: 'PowerShell'
  command: string
  disposition: CursorMappingDisposition
  settingsChanged: boolean
  ownershipChanged: boolean
}

export interface CursorUninstallResult {
  settingsPath: string
  aliases: readonly string[]
  settingsChanged: boolean
  ownershipChanged: boolean
  retainedBecause?: 'user-owned' | 'shared-owner' | 'user-modified' | 'uncertain-peer'
}

export interface CursorOperationOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  settingsPath?: string
  sshConfigPath?: string
  lockTimeoutMs?: number
  staleLockMs?: number
  now?: () => Date
  sleep?: (milliseconds: number) => Promise<void>
  pidIsAlive?: (pid: number) => boolean
  createNonce?: () => string
}

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

export function cursorIntegrationPath (context: WorkspaceContext): string {
  return join(context.workspaceDataDir, CURSOR_INTEGRATION_FILENAME)
}

const CURSOR_LOCK_DIRECTORY = 'cursor-integration.lock'
const CURSOR_LOCK_OWNER_FILENAME = 'owner.json'
const DEFAULT_LOCK_TIMEOUT_MS = 5_000
const DEFAULT_STALE_LOCK_MS = 600_000

interface FileSnapshot {
  exists: boolean
  text?: string
  mode?: number
}

interface OwnershipScan {
  records: Array<{ path: string, record: CursorIntegrationRecord }>
  complete: boolean
}

interface LockOwner {
  pid: number
  timestamp: string
  nonce: string
}

interface LockToken {
  path: string
  nonce: string
}

class MissingLockOwnerError extends Error {
  constructor (lockPath: string, cause: unknown) {
    super(lockPath, { cause })
  }
}

function errorCode (error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined
}

function normalizeSettingsPath (settingsPath: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? win32.resolve(settingsPath) : posix.resolve(settingsPath)
}

function comparableSettingsPath (settingsPath: string): string {
  return posix.isAbsolute(settingsPath)
    ? posix.resolve(settingsPath)
    : win32.resolve(settingsPath).toLowerCase()
}

function sameMapping (left: CursorRemotePlatformMapping, right: CursorRemotePlatformMapping): boolean {
  return left.alias === right.alias && comparableSettingsPath(left.settingsPath) === comparableSettingsPath(right.settingsPath)
}

function readFileSnapshot (path: string): FileSnapshot {
  try {
    return {
      exists: true,
      text: readFileSync(path, 'utf8'),
      mode: statSync(path).mode & 0o777
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { exists: false }
    throw error
  }
}

function atomicWriteFile (path: string, contents: string, defaultMode: number, createNonce: () => string): void {
  const destinationPath = existsSync(path) ? realpathSync(path) : path
  const existingMode = existsSync(destinationPath) ? statSync(destinationPath).mode & 0o777 : undefined
  const mode = existingMode ?? defaultMode
  const temporaryPath = join(dirname(destinationPath), `.${destinationPath.split(/[\\/]/u).at(-1) ?? 'cursor'}.tmp-${process.pid}-${createNonce()}`)
  mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(temporaryPath, contents, { flag: 'wx', mode })
    chmodSync(temporaryPath, mode)
    renameSync(temporaryPath, destinationPath)
  } finally {
    try {
      rmSync(temporaryPath, { force: true })
    } catch {
      // Preserve the original write error when best-effort temporary cleanup also fails.
    }
  }
}

function restoreFileSnapshot (path: string, snapshot: FileSnapshot, createNonce: () => string): void {
  if (!snapshot.exists) {
    try {
      unlinkSync(path)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    return
  }
  atomicWriteFile(path, snapshot.text ?? '', snapshot.mode ?? 0o600, createNonce)
}

function parseIntegrationRecord (text: string, path: string): CursorIntegrationRecord {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`Invalid Cursor integration record: ${path}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Cursor integration record: ${path}`)
  }
  const candidate = value as Record<string, unknown>
  if (candidate.version !== CURSOR_INTEGRATION_VERSION || !Array.isArray(candidate.mappings)) {
    throw new Error(`Invalid Cursor integration record: ${path}`)
  }
  const mappings = candidate.mappings.map((mapping): CursorRemotePlatformMapping => {
    if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) {
      throw new Error(`Invalid Cursor integration record: ${path}`)
    }
    const entry = mapping as Record<string, unknown>
    if (typeof entry.alias !== 'string' || typeof entry.settingsPath !== 'string' || typeof entry.remotePlatformOwned !== 'boolean') {
      throw new Error(`Invalid Cursor integration record: ${path}`)
    }
    try {
      validateSshAlias(entry.alias)
    } catch {
      throw new Error(`Invalid Cursor integration record: ${path}`)
    }
    if (entry.settingsPath.length === 0 || (!posix.isAbsolute(entry.settingsPath) && !win32.isAbsolute(entry.settingsPath))) {
      throw new Error(`Invalid Cursor integration record: ${path}`)
    }
    return {
      alias: entry.alias,
      settingsPath: entry.settingsPath,
      remotePlatformOwned: entry.remotePlatformOwned
    }
  })
  return { version: CURSOR_INTEGRATION_VERSION, mappings }
}

function readIntegrationRecordSnapshot (path: string): { snapshot: FileSnapshot, record?: CursorIntegrationRecord } {
  const snapshot = readFileSnapshot(path)
  return {
    snapshot,
    record: snapshot.exists ? parseIntegrationRecord(snapshot.text ?? '', path) : undefined
  }
}

function scanIntegrationRecords (context: WorkspaceContext): OwnershipScan {
  const workspacesPath = join(context.dataRoot, 'workspaces')
  let entries
  try {
    entries = readdirSync(workspacesPath, { withFileTypes: true })
  } catch (error) {
    return { records: [], complete: errorCode(error) === 'ENOENT' }
  }
  const records: OwnershipScan['records'] = []
  let complete = true
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(workspacesPath, entry.name, CURSOR_INTEGRATION_FILENAME)
    try {
      const snapshot = readFileSnapshot(path)
      if (snapshot.exists) records.push({ path, record: parseIntegrationRecord(snapshot.text ?? '', path) })
    } catch {
      complete = false
    }
  }
  return { records, complete }
}

function serializeIntegrationRecord (record: CursorIntegrationRecord): string {
  return `${JSON.stringify(record, undefined, 2)}\n`
}

function persistIntegrationRecord (path: string, record: CursorIntegrationRecord, createNonce: () => string): void {
  if (record.mappings.length === 0) {
    try {
      unlinkSync(path)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    return
  }
  atomicWriteFile(path, serializeIntegrationRecord(record), 0o600, createNonce)
}

function parseLockOwner (text: string, lockPath: string): LockOwner {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`Malformed Cursor integration lock: ${lockPath}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed Cursor integration lock: ${lockPath}`)
  }
  const candidate = value as Record<string, unknown>
  if (!Number.isInteger(candidate.pid) || (candidate.pid as number) <= 0 ||
      typeof candidate.timestamp !== 'string' || !Number.isFinite(Date.parse(candidate.timestamp)) ||
      typeof candidate.nonce !== 'string' || candidate.nonce.length === 0) {
    throw new Error(`Malformed Cursor integration lock: ${lockPath}`)
  }
  return { pid: candidate.pid as number, timestamp: candidate.timestamp, nonce: candidate.nonce }
}

function readLockOwner (lockPath: string): LockOwner {
  try {
    return parseLockOwner(readFileSync(join(lockPath, CURSOR_LOCK_OWNER_FILENAME), 'utf8'), lockPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new MissingLockOwnerError(lockPath, error)
    if (error instanceof Error && error.message.startsWith('Malformed Cursor integration lock:')) throw error
    throw new Error(`Malformed Cursor integration lock: ${lockPath}`, { cause: error })
  }
}

function defaultPidIsAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    if (errorCode(error) === 'EPERM') return true
    throw error
  }
}

function sameLockOwner (left: LockOwner, right: LockOwner): boolean {
  return left.pid === right.pid && left.timestamp === right.timestamp && left.nonce === right.nonce
}

function reclaimLock (lockPath: string, observed: LockOwner): boolean {
  let current: LockOwner
  try {
    current = readLockOwner(lockPath)
  } catch {
    return false
  }
  if (!sameLockOwner(current, observed)) return false
  try {
    unlinkSync(join(lockPath, CURSOR_LOCK_OWNER_FILENAME))
    rmdirSync(lockPath)
    return true
  } catch {
    return false
  }
}

async function acquireIntegrationLock (context: WorkspaceContext, options: CursorOperationOptions): Promise<LockToken> {
  const lockPath = join(context.dataRoot, CURSOR_LOCK_DIRECTORY)
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS
  const now = options.now ?? (() => new Date())
  const sleep = options.sleep ?? (async (milliseconds: number) => await new Promise(resolve => setTimeout(resolve, milliseconds)))
  const pidIsAlive = options.pidIsAlive ?? defaultPidIsAlive
  const createNonce = options.createNonce ?? randomUUID
  const startedAt = now().getTime()

  mkdirSync(context.dataRoot, { recursive: true, mode: 0o700 })
  for (;;) {
    const nonce = createNonce()
    const owner: LockOwner = { pid: process.pid, timestamp: now().toISOString(), nonce }
    try {
      mkdirSync(lockPath, { mode: 0o700 })
      try {
        writeFileSync(join(lockPath, CURSOR_LOCK_OWNER_FILENAME), serializeLockOwner(owner), { flag: 'wx', mode: 0o600 })
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true })
        throw error
      }
      return { path: lockPath, nonce }
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }

    let observed: LockOwner
    try {
      observed = readLockOwner(lockPath)
    } catch (error) {
      if (!(error instanceof MissingLockOwnerError)) throw error
      const elapsed = now().getTime() - startedAt
      if (elapsed >= timeoutMs) throw new Error(`Cursor integration lock timed out: ${lockPath}`, { cause: error })
      await sleep(Math.min(50, timeoutMs - elapsed))
      continue
    }
    const age = now().getTime() - Date.parse(observed.timestamp)
    if (age >= staleLockMs) {
      let alive: boolean
      try {
        alive = pidIsAlive(observed.pid)
      } catch (error) {
        if (errorCode(error) === 'EPERM') alive = true
        else throw new Error(`Cannot verify the owner of Cursor integration lock: ${lockPath}`, { cause: error })
      }
      if (!alive && reclaimLock(lockPath, observed)) continue
    }

    const elapsed = now().getTime() - startedAt
    if (elapsed >= timeoutMs) throw new Error(`Cursor integration lock timed out: ${lockPath}`)
    await sleep(Math.min(50, timeoutMs - elapsed))
  }
}

function serializeLockOwner (owner: LockOwner): string {
  return `${JSON.stringify(owner)}\n`
}

function releaseIntegrationLock (token: LockToken): void {
  let owner: LockOwner
  try {
    owner = readLockOwner(token.path)
  } catch {
    return
  }
  if (owner.nonce !== token.nonce || owner.pid !== process.pid) return
  try {
    unlinkSync(join(token.path, CURSOR_LOCK_OWNER_FILENAME))
    rmdirSync(token.path)
  } catch {
    // A changed or externally damaged lock is safer to retain than to remove.
  }
}

async function withIntegrationLock<T> (context: WorkspaceContext, options: CursorOperationOptions, operation: () => T | Promise<T>): Promise<T> {
  const token = await acquireIntegrationLock(context, options)
  try {
    return await operation()
  } finally {
    releaseIntegrationLock(token)
  }
}

function hasMatchingOwner (scan: OwnershipScan, mapping: CursorRemotePlatformMapping, excludedRecordPath?: string): boolean {
  return scan.records.some(({ path, record }) => path !== excludedRecordPath && record.mappings.some(candidate => (
    candidate.remotePlatformOwned && sameMapping(candidate, mapping)
  )))
}

function recordsEqual (left: CursorIntegrationRecord, right: CursorIntegrationRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export async function installCursorSshTarget (
  context: WorkspaceContext,
  alias: string,
  options: CursorOperationOptions = {}
): Promise<CursorInstallResult> {
  validateSshAlias(alias)
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const settingsPath = normalizeSettingsPath(options.settingsPath ?? defaultCursorSettingsPath(env, platform), platform)
  const sshConfigPath = normalizeSettingsPath(options.sshConfigPath ?? defaultSshConfigPath(env, platform), platform)
  const createNonce = options.createNonce ?? randomUUID

  return await withIntegrationLock(context, options, () => {
    const settingsSnapshot = readFileSnapshot(settingsPath)
    const settingsText = settingsSnapshot.text ?? ''
    validateCursorSshConfigCompatibility(settingsText, settingsPath, sshConfigPath, { platform, env })
    const merged = mergeCursorRemotePlatform(settingsText, alias)
    const scan = scanIntegrationRecords(context)
    const recordPath = cursorIntegrationPath(context)
    const { snapshot: recordSnapshot, record: existingRecord } = readIntegrationRecordSnapshot(recordPath)
    const candidate: CursorRemotePlatformMapping = { alias, settingsPath, remotePlatformOwned: false }
    const matchingOwner = hasMatchingOwner(scan, candidate)
    if (merged.state === 'existing-linux' && !matchingOwner && !scan.complete) {
      throw new Error(`Cursor ownership is uncertain because an integration record could not be read under ${join(context.dataRoot, 'workspaces')}`)
    }
    const remotePlatformOwned = merged.state === 'inserted' || matchingOwner
    const nextMapping: CursorRemotePlatformMapping = { ...candidate, remotePlatformOwned }
    const previousRecord: CursorIntegrationRecord = existingRecord ?? { version: CURSOR_INTEGRATION_VERSION, mappings: [] }
    const existingIndex = previousRecord.mappings.findIndex(mapping => sameMapping(mapping, nextMapping))
    const nextMappings = [...previousRecord.mappings]
    if (existingIndex < 0) nextMappings.push(nextMapping)
    else nextMappings[existingIndex] = nextMapping
    const nextRecord: CursorIntegrationRecord = { version: CURSOR_INTEGRATION_VERSION, mappings: nextMappings }
    const ownershipChanged = !recordsEqual(previousRecord, nextRecord)

    if (ownershipChanged) persistIntegrationRecord(recordPath, nextRecord, createNonce)
    try {
      if (merged.changed) atomicWriteFile(settingsPath, merged.text, 0o600, createNonce)
    } catch (error) {
      if (ownershipChanged) restoreFileSnapshot(recordPath, recordSnapshot, createNonce)
      throw error
    }

    const folderUri = cursorRemoteFolderUri(alias, context.workspaceBasename)
    const formatted = formatCursorFolderCommand(folderUri, platform)
    return {
      settingsPath,
      sshConfigPath,
      folderUri,
      ...(formatted.label === undefined ? {} : { commandLabel: formatted.label }),
      command: formatted.command,
      disposition: merged.state === 'inserted'
        ? 'installed'
        : remotePlatformOwned ? 'already-boxdown-managed' : 'preserved-user-owned',
      settingsChanged: merged.changed,
      ownershipChanged
    }
  })
}

function removeOneRecordMapping (record: CursorIntegrationRecord, selected: CursorRemotePlatformMapping): CursorIntegrationRecord {
  const index = record.mappings.findIndex(mapping => (
    mapping.remotePlatformOwned === selected.remotePlatformOwned && sameMapping(mapping, selected)
  ))
  if (index < 0) return record
  return {
    version: CURSOR_INTEGRATION_VERSION,
    mappings: [...record.mappings.slice(0, index), ...record.mappings.slice(index + 1)]
  }
}

async function uninstallCursorMappings (
  context: WorkspaceContext,
  select: (mapping: CursorRemotePlatformMapping) => boolean,
  options: CursorOperationOptions
): Promise<CursorUninstallResult[]> {
  const createNonce = options.createNonce ?? randomUUID
  return await withIntegrationLock(context, options, () => {
    const recordPath = cursorIntegrationPath(context)
    const { record } = readIntegrationRecordSnapshot(recordPath)
    if (record === undefined) return []
    const selectedMappings = record.mappings.filter(select)
    if (selectedMappings.length === 0) return []
    const scan = scanIntegrationRecords(context)
    let currentRecord = record
    const results: CursorUninstallResult[] = []

    for (const mapping of selectedMappings) {
      let settingsChanged = false
      let retainedBecause: CursorUninstallResult['retainedBecause']
      if (!mapping.remotePlatformOwned) {
        retainedBecause = 'user-owned'
      } else if (hasMatchingOwner(scan, mapping, recordPath)) {
        retainedBecause = 'shared-owner'
      } else if (!scan.complete) {
        retainedBecause = 'uncertain-peer'
      } else {
        const settingsSnapshot = readFileSnapshot(mapping.settingsPath)
        if (!settingsSnapshot.exists) {
          retainedBecause = 'user-modified'
        } else {
          const removed = removeCursorRemotePlatform(settingsSnapshot.text ?? '', mapping.alias)
          if (removed.changed) {
            atomicWriteFile(mapping.settingsPath, removed.text, 0o600, createNonce)
            settingsChanged = true
          } else {
            retainedBecause = 'user-modified'
          }
        }
      }

      const nextRecord = removeOneRecordMapping(currentRecord, mapping)
      persistIntegrationRecord(recordPath, nextRecord, createNonce)
      currentRecord = nextRecord
      results.push({
        settingsPath: mapping.settingsPath,
        aliases: [mapping.alias],
        settingsChanged,
        ownershipChanged: true,
        ...(retainedBecause === undefined ? {} : { retainedBecause })
      })
    }
    return results
  })
}

export async function uninstallCursorSshTarget (
  context: WorkspaceContext,
  alias: string,
  options: CursorOperationOptions = {}
): Promise<CursorUninstallResult[]> {
  validateSshAlias(alias)
  return await uninstallCursorMappings(context, mapping => mapping.alias === alias, options)
}

export async function uninstallCursorWorkspaceTarget (
  context: WorkspaceContext,
  options: CursorOperationOptions = {}
): Promise<CursorUninstallResult[]> {
  return await uninstallCursorMappings(context, () => true, options)
}
