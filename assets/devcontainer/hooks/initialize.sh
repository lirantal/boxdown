#!/usr/bin/env bash
# initialize: runs on host before container create/start (initializeCommand).
# Refreshes private runtime secret files and snapshots host Git config.

set -euo pipefail

HOST_GITCONFIG_PATH="${BOXDOWN_HOST_GITCONFIG_PATH:-${HOME:-}/.gitconfig}"
HOST_GITCONFIG_SNAPSHOT_PATH="${BOXDOWN_HOST_GITCONFIG_SNAPSHOT_PATH:-}"
SECRET_ENV_DIR="${BOXDOWN_SECRET_ENV_DIR:-}"
OP_TOKEN_REFERENCE="op://Private/1Password op CLI Service Account for DevContainers/password"
WORKSPACE_FOLDER="${BOXDOWN_WORKSPACE_FOLDER:-}"
VARLOCK_BIN=""
VARLOCK_GUEST_PROXY_HOST="${BOXDOWN_VARLOCK_PROXY_HOST:-host.docker.internal}"
# Container-side view of SECRET_ENV_DIR (mount target in generated config).
VARLOCK_CONTAINER_CA_DIR="/run/boxdown/secrets/varlock-ca"
VARLOCK_PROXY_SESSION="${BOXDOWN_VARLOCK_PROXY_SESSION:-}"

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

remove_varlock_proxy_files() {
  rm -f "${SECRET_ENV_DIR}/varlock.env"
  rm -rf "${SECRET_ENV_DIR}/varlock-ca"
}

# Prefer the workspace's own varlock install (a project devDependency pins the
# version) and fall back to a global install on PATH.
resolve_varlock_bin() {
  if [[ -n "${WORKSPACE_FOLDER}" && -x "${WORKSPACE_FOLDER}/node_modules/.bin/varlock" ]]; then
    VARLOCK_BIN="${WORKSPACE_FOLDER}/node_modules/.bin/varlock"
    return 0
  fi
  if command -v varlock >/dev/null 2>&1; then
    VARLOCK_BIN="varlock"
    return 0
  fi
  return 1
}

# Find the id of the active proxy session started from the workspace folder.
# Boxdown requires Node on the host, so `node` is a safe JSON parser here.
find_varlock_session_for_workspace() {
  "${VARLOCK_BIN}" proxy status --format json 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const sessions = JSON.parse(raw);
        const match = sessions.find((session) => session.cwd === process.argv[1]);
        if (match) process.stdout.write(match.id);
      } catch {}
    });
  ' "${WORKSPACE_FOLDER}"
}

# Start a proxy daemon for the workspace. Fully detached from this hook's
# stdio: without that, a lingering intermediate shell can hold a pipe open and
# block the hook (or the Dev Container CLI capturing its output) forever. The
# daemon outlives this hook; its log stays in the workspace runtime directory
# (outside the container mount).
start_varlock_proxy_daemon() {
  local log_path

  log_path="$(dirname "${SECRET_ENV_DIR}")/varlock-proxy-start.log"
  (cd "${WORKSPACE_FOLDER}" \
    && nohup "${VARLOCK_BIN}" proxy start >> "${log_path}" 2>&1 < /dev/null &) > /dev/null 2>&1
}

