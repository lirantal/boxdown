import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseJsonc, stripJsonComments } from '../jsonc.ts'
import { TOOLCHAIN_DEFAULTS } from './defaults.ts'
import type {
  DetectedToolchain,
  DetectedVersionResolution,
  ToolchainDiagnostic,
  ToolchainEvidence,
  ToolchainId
} from './types.ts'

interface Version {
  parts: [number, number, number]
  length: number
}

interface DetectionBuilder {
  id: ToolchainId
  evidence: ToolchainEvidence[]
  diagnostics: ToolchainDiagnostic[]
  constraints: string[]
  constraintInvalid: boolean
}

interface ParsedConstraint {
  accepts: (version: Version) => boolean
}

interface TomlSection {
  name: string
  arrayTable: boolean
  malformed: boolean
}

function quotedTomlString (value: string): string | undefined {
  const quote = value[0]
  if (quote !== '"' && quote !== "'") return undefined

  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === '\\' && quote === '"') return undefined
    if (value[index] !== quote) continue

    const suffix = value.slice(index + 1).trim()
    return suffix.length === 0 || suffix.startsWith('#') ? value.slice(1, index) : undefined
  }

  return undefined
}

const PACKAGE_RUNTIME_PATHS = ['volta', 'volta.node', 'engines', 'engines.node'] as const

function skipJsonWhitespace (input: string, index: number): number {
  let nextIndex = index

  while (/\s/.test(input[nextIndex] ?? '')) {
    nextIndex += 1
  }

  return nextIndex
}

function readJsonString (input: string, index: number): {value: string, nextIndex: number} | undefined {
  if (input[index] !== '"') {
    return undefined
  }

  const start = index
  let nextIndex = index + 1

  while (nextIndex < input.length) {
    const character = input[nextIndex]

    if (character === '\\') {
      nextIndex += 2
      continue
    }

    if (character === '"') {
      try {
        const value = JSON.parse(input.slice(start, nextIndex + 1)) as unknown

        return typeof value === 'string' ? {value, nextIndex: nextIndex + 1} : undefined
      } catch {
        return undefined
      }
    }

    nextIndex += 1
  }

  return undefined
}

function findDuplicatePackageRuntimePaths (input: string): string[] {
  const content = stripJsonComments(input)
  const counts = new Map<string, number>()
  let index = 0

  function parseValue (path: string | undefined): void {
    index = skipJsonWhitespace(content, index)
    const character = content[index]

    if (character === '{') {
      parseObject(path)
      return
    }

    if (character === '[') {
      index += 1

      while (index < content.length) {
        index = skipJsonWhitespace(content, index)

        if (content[index] === ']') {
          index += 1
          return
        }

        parseValue(undefined)
        index = skipJsonWhitespace(content, index)

        if (content[index] === ']') {
          index += 1
          return
        }

        if (content[index] !== ',') {
          return
        }

        index += 1
      }

      return
    }

    const string = readJsonString(content, index)

    if (string !== undefined) {
      index = string.nextIndex
      return
    }

    while (index < content.length && !/[\s,}\]]/.test(content[index] ?? '')) {
      index += 1
    }
  }

  function parseObject (path: string | undefined): void {
    index += 1

    while (index < content.length) {
      index = skipJsonWhitespace(content, index)

      if (content[index] === '}') {
        index += 1
        return
      }

      const key = readJsonString(content, index)

      if (key === undefined) {
        return
      }

      index = skipJsonWhitespace(content, key.nextIndex)

      if (content[index] !== ':') {
        return
      }

      const propertyPath = path === undefined ? undefined : path.length === 0 ? key.value : `${path}.${key.value}`

      if (propertyPath !== undefined && PACKAGE_RUNTIME_PATHS.includes(propertyPath as typeof PACKAGE_RUNTIME_PATHS[number])) {
        counts.set(propertyPath, (counts.get(propertyPath) ?? 0) + 1)
      }

      index += 1
      parseValue(propertyPath === 'volta' || propertyPath === 'engines' ? propertyPath : undefined)
      index = skipJsonWhitespace(content, index)

      if (content[index] === '}') {
        index += 1
        return
      }

      if (content[index] !== ',') {
        return
      }

      index += 1
    }
  }

  index = skipJsonWhitespace(content, index)

  if (content[index] === '{') {
    parseObject('')
  }

  return PACKAGE_RUNTIME_PATHS.filter(path => (counts.get(path) ?? 0) > 1)
}

