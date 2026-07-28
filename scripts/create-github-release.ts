import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

import {validateReleaseIdentity} from './check-image-release.ts'

export interface CommandResult {
  stdout: string
  stderr: string
  status: number
}

export type Command = (program: string, arguments_: string[], input?: string) => CommandResult

export interface ReleaseOptions {
  packageName: string
  version: string
  revision: string
  repository: string
}

export function releaseAction(npmPublished: boolean, githubReleaseExists: boolean): 'create' | 'skip' {
  return npmPublished || !githubReleaseExists ? 'create' : 'skip'
}

export function releaseNotesForVersion(changelog: string, version: string): string {
  const heading = `## ${version}`
  const start = changelog.indexOf(`${heading}\n`)
  if (start === -1) throw new Error(`could not find changelog entry for ${version}`)

  const contentStart = start + heading.length
  const nextHeading = changelog.indexOf('\n## ', contentStart)
  return changelog.slice(contentStart, nextHeading === -1 ? undefined : nextHeading).trim()
}

export function remoteAnnotatedTagTarget(lsRemoteOutput: string, tag: string): string | undefined {
  if (lsRemoteOutput.trim() === '') return undefined

  const peeledReference = `refs/tags/${tag}^{}`
  const peeledLine = lsRemoteOutput
    .split('\n')
    .find(line => line.endsWith(`\t${peeledReference}`))
  if (peeledLine === undefined) throw new Error(`existing ${tag} must be an annotated tag`)

  return peeledLine.split('\t')[0]
}

function commandResult(program: string, arguments_: string[], input?: string): CommandResult {
  const result = spawnSync(program, arguments_, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  if (result.error !== undefined) throw result.error

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1
  }
}

function run(command: Command, program: string, arguments_: string[], input?: string): string {
  const result = command(program, arguments_, input)
  if (result.status !== 0) {
    throw new Error(`${program} ${arguments_.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function githubReleaseExists(command: Command, tag: string, repository: string): boolean {
  const result = command('gh', ['api', '--silent', `repos/${repository}/releases/tags/${tag}`])
  if (result.status === 0) return true
  if (result.status === 1 && result.stderr.includes('HTTP 404')) return false

  throw new Error(`could not inspect GitHub Release ${tag}: ${result.stderr.trim()}`)
}

function assertRevision(revision: string): void {
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error('release revision must be a full Git commit SHA')
  }
}

export function ensureGitHubRelease(options: ReleaseOptions, command: Command = commandResult): void {
  validateReleaseIdentity(options.packageName, options.version)
  assertRevision(options.revision)

  const tag = `v${options.version}`
  const remoteTagTarget = remoteAnnotatedTagTarget(
    run(command, 'git', [
      'ls-remote',
      '--tags',
      'origin',
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`
    ]),
    tag
  )

  if (remoteTagTarget === undefined) {
    run(command, 'git', ['tag', '--annotate', tag, options.revision, '--message', tag])
    run(command, 'git', ['push', 'origin', `refs/tags/${tag}`])
  } else if (remoteTagTarget !== options.revision) {
    throw new Error(`existing ${tag} points to ${remoteTagTarget}, expected ${options.revision}`)
  }

  if (githubReleaseExists(command, tag, options.repository)) return

  const releaseNotes = releaseNotesForVersion(readFileSync('CHANGELOG.md', 'utf8'), options.version)
  run(
    command,
    'gh',
    [
      'release',
      'create',
      tag,
      '--repo',
      options.repository,
      '--verify-tag',
      '--title',
      tag,
      '--notes-file',
      '-'
    ],
    releaseNotes
  )
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`)
  return value
}

function main(): void {
  requiredEnvironment('GH_TOKEN')
  ensureGitHubRelease({
    packageName: requiredEnvironment('RELEASE_PACKAGE_NAME'),
    version: requiredEnvironment('RELEASE_VERSION'),
    revision: requiredEnvironment('RELEASE_REVISION'),
    repository: requiredEnvironment('RELEASE_REPOSITORY')
  })
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main()
