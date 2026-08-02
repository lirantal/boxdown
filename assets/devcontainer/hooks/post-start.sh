#!/usr/bin/env bash
# post-start: runs after each container start (postStartCommand in devcontainer.json).
set -euo pipefail

DEVCONTAINER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVCONTAINER_DIR="$(cd "${HOOKS_DIR}/.." && pwd)"

main() {
  run_step "Preparing SSH runtime" configure_sshd_runtime
  run_step "Preparing workspace toolchains" configure_toolchains_if_needed
  run_step "Refreshing coding-agent CLIs" refresh_coding_agent_clis
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

configure_sshd_runtime() {
  bash "${DEVCONTAINER_DIR}/utils/ssh-bootstrap.sh" runtime
}

toolchains_need_bootstrap() {
  local plan_path="${BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH:-/opt/boxdown/state/toolchains/plan/plan.json}"
  local result_path="${BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR:-/opt/boxdown/state/toolchain-results}/result.json"
  local plan_node="${1:-/usr/local/bin/node}"

  "${plan_node}" - "${plan_path}" "${result_path}" <<'NODE'
const { lstatSync, readFileSync, statSync } = require('node:fs')
const { isAbsolute, normalize, parse, sep } = require('node:path')
const [planPath, resultPath] = process.argv.slice(2)
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactHex = value => typeof value === 'string' && value.length === 64 && [...value].every(char => '0123456789abcdef'.includes(char))
const exactVersion = value => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
  '0123456789'.includes(value[0]) && [...value].every(char => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.+-'.includes(char))
const exactTime = value => {
  if (typeof value !== 'string' || value.length !== 24) return false
  try { return new Date(value).toISOString() === value } catch { return false }
}
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
try {
  if (!safePath(planPath)) process.exit(0)
  try { lstatSync(planPath) } catch (error) { if (error?.code === 'ENOENT') process.exit(1); throw error }
  if (!safePath(resultPath)) process.exit(0)
  if (statSync(planPath).size > 65536) process.exit(0)
  const plan = JSON.parse(readFileSync(planPath, 'utf8'))
  if (!isRecord(plan) || plan.version !== 1 || !exactHex(plan.fingerprint) || !Array.isArray(plan.selected) || plan.selected.length > 4) process.exit(0)
  const expected = new Map()
  for (const item of plan.selected) {
    if (!isRecord(item) || !['node', 'python', 'go', 'rust'].includes(item.id) || !exactVersion(item.version) || expected.has(item.id)) process.exit(0)
    expected.set(item.id, item.version)
  }
  try { lstatSync(resultPath) } catch (error) { if (error?.code === 'ENOENT') process.exit(0); throw error }
  if (statSync(resultPath).size > 65536) process.exit(0)
  const result = JSON.parse(readFileSync(resultPath, 'utf8'))
  const seen = new Set()
  const validResult = isRecord(result) && result.version === 1 && result.fingerprint === plan.fingerprint && result.state === 'succeeded' &&
    exactTime(result.updatedAt) && Array.isArray(result.runtimes) && result.runtimes.length === expected.size &&
    result.runtimes.every((item) => isRecord(item) && typeof item.id === 'string' && !seen.has(item.id) && seen.add(item.id) &&
      exactVersion(item.version) && expected.get(item.id) === item.version && item.state === 'succeeded')
  process.exit(validResult ? 1 : 0)
} catch {
  process.exit(0)
}
NODE
}

configure_toolchains_if_needed() {
  if toolchains_need_bootstrap; then
    bash "${DEVCONTAINER_DIR}/utils/toolchains-bootstrap.sh" ||
      echo "post-start: warning: workspace toolchain provisioning could not start." >&2
  fi
}

refresh_coding_agent_clis() {
  bash "${DEVCONTAINER_DIR}/utils/coding-agent-cli-update.sh" maybe-update ||
    echo "post-start: warning: one or more coding-agent CLI refreshes failed." >&2
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  bash "${DEVCONTAINER_DIR}/utils/git-signing-bootstrap.sh"
  main "$@"
fi
