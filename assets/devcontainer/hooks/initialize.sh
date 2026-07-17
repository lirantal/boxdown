#!/usr/bin/env bash
# initialize: runs on host before container create/start (initializeCommand).
# Refreshes private runtime secret files and snapshots host Git config.

set -euo pipefail

HOST_GITCONFIG_PATH="${BOXDOWN_HOST_GITCONFIG_PATH:-${HOME:-}/.gitconfig}"
HOST_GITCONFIG_SNAPSHOT_PATH="${BOXDOWN_HOST_GITCONFIG_SNAPSHOT_PATH:-}"
SECRET_ENV_DIR="${BOXDOWN_SECRET_ENV_DIR:-}"
OP_TOKEN_REFERENCE="op://Private/1Password op CLI Service Account for DevContainers/password"

main() {
  progress "Snapshotting host Git config"
  snapshot_host_gitconfig
  progress "Refreshing runtime secret environment"
  refresh_runtime_secret_environment
}

progress() {
  if [[ "${BOXDOWN_PROGRESS:-0}" == "1" ]]; then
    printf 'BOXDOWN_PROGRESS: %s\n' "$*"
  fi
}

snapshot_host_gitconfig() {
  local snapshot_dir

  if [[ -z "${HOST_GITCONFIG_SNAPSHOT_PATH}" ]]; then
    echo "initialize.sh: host gitconfig snapshot path is not configured; skipping gitconfig snapshot."
    return 0
  fi

  snapshot_dir="$(dirname "${HOST_GITCONFIG_SNAPSHOT_PATH}")"
  mkdir -p "${snapshot_dir}"

  if [[ -f "${HOST_GITCONFIG_PATH}" ]]; then
    cp "${HOST_GITCONFIG_PATH}" "${HOST_GITCONFIG_SNAPSHOT_PATH}"
    chmod 0644 "${HOST_GITCONFIG_SNAPSHOT_PATH}"
    return 0
  fi

  rm -f "${HOST_GITCONFIG_SNAPSHOT_PATH}"
}

prepare_secret_env_dir() {
  if [[ -z "${SECRET_ENV_DIR}" ]]; then
    echo "initialize.sh: runtime secret directory is not configured; skipping optional secrets." >&2
    return 1
  fi

  umask 077
  mkdir -p "${SECRET_ENV_DIR}"
  chmod 0700 "${SECRET_ENV_DIR}"
}

write_secret_file() {
  local name="$1"
  local value="$2"
  local temporary_path

  temporary_path="$(mktemp "${SECRET_ENV_DIR}/.${name}.XXXXXX")"
  printf '%s' "${value}" > "${temporary_path}"
  chmod 0600 "${temporary_path}"
  mv -f "${temporary_path}" "${SECRET_ENV_DIR}/${name}"
}

refresh_host_environment_secret() {
  local name="$1"
  local value="${!name:-}"

  if [[ -n "${value}" ]]; then
    write_secret_file "${name}" "${value}"
  else
    rm -f "${SECRET_ENV_DIR}/${name}"
  fi
}

refresh_1password_service_account_token() {
  local token

  if ! command -v op >/dev/null 2>&1; then
    rm -f "${SECRET_ENV_DIR}/OP_SERVICE_ACCOUNT_TOKEN"
    return 0
  fi

  if ! token="$(op read "${OP_TOKEN_REFERENCE}" 2>/dev/null)"; then
    rm -f "${SECRET_ENV_DIR}/OP_SERVICE_ACCOUNT_TOKEN"
    return 0
  fi

  if [[ -z "${token}" ]]; then
    rm -f "${SECRET_ENV_DIR}/OP_SERVICE_ACCOUNT_TOKEN"
    return 0
  fi

  write_secret_file "OP_SERVICE_ACCOUNT_TOKEN" "${token}"
}

refresh_runtime_secret_environment() {
  if ! prepare_secret_env_dir; then
    return 0
  fi

  refresh_host_environment_secret "ANTHROPIC_API_KEY"
  refresh_host_environment_secret "SNYK_TOKEN"
  refresh_1password_service_account_token
}

main "$@"
