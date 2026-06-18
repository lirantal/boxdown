import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import type { WorkspaceContext } from './paths.ts'
import { runBuffered } from './process.ts'

export async function ensureHostSshKey (context: WorkspaceContext, quiet = false): Promise<void> {
  mkdirSync(context.sshKeyDir, { recursive: true, mode: 0o700 })

  if (!existsSync(context.sshKeyPath)) {
    if (!quiet) {
      process.stderr.write(`Generating Boxdown SSH identity: ${context.sshKeyPath}\n`)
    }

    const result = await runBuffered('ssh-keygen', [
      '-t',
      'ed25519',
      '-f',
      context.sshKeyPath,
      '-N',
      '',
      '-C',
      `${context.workspaceBasename}-devcontainer`
    ], {
      mirrorStdout: quiet ? false : 'stderr',
      mirrorStderr: 'stderr'
    })

    if (result.code !== 0) {
      throw new Error(`ssh-keygen failed while creating ${context.sshKeyPath}`)
    }
  }

  if (!existsSync(context.sshPublicKeyPath)) {
    const result = await runBuffered('ssh-keygen', ['-y', '-f', context.sshKeyPath], {
      mirrorStdout: false,
      mirrorStderr: 'stderr'
    })

    if (result.code !== 0) {
      throw new Error(`ssh-keygen failed while deriving ${context.sshPublicKeyPath}`)
    }

    writeFileSync(context.sshPublicKeyPath, result.stdout)
  }

  mkdirSync(context.sshPublicKeyRuntimeDir, { recursive: true, mode: 0o755 })
  writeFileSync(context.sshPublicKeyRuntimePath, readFileSync(context.sshPublicKeyPath, 'utf8'))

  chmodSync(context.sshKeyPath, 0o600)
  chmodSync(context.sshPublicKeyPath, 0o644)
  chmodSync(context.sshPublicKeyRuntimePath, 0o644)
}
