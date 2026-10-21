#!/usr/bin/env node
// Expose image tools as replaceable global packages. Their bin paths then stay
// stable even in shells that cached a command before its first npm -g upgrade.
import { lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function exists(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function directory(path) {
  const parent = dirname(path)
  if (parent !== path) directory(parent)
  const stat = exists(path)
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe npm global directory: ${path}`)
  } else {
    mkdirSync(path, {mode: 0o700})
  }
}

function linkIfMissing(target, path) {
  if (exists(path)) return
  try {
    symlinkSync(target, path)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}

function initialize() {
  const home = process.env.HOME
  if (!home || !isAbsolute(home)) throw new Error('An absolute HOME is required')
  const prefix = join(home, '.local/share/boxdown/npm-global')
  const imageRoot = join(home, '.local')
  const manifestPath = join(imageRoot, 'package.json')
  const manifestStat = exists(manifestPath)
  if (!manifestStat) return // Native/legacy images need only the PATH setup.
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('Unsafe image npm manifest')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const modules = join(prefix, 'lib/node_modules')
  const bin = join(prefix, 'bin')
  directory(modules)
  directory(bin)
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const parts = name.split('/')
    const validName = parts.length === 1
      ? /^[a-z0-9._-]+$/u.test(parts[0])
      : parts.length === 2 && /^@[a-z0-9._-]+$/u.test(parts[0]) && /^[a-z0-9._-]+$/u.test(parts[1])
    if (!validName || parts.some(part => part === '.' || part === '..')) {
      throw new Error('Invalid image package name')
    }
    const imagePackage = join(imageRoot, 'node_modules', name)
    const packageManifest = JSON.parse(readFileSync(join(imagePackage, 'package.json'), 'utf8'))
    const bins = typeof packageManifest.bin === 'string'
      ? { [name.split('/').at(-1)]: packageManifest.bin }
      : packageManifest.bin ?? {}
    const globalPackage = join(modules, name)
    directory(dirname(globalPackage))
    linkIfMissing(imagePackage, globalPackage)
    for (const [command, target] of Object.entries(bins)) {
      if (!/^[a-zA-Z0-9._-]+$/u.test(command) || command === '.' || command === '..' || typeof target !== 'string') {
        throw new Error('Invalid image executable')
      }
      const executable = resolve(globalPackage, target)
      if (!executable.startsWith(`${globalPackage}${sep}`)) throw new Error('Image executable escapes its package')
      linkIfMissing(relative(bin, executable), join(bin, command))
    }
  }
}

try {
  initialize()
} catch (error) {
  console.error(`npm-global-bootstrap: ${error.message}`)
  process.exitCode = 1
}