function readRootFile (workspaceFolder: string, file: string, detection?: DetectionBuilder): string | undefined {
  const path = join(workspaceFolder, file)

  try {
    lstatSync(path)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }

    if (detection !== undefined) {
      addDiagnostic(detection, file, file, `Unable to read ${file}`)
    }

    return undefined
  }

  try {
    return readFileSync(path, 'utf8')
  } catch {
    if (detection !== undefined) {
      addDiagnostic(detection, file, file, `Unable to read ${file}`)
    }

    return undefined
  }
}

function createDetection (id: ToolchainId): DetectionBuilder {
  return {id, evidence: [], diagnostics: [], constraints: [], constraintInvalid: false}
}

function addDiagnostic (detection: DetectionBuilder, path: string, source: string, message: string): void {
  detection.diagnostics.push({path, source, message})
}

function addEvidence (
  detection: DetectionBuilder,
  path: string,
  source: string,
  value: string,
  exact: boolean
): boolean {
  const normalized = value.trim()

  if (normalized.length === 0) {
    return false
  }

  if (detection.evidence.some(item => (
    item.path === path && item.source === source && item.value === normalized && item.exact === exact
  ))) {
    return false
  }

  detection.evidence.push({path, source, value: normalized, exact})
  return true
}

function finishDetection (detection: DetectionBuilder): DetectedToolchain | undefined {
  if (detection.evidence.length === 0 && detection.diagnostics.length === 0) {
    return undefined
  }

  const exactEvidence = detection.evidence.filter(item => item.exact)
  const firstExact = exactEvidence[0]
  const constraint = detection.constraintInvalid ? undefined : detection.constraints[0]

  if (firstExact !== undefined && constraint !== undefined) {
    const exactVersion = parseVersion(firstExact.value, 2)
    const parsedConstraint = parseConstraint(detection.id, constraint)

    if (exactVersion === undefined || parsedConstraint === undefined || !parsedConstraint.accepts(exactVersion)) {
      addDiagnostic(
        detection,
        firstExact.path,
        firstExact.source,
        `Exact ${detection.id} version is incompatible with the project constraint`
      )
    }
  }

  const unresolved = detection.diagnostics.length > 0

  return {
    id: detection.id,
    ...(unresolved || firstExact === undefined ? {} : {exactVersion: firstExact.value}),
    ...(unresolved || constraint === undefined ? {} : {constraint}),
    evidence: detection.evidence,
    ...(detection.diagnostics.length === 0 ? {} : {diagnostics: detection.diagnostics})
  }
}

function parseVersion (value: string, minimumParts: number, maximumParts = 3): Version | undefined {
  const sourceParts = value.split('.')

  if (
    sourceParts.length < minimumParts ||
    sourceParts.length > maximumParts ||
    sourceParts.some(part => !/^\d+$/.test(part))
  ) {
    return undefined
  }

  const numericParts = sourceParts.map(part => Number(part))
  const [major = 0, minor = 0, patch = 0] = numericParts

  return {parts: [major, minor, patch], length: numericParts.length}
}

function compareVersions (left: Version, right: Version): number {
  for (const index of [0, 1, 2] as const) {
    const difference = left.parts[index] - right.parts[index]

    if (difference !== 0) {
      return Math.sign(difference)
    }
  }

  return 0
}

function versionMatchesExact (candidate: Version, expected: Version): boolean {
  return expected.parts.slice(0, expected.length).every((part, index) => candidate.parts[index] === part)
}

