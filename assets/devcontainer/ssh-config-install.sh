#!/usr/bin/env bash
#
# Install/update a host SSH config alias for this repo's portless devcontainer SSH flow.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_FOLDER="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
REPO_NAME="$(basename "${WORKSPACE_FOLDER}")"
HOST_ALIAS="${DEVCONTAINER_SSH_HOST_ALIAS:-${REPO_NAME}-devcontainer}"
SSH_CONFIG="${DEVCONTAINER_SSH_CONFIG:-${HOME}/.ssh/config}"
SSH_KEY_DIR="${DEVCONTAINER_SSH_KEY_DIR:-${SCRIPT_DIR}/.ssh}"
SSH_KEY_PATH="${DEVCONTAINER_SSH_KEY_PATH:-${SSH_KEY_DIR}/id_ed25519}"
START_SCRIPT="${SCRIPT_DIR}/start.sh"
BEGIN_MARKER="# BEGIN ${HOST_ALIAS} devcontainer ssh"
END_MARKER="# END ${HOST_ALIAS} devcontainer ssh"
QUIET=false

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Install or update a host SSH config alias for this repo's devcontainer.

Options:
  --alias <name>       SSH host alias to write (default: ${HOST_ALIAS})
  --config <path>      SSH config file to update (default: ${SSH_CONFIG})
  --quiet              Only print errors.
  --help, -h           Show this help and exit.

Environment overrides:
  DEVCONTAINER_SSH_HOST_ALIAS
  DEVCONTAINER_SSH_CONFIG
  DEVCONTAINER_SSH_KEY_DIR
  DEVCONTAINER_SSH_KEY_PATH
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

log() {
  if [ "$QUIET" != true ]; then
    printf '%s\n' "$*"
  fi
}

ssh_config_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

ensure_host_ssh_key() {
  if ! command -v ssh-keygen >/dev/null 2>&1; then
    die "ssh-keygen is required for devcontainer SSH setup."
  fi

  mkdir -p "$SSH_KEY_DIR"
  chmod 0700 "$SSH_KEY_DIR"

  if [ ! -f "$SSH_KEY_PATH" ]; then
    log "Generating devcontainer SSH identity: $SSH_KEY_PATH"
    ssh-keygen -t ed25519 -f "$SSH_KEY_PATH" -N "" -C "${REPO_NAME}-devcontainer" >/dev/null
  fi

  if [ ! -f "${SSH_KEY_PATH}.pub" ]; then
    ssh-keygen -y -f "$SSH_KEY_PATH" > "${SSH_KEY_PATH}.pub"
  fi

  chmod 0600 "$SSH_KEY_PATH"
  chmod 0644 "${SSH_KEY_PATH}.pub"
}

write_ssh_config_block() {
  local ssh_dir
  local tmp_file
  local start_script_quoted
  local key_path_quoted
  local host_alias_quoted

  ssh_dir="$(dirname "$SSH_CONFIG")"
  mkdir -p "$ssh_dir"
  chmod 0700 "$ssh_dir"
  touch "$SSH_CONFIG"
  chmod 0600 "$SSH_CONFIG"

  tmp_file="$(mktemp)"
  awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$SSH_CONFIG" > "$tmp_file"

  start_script_quoted="$(ssh_config_quote "$START_SCRIPT")"
  key_path_quoted="$(ssh_config_quote "$SSH_KEY_PATH")"
  host_alias_quoted="$(ssh_config_quote "$HOST_ALIAS")"

  {
    sed -e '${/^$/d;}' "$tmp_file"
    printf '\n%s\n' "$BEGIN_MARKER"
    printf 'Host %s\n' "$HOST_ALIAS"
    printf '  HostName %s\n' "$HOST_ALIAS"
    printf '  User node\n'
    printf '  IdentityFile none\n'
    printf '  IdentityFile %s\n' "$key_path_quoted"
    printf '  IdentitiesOnly yes\n'
    printf '  ProxyCommand env DEVCONTAINER_SSH_HOST_ALIAS=%s /bin/bash %s --ssh-proxy\n' "$host_alias_quoted" "$start_script_quoted"
    printf '  StrictHostKeyChecking no\n'
    printf '  UserKnownHostsFile /dev/null\n'
    printf '  LogLevel ERROR\n'
    printf '%s\n' "$END_MARKER"
  } > "${tmp_file}.next"

  if cmp -s "$SSH_CONFIG" "${tmp_file}.next"; then
    log "SSH alias already up to date: ${HOST_ALIAS}"
    rm -f "${tmp_file}.next"
  else
    mv "${tmp_file}.next" "$SSH_CONFIG"
    log "Installed SSH alias: ${HOST_ALIAS}"
  fi

  rm -f "$tmp_file"
  chmod 0600 "$SSH_CONFIG"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help | -h)
      usage
      exit 0
      ;;
    --alias)
      [ $# -ge 2 ] || die "--alias requires a value."
      HOST_ALIAS="$2"
      BEGIN_MARKER="# BEGIN ${HOST_ALIAS} devcontainer ssh"
      END_MARKER="# END ${HOST_ALIAS} devcontainer ssh"
      shift 2
      ;;
    --config)
      [ $# -ge 2 ] || die "--config requires a value."
      SSH_CONFIG="$2"
      shift 2
      ;;
    --quiet)
      QUIET=true
      shift
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

ensure_host_ssh_key
write_ssh_config_block

if [ "$QUIET" != true ]; then
  cat <<EOF
SSH config: ${SSH_CONFIG}
Identity file: ${SSH_KEY_PATH}

Validate with:
  ssh ${HOST_ALIAS} 'whoami && pwd'

Use this host alias in Cursor, Claude, or any other SSH client:
  ${HOST_ALIAS}
EOF
fi
