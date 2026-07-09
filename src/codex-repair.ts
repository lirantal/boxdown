import { existsSync, readFileSync } from 'node:fs'

import { codexDiscoveredRemoteHostId, codexProjectEntryForWorkspace, codexRemotePathForWorkspace, defaultCodexAppConfigPath, defaultCodexGlobalStatePath, installCodexAppConfigProject, installCodexGlobalStateProject, legacyCodexRemotePathForWorkspace, normalizeRemotePath, parseCodexAppConfig } from './codex-app-config.ts'
import type { WorkspaceContext } from './paths.ts'
import { runBuffered } from './process.ts'

export interface CodexRepairOptions {
  apply?: boolean
  now?: Date
  legacyPath?: string
  canonicalPath?: string
  codexHome?: string
  env?: NodeJS.ProcessEnv
}

interface CodexRepairPathCounts {
  path: string
  exists: boolean
  legacy: number
  canonical: number
  changed: boolean
  backupPath?: string
}

interface CodexRepairHostSummary {
  appConfig: CodexRepairPathCounts
  globalState: CodexRepairPathCounts
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function timestampFor (now: Date): string {
  return now.toISOString().replace(/[-:.]/gu, '').replace(/000Z$/u, 'Z')
}

function countCodexAppConfigPaths (
  configPath: string,
  sshAlias: string,
  legacyPath: string,
  canonicalPath: string
): CodexRepairPathCounts {
  if (!existsSync(configPath)) {
    return {
      path: configPath,
      exists: false,
      legacy: 0,
      canonical: 0,
      changed: false
    }
  }

  const config = parseCodexAppConfig(JSON.parse(readFileSync(configPath, 'utf8')) as unknown)
  let legacy = 0
  let canonical = 0

  for (const connection of config.remoteConnections) {
    if (connection.sshAlias !== sshAlias) {
      continue
    }

    for (const project of connection.projects) {
      const remotePath = normalizeRemotePath(project.remotePath)
      if (remotePath === legacyPath) {
        legacy += 1
      } else if (remotePath === canonicalPath) {
        canonical += 1
      }
    }
  }

  return {
    path: configPath,
    exists: true,
    legacy,
    canonical,
    changed: false
  }
}

function addCodexGlobalStateContainerCounts (
  container: unknown,
  hostId: string,
  legacyPath: string,
  canonicalPath: string,
  counts: { legacy: number, canonical: number }
): void {
  if (!isRecord(container) || !Array.isArray(container['remote-projects'])) {
    return
  }

  for (const project of container['remote-projects']) {
    if (!isRecord(project) || project.hostId !== hostId || typeof project.remotePath !== 'string') {
      continue
    }

    const remotePath = normalizeRemotePath(project.remotePath)
    if (remotePath === legacyPath) {
      counts.legacy += 1
    } else if (remotePath === canonicalPath) {
      counts.canonical += 1
    }
  }
}

function countCodexGlobalStatePaths (
  statePath: string,
  sshAlias: string,
  legacyPath: string,
  canonicalPath: string
): CodexRepairPathCounts {
  if (!existsSync(statePath)) {
    return {
      path: statePath,
      exists: false,
      legacy: 0,
      canonical: 0,
      changed: false
    }
  }

  const state = JSON.parse(readFileSync(statePath, 'utf8')) as unknown
  const hostId = codexDiscoveredRemoteHostId(sshAlias)
  const counts = {
    legacy: 0,
    canonical: 0
  }

  addCodexGlobalStateContainerCounts(state, hostId, legacyPath, canonicalPath, counts)

  if (isRecord(state)) {
    addCodexGlobalStateContainerCounts(state['electron-persisted-atom-state'], hostId, legacyPath, canonicalPath, counts)
  }

  return {
    path: statePath,
    exists: true,
    legacy: counts.legacy,
    canonical: counts.canonical,
    changed: false
  }
}

export function repairHostCodexPathIdentity (
  context: WorkspaceContext,
  alias: string,
  options: CodexRepairOptions = {}
): CodexRepairHostSummary {
  const env = options.env ?? process.env
  const legacyPath = normalizeRemotePath(options.legacyPath ?? legacyCodexRemotePathForWorkspace(context))
  const canonicalPath = normalizeRemotePath(options.canonicalPath ?? codexRemotePathForWorkspace(context))
  const appConfigPath = defaultCodexAppConfigPath(env)
  const globalStatePath = defaultCodexGlobalStatePath(env)
  const appConfig = countCodexAppConfigPaths(appConfigPath, alias, legacyPath, canonicalPath)
  const globalState = countCodexGlobalStatePaths(globalStatePath, alias, legacyPath, canonicalPath)

  if (options.apply !== true) {
    return {
      appConfig,
      globalState
    }
  }

  const entry = {
    ...codexProjectEntryForWorkspace(context, alias),
    remotePath: canonicalPath
  }
  const now = options.now ?? new Date()
  const appResult = installCodexAppConfigProject(entry, {
    configPath: appConfigPath,
    legacyRemotePaths: [legacyPath],
    now
  })
  const stateResult = installCodexGlobalStateProject(entry, {
    statePath: globalStatePath,
    legacyRemotePaths: [legacyPath],
    now
  })

  return {
    appConfig: {
      ...appConfig,
      changed: appResult.changed,
      ...(appResult.backupPath === undefined ? {} : { backupPath: appResult.backupPath })
    },
    globalState: {
      ...globalState,
      changed: stateResult.changed,
      ...(stateResult.backupPath === undefined ? {} : { backupPath: stateResult.backupPath })
    }
  }
}

export function buildCodexRepairScript (
  context: WorkspaceContext,
  options: CodexRepairOptions = {}
): string {
  const legacyPath = options.legacyPath ?? legacyCodexRemotePathForWorkspace(context)
  const canonicalPath = options.canonicalPath ?? codexRemotePathForWorkspace(context)
  const apply = options.apply === true
  const timestamp = timestampFor(options.now ?? new Date())
  const codexHome = options.codexHome

  return `import glob
import json
import os
import shutil
import sqlite3
import sys

legacy_path = ${JSON.stringify(legacyPath)}
canonical_path = ${JSON.stringify(canonicalPath)}
apply_changes = ${apply ? 'True' : 'False'}
timestamp = ${JSON.stringify(timestamp)}
home = os.path.expanduser("~")
codex_home = ${codexHome === undefined ? 'os.path.join(home, ".codex")' : JSON.stringify(codexHome)}
backup_dir = os.path.join(codex_home, "backups", "boxdown-codex-path-repair", timestamp)

summary = {
    "ok": True,
    "mode": "apply" if apply_changes else "dry-run",
    "legacyPath": legacy_path,
    "canonicalPath": canonical_path,
    "legacyRealpath": None,
    "backupDir": backup_dir if apply_changes else None,
    "sqlite": [],
    "files": [],
    "backups": []
}

def fail(message):
    summary["ok"] = False
    summary["error"] = message
    print(json.dumps(summary, indent=2, sort_keys=True))
    sys.exit(1)

if not os.path.islink(legacy_path):
    fail(f"{legacy_path} is not a symlink")

legacy_realpath = os.path.realpath(legacy_path)
summary["legacyRealpath"] = legacy_realpath

if legacy_realpath != canonical_path:
    fail(f"{legacy_path} resolves to {legacy_realpath}, not {canonical_path}")

if not os.path.isdir(canonical_path):
    fail(f"{canonical_path} is not a directory")

def unique(paths):
    seen = set()
    result = []
    for path in paths:
        if path in seen:
            continue
        seen.add(path)
        result.append(path)
    return result

sqlite_paths = unique(sorted(glob.glob(os.path.join(codex_home, "state_*.sqlite"))) + sorted(glob.glob(os.path.join(codex_home, "sqlite", "state_*.sqlite"))))
text_paths = [
    os.path.join(codex_home, "session_index.jsonl"),
    os.path.join(codex_home, "config.toml"),
]

def sqlite_counts(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = dict(con.execute(
            "select cwd, count(*) from threads where cwd in (?, ?) group by cwd",
            (legacy_path, canonical_path)
        ))
        return {
            "path": path,
            "legacy": rows.get(legacy_path, 0),
            "canonical": rows.get(canonical_path, 0),
            "updated": 0
        }
    finally:
        con.close()

def verify_sqlite_unlocked(path):
    con = sqlite3.connect(path, timeout=0)
    try:
        con.execute("pragma busy_timeout = 0")
        con.execute("begin immediate")
        con.rollback()
    finally:
        con.close()

def backup_path(path):
    relative = os.path.relpath(path, codex_home)
    destination = os.path.join(backup_dir, relative)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.copy2(path, destination)
    summary["backups"].append(destination)

def backup_artifacts():
    artifacts = []
    for path in sqlite_paths:
        artifacts.append(path)
        artifacts.append(f"{path}-wal")
        artifacts.append(f"{path}-shm")
    artifacts.extend(text_paths)

    os.makedirs(backup_dir, exist_ok=True)
    for path in unique(artifacts):
        if os.path.exists(path):
            backup_path(path)

def normalize_toml(text):
    legacy_header = f'[projects."{legacy_path}"]'
    canonical_header = f'[projects."{canonical_path}"]'
    has_canonical_header = canonical_header in text
    lines = text.splitlines(keepends=True)
    output = []
    index = 0

    while index < len(lines):
        line = lines[index]
        if line.strip() == legacy_header and has_canonical_header:
            index += 1
            while index < len(lines) and not lines[index].lstrip().startswith("["):
                index += 1
            continue

        output.append(line.replace(legacy_path, canonical_path))
        index += 1

    return "".join(output)

for path in sqlite_paths:
    try:
        summary["sqlite"].append(sqlite_counts(path))
    except sqlite3.Error as error:
        fail(f"Could not inspect {path}: {error}")

for path in text_paths:
    if not os.path.exists(path):
        summary["files"].append({"path": path, "missing": True, "legacy": 0, "canonical": 0, "updated": False})
        continue

    with open(path, "r", encoding="utf-8") as handle:
        contents = handle.read()
    summary["files"].append({
        "path": path,
        "legacy": contents.count(legacy_path),
        "canonical": contents.count(canonical_path),
        "updated": False
    })

if apply_changes:
    for path in sqlite_paths:
        try:
            verify_sqlite_unlocked(path)
        except sqlite3.Error as error:
            fail(f"SQLite database is locked or not writable: {path}: {error}")

    backup_artifacts()

    for item in summary["sqlite"]:
        if item["legacy"] == 0:
            continue
        con = sqlite3.connect(item["path"], timeout=0)
        try:
            con.execute("pragma busy_timeout = 0")
            cursor = con.execute("update threads set cwd = ? where cwd = ?", (canonical_path, legacy_path))
            item["updated"] = cursor.rowcount
            con.commit()
        finally:
            con.close()

    for item in summary["files"]:
        if item.get("missing") or item["legacy"] == 0:
            continue
        with open(item["path"], "r", encoding="utf-8") as handle:
            contents = handle.read()
        if item["path"].endswith("config.toml"):
            next_contents = normalize_toml(contents)
        else:
            next_contents = contents.replace(legacy_path, canonical_path)
        if next_contents != contents:
            with open(item["path"], "w", encoding="utf-8") as handle:
                handle.write(next_contents)
            item["updated"] = True

print(json.dumps(summary, indent=2, sort_keys=True))
`
}

function parseJsonObjectFromOutput (output: string): { value?: unknown, preamble?: string, error?: string } {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')

  if (start === -1 || end === -1 || end < start) {
    return {
      preamble: output.trim(),
      error: 'Remote repair did not print a JSON object'
    }
  }

  try {
    return {
      value: JSON.parse(output.slice(start, end + 1)) as unknown,
      ...(start === 0 ? {} : { preamble: output.slice(0, start).trim() })
    }
  } catch (error) {
    return {
      preamble: output.trim(),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function runCodexRepair (
  context: WorkspaceContext,
  alias: string,
  options: CodexRepairOptions = {}
): Promise<number> {
  const now = options.now ?? new Date()
  const repairOptions = {
    ...options,
    now
  }
  const host = repairHostCodexPathIdentity(context, alias, repairOptions)
  const result = await runBuffered('ssh', [
    '-o',
    'BatchMode=yes',
    alias,
    'python3',
    '-'
  ], {
    input: buildCodexRepairScript(context, repairOptions),
    mirrorStdout: false,
    mirrorStderr: 'stderr'
  })
  const parsedRemote = parseJsonObjectFromOutput(result.stdout)
  const remote = parsedRemote.value ?? {
    ok: false,
    error: parsedRemote.error,
    stdout: result.stdout.trim()
  }
  const summary = {
    ok: result.code === 0 && isRecord(remote) && remote.ok === true,
    mode: options.apply === true ? 'apply' : 'dry-run',
    host,
    remote,
    ...(parsedRemote.preamble === undefined || parsedRemote.preamble.length === 0 ? {} : { remotePreamble: parsedRemote.preamble })
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

  return summary.ok ? 0 : (result.code === 0 ? 1 : result.code)
}
