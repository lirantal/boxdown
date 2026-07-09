import { legacyCodexRemotePathForWorkspace, codexRemotePathForWorkspace } from './codex-app-config.ts'
import type { WorkspaceContext } from './paths.ts'
import { runBuffered } from './process.ts'

export interface CodexRepairOptions {
  apply?: boolean
  now?: Date
  legacyPath?: string
  canonicalPath?: string
  codexHome?: string
}

function timestampFor (now: Date): string {
  return now.toISOString().replace(/[-:.]/gu, '').replace(/000Z$/u, 'Z')
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

export async function runCodexRepair (
  context: WorkspaceContext,
  alias: string,
  options: CodexRepairOptions = {}
): Promise<number> {
  const result = await runBuffered('ssh', [
    '-o',
    'BatchMode=yes',
    alias,
    'python3',
    '-'
  ], {
    input: buildCodexRepairScript(context, options),
    mirrorStdout: 'stdout',
    mirrorStderr: 'stderr'
  })

  return result.code
}
