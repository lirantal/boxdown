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

run_deps_install() {
  bash "${DEVCONTAINER_DIR}/utils/deps-install.sh"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