# Wait for the booted daemon's session to register, setting
# VARLOCK_PROXY_SESSION. Booting can take a moment when the schema resolves
# values from a secrets manager (a 1Password biometric prompt, for example),
# so the wait allows for that.
wait_for_varlock_session() {
  local attempt

  for attempt in $(seq 1 $(( ${BOXDOWN_VARLOCK_BOOT_TIMEOUT_SECONDS:-30} * 2 ))); do
    VARLOCK_PROXY_SESSION="$(find_varlock_session_for_workspace)"
    if [[ -n "${VARLOCK_PROXY_SESSION}" ]]; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

varlock_proxy_env() {
  "${VARLOCK_BIN}" proxy env --session "${VARLOCK_PROXY_SESSION}" "$@" 2>/dev/null
}

# When the workspace has a varlock schema (.env.schema), container sessions get
# placeholder values plus proxy/CA wiring instead of real secrets. Real values
# then never enter the container; the credential proxy substitutes them at the
# network boundary on the host. Reuses the workspace's running proxy session or
# boots one. Returns non-zero (without failing the hook) when varlock is
# unavailable or the proxy cannot start, so the plaintext secret-file path
# below remains the fallback.
refresh_varlock_proxy_environment() {
  local wiring proxy_url proxy_port host_ca_path host_ca_dir
  local guest_env temporary_path guest_ca_dir

  if [[ "${BOXDOWN_VARLOCK:-1}" == "0" ]]; then
    remove_varlock_proxy_files
    return 1
  fi

  if [[ -z "${WORKSPACE_FOLDER}" || ! -f "${WORKSPACE_FOLDER}/.env.schema" ]]; then
    remove_varlock_proxy_files
    return 1
  fi

  if ! resolve_varlock_bin; then
    echo "initialize.sh: workspace has a .env.schema but varlock is not installed; using plaintext secret files. Install varlock (npm i varlock, or npm i -g varlock) to keep secrets out of the container." >&2
    remove_varlock_proxy_files
    return 1
  fi

  if [[ -z "${VARLOCK_PROXY_SESSION}" ]]; then
    VARLOCK_PROXY_SESSION="$(find_varlock_session_for_workspace)"
  fi
  if [[ -z "${VARLOCK_PROXY_SESSION}" ]]; then
    progress "Starting varlock credential proxy for this workspace"
    start_varlock_proxy_daemon
    if ! wait_for_varlock_session; then
      echo "initialize.sh: could not start a varlock proxy session; falling back to plaintext secret files. Check $(dirname "${SECRET_ENV_DIR}")/varlock-proxy-start.log" >&2
      remove_varlock_proxy_files
      return 1
    fi
  fi

  if ! wiring="$(varlock_proxy_env --format shell)"; then
    remove_varlock_proxy_files
    return 1
  fi

  # The session's own wiring is loopback-relative. Extract the port and the
  # host-side CA bundle directory, then re-request the env repointed for the
  # container: proxy vars at host.docker.internal, CA vars at the mounted dir.
  proxy_url="$(printf '%s\n' "${wiring}" | sed -n "s/^export HTTPS_PROXY=['\"]\{0,1\}\([^'\"]*\).*/\1/p" | head -n 1)"
  proxy_url="${proxy_url%/}"
  proxy_port="${proxy_url##*:}"
  host_ca_path="$(printf '%s\n' "${wiring}" | sed -n "s/^export SSL_CERT_FILE=['\"]\{0,1\}\([^'\"]*\).*/\1/p" | head -n 1)"
  if [[ -z "${proxy_port}" || -z "${host_ca_path}" || ! -r "${host_ca_path}" ]]; then
    echo "initialize.sh: varlock proxy session found but its wiring env was incomplete; falling back to plaintext secret files." >&2
    remove_varlock_proxy_files
    return 1
  fi
  host_ca_dir="$(dirname "${host_ca_path}")"
  if [[ ! -r "${host_ca_dir}/ca-cert.pem" || ! -r "${host_ca_dir}/combined-ca.pem" ]]; then
    echo "initialize.sh: varlock proxy CA bundle is missing from ${host_ca_dir}; falling back to plaintext secret files." >&2
    remove_varlock_proxy_files
    return 1
  fi

  if ! guest_env="$(varlock_proxy_env \
    --proxy-url "http://${VARLOCK_GUEST_PROXY_HOST}:${proxy_port}" \
    --cert-dir "${VARLOCK_CONTAINER_CA_DIR}" \
    --format shell)"; then
    remove_varlock_proxy_files
    return 1
  fi

  guest_ca_dir="${SECRET_ENV_DIR}/varlock-ca"
  mkdir -p "${guest_ca_dir}"
  chmod 0700 "${guest_ca_dir}"
  cp "${host_ca_dir}/ca-cert.pem" "${host_ca_dir}/combined-ca.pem" "${guest_ca_dir}/"
  chmod 0600 "${guest_ca_dir}/ca-cert.pem" "${guest_ca_dir}/combined-ca.pem"

  temporary_path="$(mktemp "${SECRET_ENV_DIR}/.varlock.env.XXXXXX")"
  printf '%s\n' "${guest_env}" > "${temporary_path}"
  chmod 0600 "${temporary_path}"
  mv -f "${temporary_path}" "${SECRET_ENV_DIR}/varlock.env"
}

refresh_runtime_secret_environment() {
  if ! prepare_secret_env_dir; then
    return 0
  fi

  if refresh_varlock_proxy_environment; then
    progress "Varlock proxy session detected; container gets placeholders only"
    rm -f "${SECRET_ENV_DIR}/ANTHROPIC_API_KEY" \
      "${SECRET_ENV_DIR}/SNYK_TOKEN" \
      "${SECRET_ENV_DIR}/OP_SERVICE_ACCOUNT_TOKEN"
    return 0
  fi

  if [[ "${BOXDOWN_AGENT_PROFILE:-auth}" == "none" ]]; then
    rm -f "${SECRET_ENV_DIR}/ANTHROPIC_API_KEY"
  else
    refresh_host_environment_secret "ANTHROPIC_API_KEY"
  fi
  refresh_host_environment_secret "SNYK_TOKEN"
  refresh_1password_service_account_token
}

main "$@"
