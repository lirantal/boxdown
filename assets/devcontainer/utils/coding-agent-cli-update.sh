#!/usr/bin/env bash
#
# Install or refresh coding-agent CLIs inside the devcontainer.

set -euo pipefail

DEFAULT_AGENTS=(codex opencode claude antigravity)
UPDATE_INTERVAL_SECONDS="${BOXDOWN_CODING_AGENT_UPDATE_INTERVAL_SECONDS:-3600}"
UPDATE_LOCK_WAIT_SECONDS="${BOXDOWN_CODING_AGENT_UPDATE_LOCK_WAIT_SECONDS:-120}"
STATE_DIR="${BOXDOWN_CODING_AGENT_UPDATE_STATE_DIR:-${HOME}/.cache/boxdown/coding-agent-clis}"

log() {
  echo "coding-agent-cli-update: $*" >&2
}

usage() {
  cat >&2 <<'EOF'
Usage: coding-agent-cli-update.sh <install|update-now|maybe-update> [codex|opencode|claude|antigravity...]
EOF
}

numeric_or_default() {
  local value="$1"
  local default_value="$2"

  case "${value}" in
    '' | *[!0-9]*) printf '%s\n' "${default_value}" ;;
    *) printf '%s\n' "${value}" ;;
  esac
}

env_value() {
  local name="$1"
  local default_value="$2"
  local value="${!name-}"

  printf '%s\n' "${value:-${default_value}}"
}

agent_env_prefix() {
  case "$1" in
    codex) printf '%s\n' CODEX ;;
    opencode) printf '%s\n' OPENCODE ;;
    claude) printf '%s\n' CLAUDE ;;
    antigravity) printf '%s\n' ANTIGRAVITY ;;
    *)
      log "unknown coding-agent CLI: $1"
      return 1
      ;;
  esac
}

agent_stamp_file() {
  local agent="$1"
  local prefix
  local legacy_value

  prefix="$(agent_env_prefix "${agent}")" || return 1
  if [ "${agent}" = "codex" ]; then
    legacy_value="${BOXDOWN_CODEX_UPDATE_STAMP_FILE:-}"
    if [ -n "${legacy_value}" ]; then
      printf '%s\n' "${legacy_value}"
      return 0
    fi
  fi
  env_value "BOXDOWN_${prefix}_UPDATE_STAMP_FILE" "${STATE_DIR}/${agent}.stamp"
}

agent_lock_dir() {
  local agent="$1"
  local prefix
  local legacy_value

  prefix="$(agent_env_prefix "${agent}")" || return 1
  if [ "${agent}" = "codex" ]; then
    legacy_value="${BOXDOWN_CODEX_UPDATE_LOCK_DIR:-}"
    if [ -n "${legacy_value}" ]; then
      printf '%s\n' "${legacy_value}"
      return 0
    fi
  fi
  env_value "BOXDOWN_${prefix}_UPDATE_LOCK_DIR" "${STATE_DIR}/${agent}.lock"
}

agent_interval_seconds() {
  local agent="$1"
  local prefix

  prefix="$(agent_env_prefix "${agent}")" || return 1
  env_value "BOXDOWN_${prefix}_UPDATE_INTERVAL_SECONDS" "${UPDATE_INTERVAL_SECONDS}"
}

agent_lock_wait_seconds() {
  local agent="$1"
  local prefix

  prefix="$(agent_env_prefix "${agent}")" || return 1
  env_value "BOXDOWN_${prefix}_UPDATE_LOCK_WAIT_SECONDS" "${UPDATE_LOCK_WAIT_SECONDS}"
}

ensure_state_dir() {
  local stamp_file="$1"
  local lock_dir="$2"

  mkdir -p "$(dirname "${stamp_file}")" "$(dirname "${lock_dir}")"
}

stamp_fresh() {
  local agent="$1"
  local stamp_file="$2"
  local interval_seconds
  local stamp_time
  local now

  interval_seconds="$(numeric_or_default "$(agent_interval_seconds "${agent}")" 3600)"
  if [ "${interval_seconds}" = "0" ]; then
    return 1
  fi

  if [ ! -f "${stamp_file}" ]; then
    return 1
  fi

  stamp_time="$(stat -c %Y "${stamp_file}" 2>/dev/null || stat -f %m "${stamp_file}" 2>/dev/null || printf '0')"
  now="$(date +%s)"
  [ "$((now - stamp_time))" -lt "${interval_seconds}" ]
}

wait_for_existing_lock() {
  local agent="$1"
  local lock_dir="$2"
  local wait_seconds
  local deadline

  wait_seconds="$(numeric_or_default "$(agent_lock_wait_seconds "${agent}")" 120)"
  deadline=$((SECONDS + wait_seconds))

  while [ -d "${lock_dir}" ]; do
    if [ "${SECONDS}" -ge "${deadline}" ]; then
      return 1
    fi

    sleep 1
  done
}

acquire_lock() {
  local agent="$1"
  local lock_dir="$2"

  if mkdir "${lock_dir}" 2>/dev/null; then
    ACTIVE_LOCK_DIR="${lock_dir}"
    return 0
  fi

  log "${agent}: another update is running; waiting for it to finish."
  wait_for_existing_lock "${agent}" "${lock_dir}" || {
    log "${agent}: another update is still running; skipping this preflight."
    return 1
  }

  mkdir "${lock_dir}" 2>/dev/null || return 1
  ACTIVE_LOCK_DIR="${lock_dir}"
}

