#!/usr/bin/env bash
#
# Install or refresh the Codex CLI inside the devcontainer.

set -euo pipefail

CODEX_INSTALL_URL="${BOXDOWN_CODEX_INSTALL_URL:-https://chatgpt.com/codex/install.sh}"
UPDATE_INTERVAL_SECONDS="${BOXDOWN_CODEX_UPDATE_INTERVAL_SECONDS:-3600}"
UPDATE_LOCK_WAIT_SECONDS="${BOXDOWN_CODEX_UPDATE_LOCK_WAIT_SECONDS:-120}"
STAMP_FILE="${BOXDOWN_CODEX_UPDATE_STAMP_FILE:-${HOME}/.cache/boxdown/codex-cli-update.stamp}"
LOCK_DIR="${BOXDOWN_CODEX_UPDATE_LOCK_DIR:-${HOME}/.cache/boxdown/codex-cli-update.lock}"

log() {
  echo "codex-cli-update: $*" >&2
}

numeric_or_default() {
  local value="$1"
  local default_value="$2"

  case "${value}" in
    '' | *[!0-9]*) printf '%s\n' "${default_value}" ;;
    *) printf '%s\n' "${value}" ;;
  esac
}

ensure_state_dir() {
  mkdir -p "$(dirname "${STAMP_FILE}")" "$(dirname "${LOCK_DIR}")"
}

stamp_fresh() {
  local stamp_time
  local now

  UPDATE_INTERVAL_SECONDS="$(numeric_or_default "${UPDATE_INTERVAL_SECONDS}" 3600)"
  if [ "${UPDATE_INTERVAL_SECONDS}" = "0" ]; then
    return 1
  fi

  if [ ! -f "${STAMP_FILE}" ]; then
    return 1
  fi

  stamp_time="$(stat -c %Y "${STAMP_FILE}" 2>/dev/null || stat -f %m "${STAMP_FILE}" 2>/dev/null || printf '0')"
  now="$(date +%s)"
  [ "$((now - stamp_time))" -lt "${UPDATE_INTERVAL_SECONDS}" ]
}

wait_for_existing_lock() {
  local deadline

  UPDATE_LOCK_WAIT_SECONDS="$(numeric_or_default "${UPDATE_LOCK_WAIT_SECONDS}" 120)"
  deadline=$((SECONDS + UPDATE_LOCK_WAIT_SECONDS))

  while [ -d "${LOCK_DIR}" ]; do
    if [ "${SECONDS}" -ge "${deadline}" ]; then
      return 1
    fi

    sleep 1
  done
}

acquire_lock() {
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT
    return 0
  fi

  log "another Codex CLI update is running; waiting for it to finish."
  wait_for_existing_lock || {
    log "another Codex CLI update is still running; skipping this preflight."
    return 1
  }

  mkdir "${LOCK_DIR}" 2>/dev/null || return 1
  trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT
}

run_codex_installer() {
  curl -fsSL "${CODEX_INSTALL_URL}" | CODEX_NON_INTERACTIVE=1 sh
}

run_codex_update() {
  if command -v codex >/dev/null 2>&1; then
    if codex update; then
      return 0
    fi

    log "codex update failed; falling back to installer."
  fi

  run_codex_installer
}

touch_stamp() {
  ensure_state_dir
  touch "${STAMP_FILE}"
}

update_now() {
  ensure_state_dir
  acquire_lock
  run_codex_update
  touch_stamp
}

maybe_update() {
  ensure_state_dir
  if stamp_fresh; then
    return 0
  fi

  acquire_lock || return 0
  if stamp_fresh; then
    return 0
  fi

  run_codex_update
  touch_stamp
}

main() {
  case "${1:-maybe-update}" in
    install | update-now)
      update_now
      ;;
    maybe-update)
      maybe_update
      ;;
    *)
      echo "Usage: $(basename "$0") [install|update-now|maybe-update]" >&2
      return 1
      ;;
  esac
}

main "$@"
