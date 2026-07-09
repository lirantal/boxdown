import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import type { WorkspaceContext } from './paths.ts'
import { runBuffered } from './process.ts'
import { assertProgressCommandSucceeded, type ProgressReporter, runProgressCommand } from './progress.ts'

export interface EnsureHostSshKeyOptions {
  quiet?: boolean
  progress?: ProgressReporter
}

export async function ensureHostSshKey (context: WorkspaceContext, options: boolean | EnsureHostSshKeyOptions = false): Promise<void> {
  const quiet = typeof options === 'boolean' ? options : options.quiet ?? false
  const progress = typeof options === 'boolean' ? undefined : options.progress
  const sshIdentityStepId = progress?.hasStep('ssh-identity') === true ? 'ssh-identity' : undefined

  mkdirSync(context.sshKeyDir, { recursive: true, mode: 0o700 })

  if (!existsSync(context.sshKeyPath)) {
    if (progress !== undefined && sshIdentityStepId === undefined) {
      progress.detail(context.sshKeyPath)
    } else if (!quiet) {
      process.stderr.write(`Generating Boxdown SSH identity: ${context.sshKeyPath}\n`)
    }

    const args = [
      '-t',
      'ed25519',
      '-f',
      context.sshKeyPath,
      '-N',
      '',
      '-C',
      `${context.workspaceBasename}-devcontainer`
    ]
    const result = progress === undefined
      ? await runBuffered('ssh-keygen', args, {
          mirrorStdout: quiet ? false : 'stderr',
          mirrorStderr: 'stderr'
        })
      : await runProgressCommand('ssh-keygen create identity', 'ssh-keygen', args, {
          progress,
          spinnerLabel: 'Generating Boxdown SSH identity',
          stepId: sshIdentityStepId,
          verboseStdout: 'stderr',
          verboseStderr: 'stderr'
        })

    if (progress === undefined && result.code !== 0) {
      throw new Error(`ssh-keygen failed while creating ${context.sshKeyPath}`)
    }

    if (progress !== undefined) {
      assertProgressCommandSucceeded('ssh-keygen create identity', result, `ssh-keygen failed while creating ${context.sshKeyPath}`)
    }
  }

  if (!existsSync(context.sshPublicKeyPath)) {
    if (progress !== undefined && sshIdentityStepId === undefined) {
      progress.detail(context.sshPublicKeyPath)
    }

    const args = ['-y', '-f', context.sshKeyPath]
    const result = progress === undefined
      ? await runBuffered('ssh-keygen', args, {
          mirrorStdout: false,
          mirrorStderr: 'stderr'
        })
      : await runProgressCommand('ssh-keygen derive public key', 'ssh-keygen', args, {
          progress,
          spinnerLabel: 'Writing Boxdown SSH public key',
          stepId: sshIdentityStepId,
          verboseStdout: false,
          verboseStderr: 'stderr'
        })

    if (progress === undefined && result.code !== 0) {
      throw new Error(`ssh-keygen failed while deriving ${context.sshPublicKeyPath}`)
    }

    if (progress !== undefined) {
      assertProgressCommandSucceeded('ssh-keygen derive public key', result, `ssh-keygen failed while deriving ${context.sshPublicKeyPath}`)
    }

    writeFileSync(context.sshPublicKeyPath, result.stdout)
  }

  mkdirSync(context.sshPublicKeyRuntimeDir, { recursive: true, mode: 0o755 })
  writeFileSync(context.sshPublicKeyRuntimePath, readFileSync(context.sshPublicKeyPath, 'utf8'))

  chmodSync(context.sshKeyPath, 0o600)
  chmodSync(context.sshPublicKeyPath, 0o644)
  chmodSync(context.sshPublicKeyRuntimePath, 0o644)
}
