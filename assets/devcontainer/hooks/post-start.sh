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

refresh_coding_agent_clis() {
  bash "${DEVCONTAINER_DIR}/utils/coding-agent-cli-update.sh" maybe-update ||
    echo "post-start: warning: one or more coding-agent CLI refreshes failed." >&2
}

main "$@"
