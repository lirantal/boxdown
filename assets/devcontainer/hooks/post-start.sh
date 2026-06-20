#!/usr/bin/env bash
# post-start: runs after each container start (postStartCommand in devcontainer.json).
# Naming matches post-create.sh; extend with more steps as needed (e.g. source scripts from .devcontainer/utils/).

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVCONTAINER_DIR="$(cd "${HOOKS_DIR}/.." && pwd)"

main() {
  configure_sshd_runtime
  refresh_codex_cli
  remove_ephemeral_env_file_if_present
}

configure_sshd_runtime() {
  bash "${DEVCONTAINER_DIR}/utils/ssh-bootstrap.sh" runtime
}

refresh_codex_cli() {
  bash "${DEVCONTAINER_DIR}/utils/codex-cli-update.sh" update-now ||
    echo "post-start: warning: could not refresh Codex CLI." >&2
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