function parseComparatorConstraint (value: string): ParsedConstraint | undefined {
  const operator = ['>=', '<=', '>', '<'].find(candidate => value.startsWith(candidate))
  const target = parseVersion(value.slice(operator?.length ?? 0), 1)

  if (operator === undefined || target === undefined) {
    return undefined
  }

  return {
    accepts: candidate => {
      const comparison = compareVersions(candidate, target)

      return (
        (operator === '>=' && comparison >= 0) ||
        (operator === '>' && comparison > 0) ||
        (operator === '<=' && comparison <= 0) ||
        (operator === '<' && comparison < 0)
      )
    }
  }
}

function parseNodeShorthandConstraint (value: string): ParsedConstraint | undefined {
  const operator = value[0]
  const lower = parseVersion(value.slice(1), 1)

  if (lower === undefined || (operator !== '^' && operator !== '~')) {
    return undefined
  }

  const upper: Version = {parts: [...lower.parts], length: 3}

  if (operator === '~') {
    if (lower.length === 1) {
      upper.parts[0] += 1
      upper.parts[1] = 0
    } else {
      upper.parts[1] += 1
      upper.parts[2] = 0
    }
  } else if (lower.parts[0] > 0) {
    upper.parts[0] += 1
    upper.parts[1] = 0
    upper.parts[2] = 0
  } else if (lower.length === 1) {
    upper.parts[0] += 1
    upper.parts[1] = 0
    upper.parts[2] = 0
  } else if (lower.parts[1] > 0) {
    upper.parts[1] += 1
    upper.parts[2] = 0
  } else if (lower.length === 2) {
    upper.parts[1] += 1
    upper.parts[2] = 0
  } else {
    upper.parts[2] += 1
  }

  return {
    accepts: candidate => compareVersions(candidate, lower) >= 0 && compareVersions(candidate, upper) < 0
  }
}

function parseConstraint (id: ToolchainId, value: string): ParsedConstraint | undefined {
  const normalized = value.trim()

  if (normalized.length === 0 || normalized.includes('||') || /[*xX]/.test(normalized)) {
    return undefined
  }

  if (normalized.includes(',') && normalized.split(',').some(clause => clause.trim().length === 0)) {
    return undefined
  }

  const exact = parseVersion(normalized, 2)

  if (exact !== undefined) {
    return {accepts: candidate => versionMatchesExact(candidate, exact)}
  }

  const clauses = normalized
    .replace(/(>=|>|<=|<)\s+/g, '$1')
    .split(/[\s,]+/)
    .filter(clause => clause.length > 0)

  if (clauses.length === 0) {
    return undefined
  }

  const parsedClauses = clauses.map(clause => {
    if (id === 'node') {
      const shorthand = parseNodeShorthandConstraint(clause)

      if (shorthand !== undefined) {
        return shorthand
      }
    }

    return parseComparatorConstraint(clause)
  })

  if (parsedClauses.some(clause => clause === undefined)) {
    return undefined
  }

  return {accepts: candidate => parsedClauses.every(clause => clause?.accepts(candidate) ?? false)}
}

function isSupportedConstraint (id: ToolchainId, value: string): boolean {
  return parseConstraint(id, value) !== undefined
}

function addExactVersion (
  detection: DetectionBuilder,
  path: string,
  source: string,
  value: string,
  allowNodePrefix = false
): void {
  const normalized = value.trim()
  const version = allowNodePrefix ? normalized.replace(/^v/, '') : normalized

  if (parseVersion(version, 2) === undefined) {
    addEvidence(detection, path, source, normalized, false)
    addDiagnostic(detection, path, source, `Malformed ${detection.id} version declaration`)
    return
  }

  const previousExact = detection.evidence.find(item => item.exact)
  addEvidence(detection, path, source, version, true)

  if (previousExact !== undefined) {
    addDiagnostic(
      detection,
      path,
      source,
      previousExact.value === version
        ? `Repeated exact ${detection.id} declaration`
        : `Conflicting exact ${detection.id} declarations`
    )
  }
}

