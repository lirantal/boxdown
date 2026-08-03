#!/bin/bash
set -e

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVCONTAINER_DIR="$(cd "${HOOKS_DIR}/.." && pwd)"

main() {
  run_step "Configuring agent profile" configure_agent_profile
  run_step "Configuring global Git" configure_global_git
  run_step "Configuring Git commit signing" configure_git_signing
  run_step "Configuring workspace Git" configure_local_git
  run_step "Configuring runtime secret environment" configure_runtime_secret_environment
  run_step "Preparing SSH runtime" configure_sshd_runtime
  run_step "Initializing coding-agent refresh state" initialize_coding_agent_refresh_state
  run_step "Preparing workspace toolchains" configure_toolchains
  run_step "Installing workspace dependencies" run_deps_install
}

progress() {
  if [[ "${BOXDOWN_PROGRESS:-0}" == "1" ]]; then
    printf 'BOXDOWN_PROGRESS: %s\n' "$*"
  fi
}

run_step() {
  local label="$1"
  shift

  progress "$label"
  "$@"
}

configure_agent_profile() {
  node "${DEVCONTAINER_DIR}/utils/agent-profile-bootstrap.mjs"
}

configure_global_git() {
  bash "${DEVCONTAINER_DIR}/utils/git-config-bootstrap.sh"
}

configure_git_signing() {
  bash "${DEVCONTAINER_DIR}/utils/git-signing-bootstrap.sh"
}

configure_local_git() {
  # Local git prefs only apply inside a repository; skip when there is no .git (avoids postCreate failure).
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git config --local --replace-all core.pager 'less -R'
    git config --local --unset-all credential.https://github.com.helper >/dev/null 2>&1 || true
    git config --local --add credential.https://github.com.helper ''
    git config --local --add credential.https://github.com.helper '!gh auth git-credential'
  fi
}

configure_runtime_secret_environment() {
  local bashrc="${HOME}/.bashrc"
  local source_line='source /opt/boxdown/devcontainer/utils/secret-env-bootstrap.sh'

  touch "${bashrc}"
  if ! grep -Fqx "${source_line}" "${bashrc}"; then
    printf '%s\n' "${source_line}" >> "${bashrc}"
  fi
}

configure_sshd_runtime() {
  bash "${DEVCONTAINER_DIR}/utils/ssh-bootstrap.sh" runtime
}

initialize_coding_agent_refresh_state() {
  bash "${DEVCONTAINER_DIR}/utils/coding-agent-cli-update.sh" initialize-stamps
}

configure_toolchains() {
  bash "${DEVCONTAINER_DIR}/utils/toolchains-bootstrap.sh" ||
    echo "post-create: warning: workspace toolchain provisioning could not start." >&2
}

run_deps_install() {
  local plan_path="${BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH:-/opt/boxdown/state/toolchains/plan/plan.json}"
  local plan_node="${1:-/usr/local/bin/node}"
  if [[ ! -e "${plan_path}" && ! -L "${plan_path}" ]]; then
    bash "${DEVCONTAINER_DIR}/utils/deps-install.sh"
    return 0
  fi

  if "${plan_node}" - "${plan_path}" <<'NODE'
const { lstatSync, readFileSync } = require('node:fs')
const { isAbsolute, normalize, parse, sep } = require('node:path')
const path = process.argv[2]
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactHex = value => typeof value === 'string' && value.length === 64 && [...value].every(char => '0123456789abcdef'.includes(char))
const exactVersion = value => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
  '0123456789'.includes(value[0]) && [...value].every(char => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.+-'.includes(char))
const exactTime = value => {
  if (typeof value !== 'string' || value.length !== 24) return false
  try { return new Date(value).toISOString() === value } catch { return false }
}
const evidenceIsValid = value => isRecord(value) && typeof value.path === 'string' && typeof value.source === 'string' &&
  typeof value.value === 'string' && typeof value.exact === 'boolean'
function safePath (target) {
  if (!isAbsolute(target) || normalize(target) !== target || target.includes('\0')) return false
  const root = parse(target).root
  let current = root
  for (const part of target.slice(root.length).split(sep).filter(Boolean)) {
    current = current === root ? `${root}${part}` : `${current}${sep}${part}`
    try { if (lstatSync(current).isSymbolicLink()) return false } catch (error) { if (error?.code !== 'ENOENT') return false }
  }
  return true
}
let plan
try {
  const leaf = lstatSync(path)
  if (!safePath(path) || !leaf.isFile() || leaf.size > 65536) process.exit(1)
  plan = JSON.parse(readFileSync(path, 'utf8'))
} catch {
  process.exit(1)
}
if (!isRecord(plan) || plan.version !== 1 || typeof plan.workspaceId !== 'string' || plan.workspaceId.length === 0 ||
  !exactHex(plan.fingerprint) || !Array.isArray(plan.selected) || plan.selected.length > 4 || !exactTime(plan.updatedAt)) process.exit(1)
const ids = new Set()
for (const item of plan.selected) {
  if (!isRecord(item) || !['node', 'python', 'go', 'rust'].includes(item.id) || !exactVersion(item.version) || ids.has(item.id) ||
    !['interactive', 'cli', 'persisted'].includes(item.selectionSource) ||
    !['override', 'project', 'boxdown-default'].includes(item.resolutionSource) ||
    !Array.isArray(item.evidence) || !item.evidence.every(evidenceIsValid) ||
    (item.compatibilityNote !== undefined && typeof item.compatibilityNote !== 'string')) process.exit(1)
  ids.add(item.id)
}
NODE
  then
    return 0
  fi
  echo "post-create: warning: present toolchain plan is invalid; skipping legacy dependency installation." >&2
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
