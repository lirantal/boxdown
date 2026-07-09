import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { packageRootFromImportMeta } from './paths.ts'

interface PackageJson {
  version?: unknown
}

export function readPackageVersion (packageRoot = packageRootFromImportMeta(import.meta.url)): string {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as PackageJson

  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Boxdown package.json is missing a valid version.')
  }

  return packageJson.version
}