function addConstraint (
  detection: DetectionBuilder,
  path: string,
  source: string,
  value: string,
  normalizedValue = value
): void {
  addEvidence(detection, path, source, value, false)

  if (!isSupportedConstraint(detection.id, normalizedValue)) {
    addDiagnostic(detection, path, source, `Unsupported ${detection.id} version constraint`)
    detection.constraintInvalid = true
    return
  }

  const previousConstraint = detection.constraints[0]

  if (previousConstraint !== undefined) {
    detection.constraintInvalid = true
    addDiagnostic(
      detection,
      path,
      source,
      previousConstraint === normalizedValue
        ? `Repeated ${detection.id} version constraint`
        : `Conflicting ${detection.id} version constraints`
    )
    return
  }

  if (!detection.constraintInvalid) {
    detection.constraints.push(normalizedValue)
  }
}

function readVersionFile (
  workspaceFolder: string,
  file: string,
  detection: DetectionBuilder,
  allowNodePrefix = false
): void {
  const content = readRootFile(workspaceFolder, file, detection)

  if (content === undefined) {
    return
  }

  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)

  if (lines.length === 0) {
    addDiagnostic(detection, file, file, `${file} must contain a non-empty version declaration`)
    return
  }

  if (lines.length !== 1) {
    addDiagnostic(detection, file, file, `${file} must contain a single non-empty line`)
    return
  }

  addExactVersion(detection, file, file, lines[0] ?? '', allowNodePrefix)
}

function readToolVersions (workspaceFolder: string, id: ToolchainId, detection: DetectionBuilder): void {
  const content = readRootFile(workspaceFolder, '.tool-versions', detection)

  if (content === undefined) {
    return
  }

  const names: Record<ToolchainId, readonly string[]> = {
    node: ['node', 'nodejs'],
    python: ['python'],
    go: ['go', 'golang'],
    rust: ['rust']
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue
    }

    const fields = trimmed.split(/\s+/)
    const name = fields[0]
    if (name === undefined || !names[id].includes(name)) {
      continue
    }

    const version = fields[1]

    if (version === undefined) {
      addDiagnostic(detection, '.tool-versions', `.tool-versions.${name}`, 'Malformed .tool-versions declaration')
      continue
    }

    if (fields.length > 2 && !fields[2]?.startsWith('#')) {
      addEvidence(detection, '.tool-versions', `.tool-versions.${name}`, fields.slice(1).join(' '), false)
      addDiagnostic(detection, '.tool-versions', `.tool-versions.${name}`, 'Malformed .tool-versions declaration')
      continue
    }

    addExactVersion(detection, '.tool-versions', `.tool-versions.${name}`, version)
  }
}

function tomlSection (line: string): TomlSection | undefined {
  if (!line.startsWith('[')) {
    return undefined
  }

  const arrayTable = line.startsWith('[[')
  const closingDelimiter = arrayTable ? ']]' : ']'
  const openingLength = arrayTable ? 2 : 1
  let closingIndex = -1
  let quote: '"' | "'" | undefined
  let escaped = false

  for (let index = openingLength; index < line.length; index += 1) {
    const character = line[index]

    if (quote !== undefined) {
      if (quote === '"' && escaped) {
        escaped = false
      } else if (quote === '"' && character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = undefined
      }

      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      continue
    }

    if (line.startsWith(closingDelimiter, index)) {
      closingIndex = index
      break
    }
  }

  if (closingIndex < openingLength) {
    const rawName = line.slice(openingLength).trim()
    const unterminatedNameEnd = arrayTable ? rawName.indexOf(']') : -1
    const name = (unterminatedNameEnd >= 0 ? rawName.slice(0, unterminatedNameEnd) : rawName).trim()

    return {name, arrayTable, malformed: true}
  }

  const name = line.slice(openingLength, closingIndex).trim()
  const suffix = line.slice(closingIndex + closingDelimiter.length).trim()

  return {
    name,
    arrayTable,
    malformed: name.length === 0 || name.includes('[') || (suffix.length > 0 && !suffix.startsWith('#'))
  }
}

