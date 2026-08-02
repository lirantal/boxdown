#!/usr/bin/env bash
# post-start: runs after each container start (postStartCommand in devcontainer.json).
set -euo pipefail

DEVCONTAINER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "${DEVCONTAINER_DIR}/utils/git-signing-bootstrap.sh"

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

  [[ -f "${plan_path}" && ! -L "${plan_path}" ]] || return 1
  [[ -f "${result_path}" && ! -L "${result_path}" ]] || return 0
  /usr/local/bin/node - "${plan_path}" "${result_path}" <<'NODE'
const { lstatSync, readFileSync } = require('node:fs')
try {
  for (const path of process.argv.slice(2)) if (lstatSync(path).isSymbolicLink()) process.exit(1)
  const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const result = JSON.parse(readFileSync(process.argv[3], 'utf8'))
  process.exit(plan?.version === 1 && typeof plan.fingerprint === 'string' &&
    result?.version === 1 && result.fingerprint === plan.fingerprint && result.state === 'succeeded' ? 1 : 0)
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

main "$@"
