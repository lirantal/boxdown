#!/usr/bin/env bash
# post-start: runs after each container start (postStartCommand in devcontainer.json).
# Naming matches post-create.sh; extend with more steps as needed (e.g. source scripts from .devcontainer/utils/).

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVCONTAINER_DIR="$(cd "${HOOKS_DIR}/.." && pwd)"

main() {
  run_step "Preparing SSH runtime" configure_sshd_runtime
  run_step "Refreshing coding-agent CLIs" refresh_coding_agent_clis
  run_step "Cleaning ephemeral environment file" remove_ephemeral_env_file_if_present
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

# When initializeCommand + runArgs inject secrets via .env.development, remove the file
# after start so it is not left on disk and tooling that assumes absence does not break.
remove_ephemeral_env_file_if_present() {
  local env_file=".env.development"
  if [[ -f "$env_file" ]]; then
    rm -f "$env_file"
  fi
}

main "$@"