function detectNode (workspaceFolder: string): DetectedToolchain | undefined {
  const detection = createDetection('node')
  const packageJson = readRootFile(workspaceFolder, 'package.json', detection)
  let engineConstraint: string | undefined

  if (packageJson !== undefined) {
    for (const path of findDuplicatePackageRuntimePaths(packageJson)) {
      addDiagnostic(detection, 'package.json', path, `Repeated package.json declaration for ${path}`)
    }

    try {
      const parsed = parseJsonc<unknown>(packageJson)

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        addDiagnostic(detection, 'package.json', 'package.json', 'package.json root must be an object')
      } else {
        const manifest = parsed as {volta?: unknown, engines?: unknown}

        if (manifest.volta !== undefined) {
          if (typeof manifest.volta !== 'object' || manifest.volta === null || Array.isArray(manifest.volta)) {
            addDiagnostic(detection, 'package.json', 'volta', 'volta must be an object')
          } else {
            const voltaNode = (manifest.volta as {node?: unknown}).node

            if (typeof voltaNode === 'string') {
              addExactVersion(detection, 'package.json', 'volta.node', voltaNode, true)
            } else if (voltaNode !== undefined) {
              addDiagnostic(detection, 'package.json', 'volta.node', 'volta.node must be a string')
            }
          }
        }

        if (manifest.engines !== undefined) {
          if (typeof manifest.engines !== 'object' || manifest.engines === null || Array.isArray(manifest.engines)) {
            addDiagnostic(detection, 'package.json', 'engines', 'engines must be an object')
          } else {
            const enginesNode = (manifest.engines as {node?: unknown}).node

            if (typeof enginesNode === 'string') {
              engineConstraint = enginesNode
            } else if (enginesNode !== undefined) {
              addDiagnostic(detection, 'package.json', 'engines.node', 'engines.node must be a string')
            }
          }
        }
      }
    } catch {
      addDiagnostic(detection, 'package.json', 'package.json', 'Malformed package.json')
    }
  }

  readVersionFile(workspaceFolder, '.nvmrc', detection, true)
  readVersionFile(workspaceFolder, '.node-version', detection, true)
  readToolVersions(workspaceFolder, 'node', detection)

  if (engineConstraint !== undefined) {
    addConstraint(detection, 'package.json', 'engines.node', engineConstraint)
  }

  const lockfiles: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun']
  ]

  for (const [file, manager] of lockfiles) {
    if (readRootFile(workspaceFolder, file, detection) !== undefined) {
      addEvidence(detection, file, 'lockfile', manager, false)
    }
  }

  return finishDetection(detection)
}

function detectPython (workspaceFolder: string): DetectedToolchain | undefined {
  const detection = createDetection('python')
  readVersionFile(workspaceFolder, '.python-version', detection)
  readToolVersions(workspaceFolder, 'python', detection)

  const pyproject = readRootFile(workspaceFolder, 'pyproject.toml', detection)

  if (pyproject !== undefined) {
    let inProject = false
    let foundProject = false

    for (const line of pyproject.split(/\r?\n/)) {
      const trimmed = line.trim()
      const section = tomlSection(trimmed)

      if (section !== undefined) {
        inProject = !section.arrayTable && !section.malformed && section.name === 'project'

        if (section.name === 'project') {
          if (section.malformed) {
            addDiagnostic(detection, 'pyproject.toml', 'project', 'Malformed [project] section')
          } else if (section.arrayTable) {
            addDiagnostic(detection, 'pyproject.toml', 'project', 'Unsupported array [project] section')
          } else {
            if (foundProject) {
              addDiagnostic(detection, 'pyproject.toml', 'project', 'Repeated [project] section')
            }

            foundProject = true
          }
        }

        continue
      }

      if (!inProject) {
        continue
      }

      const match = /^requires-python\s*=\s*(.*)$/.exec(trimmed)

      if (match === null) {
        continue
      }

      const rawValue = match[1] ?? ''
      const quoted = quotedTomlString(rawValue)

      if (quoted === undefined) {
        addEvidence(detection, 'pyproject.toml', 'requires-python', rawValue, false)
        addDiagnostic(detection, 'pyproject.toml', 'requires-python', 'Malformed requires-python value')
      } else {
        addConstraint(detection, 'pyproject.toml', 'requires-python', quoted)
      }
    }
  }

  return finishDetection(detection)
}

