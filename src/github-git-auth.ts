import { runBuffered } from './process.ts'

export function canonicalGithubRemoteUrl (remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim()
  const scpLike = /^git@github\.com:([^/]+)\/(.+)$/i.exec(trimmed)

  if (scpLike !== null) {
    return canonicalGithubUrlFromParts(scpLike[1], scpLike[2])
  }

  try {
    const parsed = new URL(trimmed)
    const protocol = parsed.protocol.toLowerCase()
    const host = parsed.hostname.toLowerCase()

    if (host !== 'github.com') {
      return undefined
    }

    if (protocol === 'ssh:' && parsed.username !== 'git') {
      return undefined
    }

    if (protocol !== 'https:' && protocol !== 'ssh:') {
      return undefined
    }

    const parts = parsed.pathname.split('/').filter((part) => part.length > 0)
    if (parts.length !== 2) {
      return undefined
    }

    const [owner, repo] = parts
    return canonicalGithubUrlFromParts(owner, repo)
  } catch {
    return undefined
  }
}

function canonicalGithubUrlFromParts (owner: string | undefined, repo: string | undefined): string | undefined {
  if (owner === undefined || repo === undefined) {
    return undefined
  }

  const normalizedOwner = owner.trim()
  const normalizedRepo = repo.trim().replace(/\/+$/, '').replace(/\.git$/i, '')

  if (
    normalizedOwner.length === 0 ||
    normalizedRepo.length === 0 ||
    normalizedOwner.includes('/') ||
    normalizedRepo.includes('/')
  ) {
    return undefined
  }

  return `https://github.com/${normalizedOwner}/${normalizedRepo}.git`
}

export async function configureWorkspaceGithubGitAuth (workspaceFolder: string): Promise<boolean> {
  const insideWorkTree = await runWorkspaceGit(workspaceFolder, ['rev-parse', '--is-inside-work-tree'])

  if (insideWorkTree.code !== 0 || insideWorkTree.stdout.trim() !== 'true') {
    return false
  }

  const remoteConfig = await runWorkspaceGit(workspaceFolder, ['config', '--local', '--get-regexp', '^remote\\..*\\.url$'])

  if (remoteConfig.code !== 0) {
    return false
  }

  const githubRemotes = parseGithubRemoteConfig(remoteConfig.stdout)

  if (githubRemotes.length === 0) {
    return false
  }

  for (const remote of githubRemotes) {
    const fetchUrl = await runWorkspaceGit(workspaceFolder, ['remote', 'set-url', remote.name, remote.url])
    if (fetchUrl.code !== 0) {
      return false
    }

    const pushUrl = await runWorkspaceGit(workspaceFolder, ['remote', 'set-url', '--push', remote.name, remote.url])
    if (pushUrl.code !== 0) {
      return false
    }
  }

  await runWorkspaceGit(workspaceFolder, ['config', '--local', '--unset-all', 'credential.https://github.com.helper'])

  const resetHelper = await runWorkspaceGit(workspaceFolder, ['config', '--local', '--add', 'credential.https://github.com.helper', ''])
  if (resetHelper.code !== 0) {
    return false
  }

  const ghHelper = await runWorkspaceGit(workspaceFolder, ['config', '--local', '--add', 'credential.https://github.com.helper', '!gh auth git-credential'])
  if (ghHelper.code !== 0) {
    return false
  }

  for (const remoteUrl of new Set(githubRemotes.map((remote) => remote.url))) {
    const rewrite = await runWorkspaceGit(workspaceFolder, ['config', '--local', '--replace-all', `url.${remoteUrl}.insteadOf`, remoteUrl])
    if (rewrite.code !== 0) {
      return false
    }
  }

  return true
}

function parseGithubRemoteConfig (configOutput: string): Array<{ name: string, url: string }> {
  const remotes: Array<{ name: string, url: string }> = []

  for (const line of configOutput.split(/\r?\n/)) {
    const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line)
    if (match === null) {
      continue
    }

    const name = match[1]
    const rawUrl = match[2]
    if (name === undefined || rawUrl === undefined) {
      continue
    }

    const url = canonicalGithubRemoteUrl(rawUrl)
    if (url !== undefined) {
      remotes.push({ name, url })
    }
  }

  return remotes
}

async function runWorkspaceGit (workspaceFolder: string, args: string[]) {
  return runBuffered('git', args, {
    cwd: workspaceFolder,
    mirrorStdout: false,
    mirrorStderr: false
  })
}
