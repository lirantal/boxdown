#!/usr/bin/env bash
# Prepare a writable container-global Git config from the host snapshot.

set -euo pipefail

SOURCE_PATH="${BOXDOWN_GITCONFIG_SOURCE_PATH:-/opt/boxdown/state/host-gitconfig/.gitconfig}"
TARGET_PATH="${BOXDOWN_GITCONFIG_TARGET_PATH:-/home/node/.gitconfig}"

main() {
  progress "Preparing writable Git config"
  if ! install_writable_gitconfig; then
    return 0
  fi

  progress "Configuring container Git authentication"
  sanitize_github_rewrites
  sanitize_host_credential_helpers credential.helper
  sanitize_host_credential_helpers credential.https://github.com.helper
  configure_container_github_auth
  disable_container_git_signing
}

progress() {
  if [[ "${BOXDOWN_PROGRESS:-0}" == "1" ]]; then
    printf 'BOXDOWN_PROGRESS: %s\n' "$*"
  fi
}

install_writable_gitconfig() {
  local target_dir

  target_dir="$(dirname "${TARGET_PATH}")"
  mkdir -p "${target_dir}"

  if command -v mountpoint >/dev/null 2>&1 && mountpoint -q "${TARGET_PATH}"; then
    echo "git-config-bootstrap: ${TARGET_PATH} is still a mount; recreate the devcontainer so Boxdown can install a writable Git config copy." >&2
    return 1
  fi

  if [[ -f "${SOURCE_PATH}" ]]; then
    cp "${SOURCE_PATH}" "${TARGET_PATH}"
  else
    : > "${TARGET_PATH}"
  fi

  chmod 0600 "${TARGET_PATH}" || true
  ensure_node_owns_gitconfig

  if [[ ! -w "${TARGET_PATH}" ]]; then
    echo "git-config-bootstrap: ${TARGET_PATH} is not writable; recreate the devcontainer so Boxdown can install a writable Git config copy." >&2
    return 1
  fi
}

ensure_node_owns_gitconfig() {
  if ! id node >/dev/null 2>&1; then
    return 0
  fi

  if [[ "$(id -un)" == "root" ]]; then
    chown node:node "${TARGET_PATH}" || true
    return 0
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo chown node:node "${TARGET_PATH}" >/dev/null 2>&1 || true
  fi
}

git_global() {
  GIT_CONFIG_GLOBAL="${TARGET_PATH}" git config --global "$@"
}

sanitize_github_rewrites() {
  git_global --unset-all url.git@github.com:.insteadOf >/dev/null 2>&1 || true
  git_global --unset-all url.ssh://git@github.com/.insteadOf >/dev/null 2>&1 || true
}

sanitize_host_credential_helpers() {
  local key="$1"
  local values=()
  local value

  while IFS= read -r value; do
    values+=("${value}")
  done < <(git_global --get-all "${key}" 2>/dev/null || true)

  if [[ "${#values[@]}" -eq 0 ]]; then
    return 0
  fi

  git_global --unset-all "${key}" >/dev/null 2>&1 || true

  for value in "${values[@]}"; do
    if is_unsupported_credential_helper "${value}"; then
      continue
    fi

    git_global --add "${key}" "${value}"
  done
}

is_unsupported_credential_helper() {
  local value="$1"
  local executable

  case "${value}" in
    /Users/* | /Applications/* | /opt/homebrew/* | !/Users/* | !/Applications/* | !/opt/homebrew/*)
      return 0
      ;;
  esac

  if [[ "${value}" == /* ]]; then
    executable="${value%% *}"
    if [[ ! -e "${executable}" ]]; then
      return 0
    fi
  fi

  return 1
}

configure_container_github_auth() {
  git_global --unset-all credential.https://github.com.helper >/dev/null 2>&1 || true
  git_global --add credential.https://github.com.helper ''
  git_global --add credential.https://github.com.helper '!gh auth git-credential'
}

disable_container_git_signing() {
  git_global --replace-all commit.gpgsign false
  git_global --replace-all tag.gpgsign false
}

main "$@"