function detectGo (workspaceFolder: string): DetectedToolchain | undefined {
  const detection = createDetection('go')
  const goMod = readRootFile(workspaceFolder, 'go.mod', detection)

  if (goMod !== undefined) {
    for (const line of goMod.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/)

      if (fields[0] === 'toolchain') {
        const value = fields[1] ?? ''
        const version = value.startsWith('go') ? value.slice(2) : undefined

        if (fields.length !== 2 || version === undefined || parseVersion(version, 2) === undefined) {
          addEvidence(detection, 'go.mod', 'toolchain', value, false)
          addDiagnostic(detection, 'go.mod', 'toolchain', 'Malformed Go toolchain declaration')
        } else {
          addExactVersion(detection, 'go.mod', 'toolchain', version)
        }

        continue
      }
    }
  }

  readVersionFile(workspaceFolder, '.go-version', detection)
  readToolVersions(workspaceFolder, 'go', detection)

  if (goMod !== undefined) {
    for (const line of goMod.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/)

      if (fields[0] === 'go') {
        const version = fields[1] ?? ''

        if (fields.length !== 2 || parseVersion(version, 2) === undefined) {
          addEvidence(detection, 'go.mod', 'go', fields.slice(1).join(' '), false)
          addDiagnostic(detection, 'go.mod', 'go', 'Malformed Go version directive')
        } else {
          addConstraint(detection, 'go.mod', 'go', version, `>=${version}`)
        }
      }
    }
  }

  return finishDetection(detection)
}

function detectRust (workspaceFolder: string): DetectedToolchain | undefined {
  const detection = createDetection('rust')
  const rustToolchain = readRootFile(workspaceFolder, 'rust-toolchain.toml', detection)

  if (rustToolchain !== undefined) {
    if (rustToolchain.trim().length === 0) {
      addDiagnostic(detection, 'rust-toolchain.toml', 'rust-toolchain.toml', 'rust-toolchain.toml must not be empty')
    } else {
      let inToolchain = false
      let foundToolchain = false

      for (const line of rustToolchain.split(/\r?\n/)) {
        const trimmed = line.trim()
        const section = tomlSection(trimmed)

        if (section !== undefined) {
          inToolchain = !section.arrayTable && !section.malformed && section.name === 'toolchain'

          if (section.name === 'toolchain') {
            if (section.malformed) {
              addDiagnostic(detection, 'rust-toolchain.toml', 'toolchain', 'Malformed [toolchain] section')
            } else if (section.arrayTable) {
              addDiagnostic(detection, 'rust-toolchain.toml', 'toolchain', 'Unsupported array [toolchain] section')
            } else {
              if (foundToolchain) {
                addDiagnostic(detection, 'rust-toolchain.toml', 'toolchain', 'Repeated [toolchain] section')
              }

              foundToolchain = true
            }
          }

          continue
        }

        if (!inToolchain) {
          continue
        }

        const match = /^channel\s*=\s*(.*)$/.exec(trimmed)

        if (match === null) {
          continue
        }

        const rawValue = match[1] ?? ''
        const quoted = quotedTomlString(rawValue)

        if (quoted === undefined) {
          addEvidence(detection, 'rust-toolchain.toml', 'toolchain.channel', rawValue, false)
          addDiagnostic(detection, 'rust-toolchain.toml', 'toolchain.channel', 'Malformed toolchain channel value')
        } else {
          addExactVersion(detection, 'rust-toolchain.toml', 'toolchain.channel', quoted)
        }
      }
    }
  }

  readVersionFile(workspaceFolder, 'rust-toolchain', detection)
  readToolVersions(workspaceFolder, 'rust', detection)

  const cargo = readRootFile(workspaceFolder, 'Cargo.toml', detection)

  if (cargo !== undefined) {
    let inPackage = false
    let foundPackage = false

    for (const line of cargo.split(/\r?\n/)) {
      const trimmed = line.trim()
      const section = tomlSection(trimmed)

      if (section !== undefined) {
        inPackage = !section.arrayTable && !section.malformed && section.name === 'package'

        if (section.name === 'package') {
          if (section.malformed) {
            addDiagnostic(detection, 'Cargo.toml', 'package', 'Malformed [package] section')
          } else if (section.arrayTable) {
            addDiagnostic(detection, 'Cargo.toml', 'package', 'Unsupported array [package] section')
          } else {
            if (foundPackage) {
              addDiagnostic(detection, 'Cargo.toml', 'package', 'Repeated [package] section')
            }

            foundPackage = true
          }
        }

        continue
      }

      if (!inPackage) {
        continue
      }

      const match = /^rust-version\s*=\s*(.*)$/.exec(trimmed)

      if (match === null) {
        continue
      }

      const rawValue = match[1] ?? ''
      const quoted = quotedTomlString(rawValue)

      if (quoted === undefined) {
        addEvidence(detection, 'Cargo.toml', 'package.rust-version', rawValue, false)
        addDiagnostic(detection, 'Cargo.toml', 'package.rust-version', 'Malformed package.rust-version value')
      } else {
        addConstraint(detection, 'Cargo.toml', 'package.rust-version', quoted, `>=${quoted}`)
      }
    }
  }

  return finishDetection(detection)
}

