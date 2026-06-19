import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import { DEVCONTAINER_CLI_VERSION } from './constants.ts'
import type { WorkspaceContext } from './paths.ts'

export interface DevcontainerCliCommand {
  command: string
  argsPrefix: string[]
  path: string
  version: string
}

interface PackageJson {
  bin?: string | Record<string, string>
  version?: string
}

function devcontainerBinFromPackageJson (packageJson: PackageJson): string | undefined {
  return typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.devcontainer
}

export function resolveDevcontainerCli (context: WorkspaceContext): DevcontainerCliCommand {
  const requireFromBoxdown = createRequire(join(context.packageRoot, 'package.json'))
  let packageJsonPath: string

  try {
    packageJsonPath = requireFromBoxdown.resolve('@devcontainers/cli/package.json')
  } catch (error) {
    throw new Error(`Boxdown's packaged @devcontainers/cli dependency is missing. Reinstall boxdown so @devcontainers/cli@${DEVCONTAINER_CLI_VERSION} is available.`, { cause: error })
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson
  const bin = devcontainerBinFromPackageJson(packageJson)

  if (packageJson.version !== DEVCONTAINER_CLI_VERSION) {
    throw new Error(`Boxdown expected @devcontainers/cli@${DEVCONTAINER_CLI_VERSION} but resolved ${packageJson.version ?? 'an unknown version'}.`)
  }

  if (bin === undefined) {
    throw new Error('Boxdown resolved @devcontainers/cli, but the package does not expose a devcontainer binary.')
  }

  const cliPath = resolve(dirname(packageJsonPath), bin)

  if (!existsSync(cliPath)) {
    throw new Error(`Boxdown resolved @devcontainers/cli, but its devcontainer binary is missing: ${cliPath}`)
  }

  return {
    command: process.execPath,
    argsPrefix: [cliPath],
    path: cliPath,
    version: packageJson.version
  }
}