release_lock() {
  if [ -n "${ACTIVE_LOCK_DIR:-}" ]; then
    rmdir "${ACTIVE_LOCK_DIR}" 2>/dev/null || true
    ACTIVE_LOCK_DIR=""
  fi
}

run_installer_url() {
  local url="$1"
  shift

  curl -fsSL "${url}" | "$@"
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

prepare_codex_home() {
  local codex_home="${CODEX_HOME:-${HOME}/.codex}"

  if [ -e "${codex_home}" ] && [ ! -d "${codex_home}" ]; then
    log "codex: ${codex_home} exists but is not a directory."
    return 1
  fi

  if [ ! -d "${codex_home}" ]; then
    mkdir -p "${codex_home}"
  fi

  if [ ! -w "${codex_home}" ]; then
    run_as_root chown "$(id -u):$(id -g)" "${codex_home}" 2>/dev/null || true
  fi

  if [ ! -w "${codex_home}" ]; then
    run_as_root chmod u+rwx "${codex_home}" 2>/dev/null || true
  fi

  if [ ! -w "${codex_home}" ]; then
    log "codex: ${codex_home} is not writable; Codex CLI install/update may fail."
    return 1
  fi
}

install_codex() {
  local url

  url="${BOXDOWN_CODEX_INSTALL_URL:-https://chatgpt.com/codex/install.sh}"
  run_installer_url "${url}" env CODEX_NON_INTERACTIVE=1 sh
}

update_codex() {
  prepare_codex_home || return 1

  if command -v codex >/dev/null 2>&1; then
    if codex update; then
      return 0
    fi

    log "codex: codex update failed; falling back to installer."
  fi

  install_codex
}

install_opencode() {
  local url

  url="${BOXDOWN_OPENCODE_INSTALL_URL:-https://opencode.ai/install}"
  run_installer_url "${url}" bash -s -- --no-modify-path
}

update_opencode() {
  if command -v opencode >/dev/null 2>&1; then
    if opencode upgrade --method curl; then
      return 0
    fi

    log "opencode: opencode upgrade failed; falling back to installer."
  fi

  install_opencode
}

install_claude() {
  local url

  url="${BOXDOWN_CLAUDE_INSTALL_URL:-https://claude.ai/install.sh}"
  run_installer_url "${url}" bash
}

update_claude() {
  if command -v claude >/dev/null 2>&1; then
    if claude update; then
      return 0
    fi

    log "claude: claude update failed; falling back to installer."
  fi

  install_claude
}

install_antigravity() {
  local url

  url="${BOXDOWN_ANTIGRAVITY_INSTALL_URL:-https://antigravity.google/cli/install.sh}"
  run_installer_url "${url}" bash
}

update_antigravity() {
  install_antigravity
}

run_agent_update() {
  case "$1" in
    codex) update_codex ;;
    opencode) update_opencode ;;
    claude) update_claude ;;
    antigravity) update_antigravity ;;
    *)
      log "unknown coding-agent CLI: $1"
      return 1
      ;;
  esac
}

touch_stamp() {
  local stamp_file="$1"

  touch "${stamp_file}"
}

update_now_agent() {
  local agent="$1"
  local stamp_file
  local lock_dir
  local result=0

  stamp_file="$(agent_stamp_file "${agent}")" || return 1
  lock_dir="$(agent_lock_dir "${agent}")" || return 1
  ensure_state_dir "${stamp_file}" "${lock_dir}"
  acquire_lock "${agent}" "${lock_dir}" || return 1
  if run_agent_update "${agent}"; then
    touch_stamp "${stamp_file}"
  else
    result=$?
  fi
  release_lock
  return "${result}"
}

maybe_update_agent() {
  local agent="$1"
  local stamp_file
  local lock_dir
  local result=0

  stamp_file="$(agent_stamp_file "${agent}")" || return 1
  lock_dir="$(agent_lock_dir "${agent}")" || return 1
  ensure_state_dir "${stamp_file}" "${lock_dir}"
  if stamp_fresh "${agent}" "${stamp_file}"; then
    return 0
  fi

  acquire_lock "${agent}" "${lock_dir}" || return 0
  if stamp_fresh "${agent}" "${stamp_file}"; then
    release_lock
    return 0
  fi

  if run_agent_update "${agent}"; then
    touch_stamp "${stamp_file}"
  else
    result=$?
  fi
  release_lock
  return "${result}"
}

run_action_for_agent() {
  local action="$1"
  local agent="$2"

  case "${action}" in
    install | update-now)
      update_now_agent "${agent}"
      ;;
    maybe-update)
      maybe_update_agent "${agent}"
      ;;
    *)
      usage
      return 1
      ;;
  esac
}

main() {
  local action="${1:-}"
  local failures=0
  local agents

  if [ -z "${action}" ]; then
    usage
    return 1
  fi
  shift

  if [ "$#" -eq 0 ]; then
    agents=("${DEFAULT_AGENTS[@]}")
  else
    agents=("$@")
  fi

  for agent in "${agents[@]}"; do
    if ! run_action_for_agent "${action}" "${agent}"; then
      log "${agent}: ${action} failed."
      failures=$((failures + 1))
    fi
  done

  [ "${failures}" -eq 0 ]
}

trap 'release_lock' EXIT
main "$@"