export function detectToolchains (workspaceFolder: string): DetectedToolchain[] {
  return [
    detectNode(workspaceFolder),
    detectPython(workspaceFolder),
    detectGo(workspaceFolder),
    detectRust(workspaceFolder)
  ].filter((detection): detection is DetectedToolchain => detection !== undefined)
}

export function resolveDetectedVersion (detection: DetectedToolchain): DetectedVersionResolution {
  const defaultVersion = TOOLCHAIN_DEFAULTS[detection.id].version

  if (detection.diagnostics?.length !== undefined && detection.diagnostics.length > 0) {
    return {kind: 'unchecked', defaultVersion}
  }

  if (detection.exactVersion !== undefined) {
    const exactVersion = parseVersion(detection.exactVersion, 2)

    if (exactVersion === undefined) {
      return {kind: 'unchecked', defaultVersion}
    }

    if (detection.constraint !== undefined) {
      const constraint = parseConstraint(detection.id, detection.constraint)

      if (constraint === undefined || !constraint.accepts(exactVersion)) {
        return {kind: 'unchecked', defaultVersion}
      }
    }

    return {kind: 'resolved', version: detection.exactVersion, source: 'project'}
  }

  if (detection.constraint !== undefined) {
    const constraint = parseConstraint(detection.id, detection.constraint)

    if (constraint === undefined) {
      return {kind: 'unchecked', defaultVersion}
    }

    const defaultAsVersion = parseVersion(defaultVersion, 3)

    if (defaultAsVersion !== undefined && constraint.accepts(defaultAsVersion)) {
      return {kind: 'resolved', version: defaultVersion, source: 'boxdown-default'}
    }

    return {kind: 'incompatible-default', defaultVersion, constraint: detection.constraint}
  }

  return {kind: 'resolved', version: defaultVersion, source: 'boxdown-default'}
}

export function detectedConstraintAcceptsVersion (
  detection: DetectedToolchain,
  version: string
): boolean | undefined {
  if (detection.constraint === undefined) return undefined

  const constraint = parseConstraint(detection.id, detection.constraint)
  const candidate = parseVersion(version, 2)
  if (constraint === undefined || candidate === undefined) return undefined

  return constraint.accepts(candidate)
}
