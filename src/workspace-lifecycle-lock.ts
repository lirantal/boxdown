import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { WorkspaceContext } from './paths.ts'

const WORKSPACE_LIFECYCLE_LOCK_DIRECTORY = 'lifecycle.lock'
const LOCK_OWNER_FILENAME = 'owner.json'
const DEFAULT_LOCK_TIMEOUT_MS = 300_000
const MAX_LOCK_OWNER_BYTES = 16_384

export interface WorkspaceLifecycleLockOptions {
  lockTimeoutMs?: number
  now?: () => Date
  sleep?: (milliseconds: number) => Promise<void>
  pidIsAlive?: (pid: number) => boolean
  createNonce?: () => string
  onWait?: () => void
}

export interface LockOwner {
  pid: number
  timestamp: string
  nonce: string
}

interface LockToken {
  path: string
  owner: LockOwner
}

class MissingLockOwnerError extends Error {}

function errorCode (error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined
}

function serializeLockOwner (owner: LockOwner): string {
  return `${JSON.stringify(owner)}\n`
}

function parseLockOwner (text: string, lockPath: string): LockOwner {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`Malformed workspace lifecycle lock: ${lockPath}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed workspace lifecycle lock: ${lockPath}`)
  }

  const candidate = value as Record<string, unknown>
  if (!Number.isInteger(candidate.pid) || (candidate.pid as number) <= 0 ||
      typeof candidate.timestamp !== 'string' || !Number.isFinite(Date.parse(candidate.timestamp)) ||
      typeof candidate.nonce !== 'string' || candidate.nonce.length === 0) {
    throw new Error(`Malformed workspace lifecycle lock: ${lockPath}`)
  }

  return {
    pid: candidate.pid as number,
    timestamp: candidate.timestamp,
    nonce: candidate.nonce
  }
}

function readLockOwner (lockPath: string): LockOwner {
  try {
    const ownerPath = join(lockPath, LOCK_OWNER_FILENAME)
    const text = readFileSync(ownerPath, 'utf8')
    if (Buffer.byteLength(text, 'utf8') > MAX_LOCK_OWNER_BYTES) {
      throw new Error(`Workspace lifecycle lock owner exceeds ${MAX_LOCK_OWNER_BYTES} bytes: ${lockPath}`)
    }
    return parseLockOwner(text, lockPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new MissingLockOwnerError(lockPath, { cause: error })
    }
    if (error instanceof MissingLockOwnerError || (error instanceof Error && error.message.startsWith('Malformed workspace lifecycle lock:'))) {
      throw error
    }
    throw new Error(`Malformed workspace lifecycle lock: ${lockPath}`, { cause: error })
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

function reclaimedLockPath (lockPath: string, owner: LockOwner): string {
  const generation = createHash('sha256')
    .update(serializeLockOwner(owner))
    .digest('hex')
  return `${lockPath}.reclaimed-${generation}`
}

export function reclaimWorkspaceLifecycleLock (
  lockPath: string,
  observed: LockOwner,
  moveLock: (source: string, destination: string) => void = renameSync
): boolean {
  let current: LockOwner
  try {
    current = readLockOwner(lockPath)
  } catch {
    return false
  }
  if (!sameLockOwner(current, observed)) return false

  const reclaimedPath = reclaimedLockPath(lockPath, observed)
  try {
    // Keep the non-empty destination as a generation tombstone. A late
    // reclaimer for this owner then cannot rename a replacement lock over it.
    moveLock(lockPath, reclaimedPath)
  } catch {
    return false
  }

  let reclaimed: LockOwner
  try {
    reclaimed = readLockOwner(reclaimedPath)
  } catch (error) {
    throw new Error(`Cannot verify reclaimed workspace lifecycle lock: ${reclaimedPath}`, { cause: error })
  }
  if (!sameLockOwner(reclaimed, observed)) {
    throw new Error(`Workspace lifecycle lock changed during reclamation: ${lockPath}`)
  }
  return true
}

async function acquireWorkspaceLifecycleLock (
  context: WorkspaceContext,
  options: WorkspaceLifecycleLockOptions
): Promise<LockToken> {
  const lockPath = join(context.workspaceDataDir, WORKSPACE_LIFECYCLE_LOCK_DIRECTORY)
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const now = options.now ?? (() => new Date())
  const sleep = options.sleep ?? (async (milliseconds: number) => await new Promise(resolve => setTimeout(resolve, milliseconds)))
  const pidIsAlive = options.pidIsAlive ?? defaultPidIsAlive
  const createNonce = options.createNonce ?? randomUUID
  const startedAt = now().getTime()
  let waitNotified = false

  mkdirSync(context.workspaceDataDir, { recursive: true, mode: 0o700 })
  for (;;) {
    const owner: LockOwner = { pid: process.pid, timestamp: now().toISOString(), nonce: createNonce() }
    try {
      mkdirSync(lockPath, { mode: 0o700 })
      try {
        writeFileSync(join(lockPath, LOCK_OWNER_FILENAME), serializeLockOwner(owner), { flag: 'wx', mode: 0o600 })
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true })
        throw error
      }
      return { path: lockPath, owner }
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }

    let observed: LockOwner
    try {
      observed = readLockOwner(lockPath)
    } catch (error) {
      if (!(error instanceof MissingLockOwnerError)) throw error
      const elapsed = now().getTime() - startedAt
      if (elapsed >= timeoutMs) throw new Error(`Workspace lifecycle lock timed out: ${lockPath}`, { cause: error })
      await sleep(Math.min(50, timeoutMs - elapsed))
      continue
    }

    let alive: boolean
    try {
      alive = pidIsAlive(observed.pid)
    } catch {
      alive = true
    }
    if (!alive && reclaimWorkspaceLifecycleLock(lockPath, observed)) continue

    if (!waitNotified) {
      options.onWait?.()
      waitNotified = true
    }

    const elapsed = now().getTime() - startedAt
    if (elapsed >= timeoutMs) throw new Error(`Workspace lifecycle lock timed out: ${lockPath}`)
    await sleep(Math.min(50, timeoutMs - elapsed))
  }
}

function releaseWorkspaceLifecycleLock (token: LockToken): void {
  try {
    if (!sameLockOwner(readLockOwner(token.path), token.owner)) return
    unlinkSync(join(token.path, LOCK_OWNER_FILENAME))
    rmdirSync(token.path)
  } catch {
    // A process may have already reclaimed the lock after an interrupted operation.
  }
}

export async function withWorkspaceLifecycleLock<T> (
  context: WorkspaceContext,
  operation: () => Promise<T>,
  options: WorkspaceLifecycleLockOptions = {}
): Promise<T> {
  const token = await acquireWorkspaceLifecycleLock(context, options)
  try {
    return await operation()
  } finally {
    releaseWorkspaceLifecycleLock(token)
  }
}
