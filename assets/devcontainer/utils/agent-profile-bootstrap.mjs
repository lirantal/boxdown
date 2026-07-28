import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const sourceRoot = process.env.BOXDOWN_AGENT_PROFILE_SOURCE_DIR ??
  '/opt/boxdown/agent-profile-source'
const destinationHome = process.env.BOXDOWN_AGENT_PROFILE_HOME ?? '/home/node'
const markerPath = process.env.BOXDOWN_AGENT_PROFILE_MARKER_PATH ??
  '/opt/boxdown/state/agent-profile'

function warn(message) {
  console.error(`agent-profile-bootstrap: ${message}`)
}

function selectedProfile() {
  const profile = process.env.BOXDOWN_AGENT_PROFILE === undefined
    ? 'auth'
    : process.env.BOXDOWN_AGENT_PROFILE

  if (!['none', 'auth', 'full'].includes(profile)) {
    throw new Error('invalid agent profile')
  }
  return profile
}

async function entryExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function copyEntry(source, destination, logicalSource, relativePath = '.') {
  const sourceEntry = await lstat(source)

  if (sourceEntry.isSymbolicLink()) {
    await symlink(await readlink(source), destination)
    return true
  }

  if (sourceEntry.isDirectory()) {
    const mode = (sourceEntry.mode & 0o777) | 0o700
    await mkdir(destination, { mode })
    for (const child of await readdir(source)) {
      await copyEntry(
        join(source, child),
        join(destination, child),
        logicalSource,
        relativePath === '.' ? child : join(relativePath, child)
      )
    }
    await chmod(destination, mode)
    return true
  }

  if (sourceEntry.isFile()) {
    await copyFile(source, destination)
    await chmod(destination, (sourceEntry.mode & 0o777) | 0o600)
    return true
  }

  warn(`skipping ${logicalSource} entry ${relativePath}`)
  return false
}

function siblingPath(destination, kind) {
  return join(
    dirname(destination),
    `.${basename(destination)}.boxdown-agent-profile-${kind}-${process.pid}-${randomUUID()}`
  )
}

async function replaceFromSource(source, destination, logicalSource) {
  if (!await entryExists(source)) return false

  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = siblingPath(destination, 'temporary')
  const backup = siblingPath(destination, 'backup')
  let backupActive = false

  try {
    const copied = await copyEntry(source, temporary, logicalSource)
    if (!copied) return false

    if (await entryExists(destination)) {
      await rename(destination, backup)
      backupActive = true
    }

    try {
      await rename(temporary, destination)
    } catch (error) {
      if (backupActive) {
        await rename(backup, destination)
        backupActive = false
      }
      throw error
    }

    if (backupActive) {
      await rm(backup, { recursive: true, force: true })
      backupActive = false
    }
    return true
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function copyRequired(source, destination, logicalSource) {
  try {
    await replaceFromSource(source, destination, logicalSource)
  } catch {
    throw new Error(`failed to copy ${logicalSource}`)
  }
}

async function copyCredential(source, destination, logicalSource) {
  try {
    await replaceFromSource(source, destination, logicalSource)
  } catch {
    warn(`could not copy credential into ${logicalSource}`)
    try {
      await rm(destination, { force: true })
    } catch {
      throw new Error(`failed to clear credential from ${logicalSource}`)
    }
  }
}

async function invalidateMarker() {
  try {
    await rm(markerPath, { force: true })
  } catch {
    throw new Error('failed to invalidate agent profile marker')
  }
}

async function writeMarker(profile) {
  const markerParent = dirname(markerPath)
  const temporary = siblingPath(markerPath, 'temporary')
  await mkdir(markerParent, { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, `${profile}\n`, { mode: 0o600 })
    await rename(temporary, markerPath)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function main() {
  const profile = selectedProfile()
  await invalidateMarker()

  if (profile === 'auth') {
    await copyRequired(
      join(sourceRoot, 'agents'),
      join(destinationHome, '.agents'),
      '~/.agents'
    )
    await copyCredential(
      join(sourceRoot, 'codex-auth.json'),
      join(destinationHome, '.codex', 'auth.json'),
      '$CODEX_HOME'
    )
    await copyCredential(
      join(sourceRoot, 'claude-credentials.json'),
      join(destinationHome, '.claude', '.credentials.json'),
      'CLAUDE_CONFIG_DIR'
    )
  }

  if (profile === 'full') {
    await copyRequired(
      join(sourceRoot, 'agents'),
      join(destinationHome, '.agents'),
      '~/.agents'
    )
    await copyRequired(
      join(sourceRoot, 'codex'),
      join(destinationHome, '.codex'),
      '$CODEX_HOME'
    )
    await copyRequired(
      join(sourceRoot, 'claude'),
      join(destinationHome, '.claude'),
      'CLAUDE_CONFIG_DIR'
    )
    await copyRequired(
      join(sourceRoot, 'claude-config.json'),
      join(destinationHome, '.claude.json'),
      '.claude.json'
    )
  }

  try {
    await writeMarker(profile)
  } catch {
    throw new Error('failed to write agent profile marker')
  }
}

try {
  await main()
} catch (error) {
  warn(error instanceof Error ? error.message : 'profile copy failed')
  process.exitCode = 1
}
