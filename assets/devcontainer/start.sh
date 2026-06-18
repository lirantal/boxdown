#!/usr/bin/env bash
#
# @file start.sh
# @summary Start the Dev Container for this workspace and attach an interactive shell or SSH proxy.
#
# Uses @devcontainers/cli to run `devcontainer up` then either `devcontainer exec bash`
# or a portless SSH ProxyCommand backed by `docker exec ... sshd -i`.
# Host port publishing comes from **runArgs** in devcontainer.json (e.g. `-p` and
# `127.0.0.1::<containerPort>` for dynamic host binding). After `devcontainer up`, this
# script reads that container port from runArgs and prints the mapped URL via `docker port`
# in shell mode.
#
# @usage
#   .devcontainer/start.sh [options]
#
# @options
#   --shell     Start the dev container and attach an interactive shell (default).
#   --ssh-proxy Start/reuse the dev container and proxy SSH over docker exec.
#   --install-ssh-config
#               Install/update the host SSH config alias and exit.
#   --refresh-gh-token
#               Start/reuse the dev container, then refresh container GitHub CLI
#               auth from the host gh token when available.
#   --refresh-gh-token-running
#               Refresh container GitHub CLI auth from the host gh token, but only
#               when the dev container is already running.
#   --recreate  Remove the existing dev container for this workspace before `up`, so
#               changes to runArgs (or other create-time settings) take effect.
#   --help, -h  Print usage and exit.
#
# @example
#   .devcontainer/start.sh
#   .devcontainer/start.sh --install-ssh-config
#   .devcontainer/start.sh --ssh-proxy
#   .devcontainer/start.sh --refresh-gh-token
#   .devcontainer/start.sh --refresh-gh-token-running
#   .devcontainer/start.sh --recreate
#

set -euo pipefail

# GUI apps launched outside an interactive shell often do not inherit the user's
# shell PATH. Include the common macOS/Linux locations needed by Docker and Node.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_FOLDER="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_NAME="$(basename "$WORKSPACE_FOLDER")"
CLI_VERSION="0.84.1"
SSH_KEY_DIR="${DEVCONTAINER_SSH_KEY_DIR:-${SCRIPT_DIR}/.ssh}"
SSH_KEY_PATH="${DEVCONTAINER_SSH_KEY_PATH:-${SSH_KEY_DIR}/id_ed25519}"
MODE="shell"
RECREATE=false
CONTAINER_ID=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Start the dev container for:
  $WORKSPACE_FOLDER

By default, open an interactive bash session inside the container.

Options:
  --shell       Start the dev container and open an interactive shell (default).
  --ssh-proxy  Start/reuse the dev container and proxy SSH over docker exec.
                Intended for SSH ProxyCommand; stdout is reserved for SSH traffic.
  --install-ssh-config
                Install/update the host SSH config alias and exit.
  --refresh-gh-token
                Start/reuse the dev container, then refresh container GitHub CLI
                auth from the host gh token when available.
  --refresh-gh-token-running
                Refresh container GitHub CLI auth from the host gh token, but only
                when the dev container is already running.
  --recreate    Remove the existing dev container for this workspace before starting,
                so Docker picks up new settings (e.g. runArgs / port mappings).
  --help, -h    Show this help and exit.

Notes:
  Port publishing uses runArgs (Docker -p ...::<containerPort>). The script greps that
  container port from devcontainer.json for the post-up URL hint.

  The --ssh-proxy mode uses a repo-local identity at:
    $SSH_KEY_PATH

  The GitHub token refresh modes never start a host gh login flow. If host gh is
  missing, logged out, or cannot provide a token, refresh is skipped.
EOF
}

log() {
  if [ "$MODE" = "ssh-proxy" ]; then
    printf '%s\n' "$*" >&2
  else
    printf '%s\n' "$*"
  fi
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

devcontainer_cli() {
  local npm_prefix
  local cli_bin
  local version_file

  npm_prefix="${DEVCONTAINER_CLI_NPM_PREFIX:-${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}/devcontainer-cli-npm-prefix}"
  cli_bin="${npm_prefix}/node_modules/.bin/devcontainer"
  version_file="${npm_prefix}/.devcontainer-cli-version"

  mkdir -p "$npm_prefix"

  if [ ! -x "$cli_bin" ] || [ "$(cat "$version_file" 2>/dev/null || true)" != "$CLI_VERSION" ]; then
    npm --prefix "$npm_prefix" install \
      --no-audit \
      --no-fund \
      --no-save \
      --package-lock=false \
      "@devcontainers/cli@${CLI_VERSION}" >/dev/null

    printf '%s\n' "$CLI_VERSION" > "$version_file"
  fi

  "$cli_bin" "$@"
}

# Container-side TCP port published via runArgs, e.g. "127.0.0.1::3000" (Docker -p host::ctr).
publish_container_port_from_devcontainer_json() {
  local f="$SCRIPT_DIR/devcontainer.json"
  if [ ! -r "$f" ]; then
    return 1
  fi
  sed 's|//.*||' "$f" | sed -nE 's/.*"[0-9.]+::([0-9]+)".*/\1/p' | sed -n '1p'
}

parse_container_id_from_up_output() {
  sed -nE 's/.*"containerId"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | sed -n '1p'
}

find_running_container_id() {
  docker ps --filter "label=devcontainer.local_folder=${WORKSPACE_FOLDER}" --format '{{.ID}}' | sed -n '1p'
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

install_ssh_config_alias() {
  if [ ! -r "${SCRIPT_DIR}/ssh-config-install.sh" ]; then
    die "Missing SSH config installer: ${SCRIPT_DIR}/ssh-config-install.sh"
  fi

  DEVCONTAINER_SSH_HOST_ALIAS="${DEVCONTAINER_SSH_HOST_ALIAS:-${REPO_NAME}-devcontainer}" \
    bash "${SCRIPT_DIR}/ssh-config-install.sh" "$@"
}

start_devcontainer() {
  local up_output
  local up_args

  if [ "$MODE" = "ssh-proxy" ] && [ "$RECREATE" = false ]; then
    CONTAINER_ID="$(find_running_container_id)"
    if [ -n "$CONTAINER_ID" ]; then
      log "Using running devcontainer for: $WORKSPACE_FOLDER"
      return 0
    fi
  fi

  log "Starting devcontainer for: $WORKSPACE_FOLDER"

  up_args=(--workspace-folder "$WORKSPACE_FOLDER")
  if [ "$RECREATE" = true ]; then
    up_args+=(--remove-existing-container)
    log "Removing existing dev container so create-time settings (e.g. runArgs) apply."
  fi

  if [ "$MODE" = "ssh-proxy" ]; then
    if ! up_output="$(devcontainer_cli up "${up_args[@]}" </dev/null 2>&1)"; then
      [ -z "$up_output" ] || log "$up_output"
      return 1
    fi
  elif ! up_output="$(devcontainer_cli up "${up_args[@]}" 2>&1)"; then
    [ -z "$up_output" ] || log "$up_output"
    return 1
  fi

  log "$up_output"

  CONTAINER_ID="$(printf '%s\n' "$up_output" | parse_container_id_from_up_output)"
  if [ -z "$CONTAINER_ID" ]; then
    CONTAINER_ID="$(find_running_container_id)"
  fi

  if [ -z "$CONTAINER_ID" ]; then
    die "Could not resolve devcontainer ID for: $WORKSPACE_FOLDER"
  fi
}

host_gh_token_or_empty() {
  local token

  if ! command -v gh >/dev/null 2>&1; then
    return 0
  fi

  if ! token="$(gh auth token 2>/dev/null)"; then
    return 0
  fi

  if [ -z "$token" ]; then
    return 0
  fi

  printf '%s\n' "$token"
}

refresh_container_gh_auth() {
  local token

  token="$(host_gh_token_or_empty)"
  if [ -z "$token" ]; then
    return 0
  fi

  if ! printf '%s\n' "$token" | devcontainer_cli exec \
    --workspace-folder "$WORKSPACE_FOLDER" \
    -- gh auth login --hostname github.com --git-protocol https --with-token --insecure-storage >/dev/null 2>&1; then
    log "Warning: could not refresh GitHub CLI auth inside the devcontainer."
    return 0
  fi

  devcontainer_cli exec \
    --workspace-folder "$WORKSPACE_FOLDER" \
    -- bash -lc 'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git config --local credential.https://github.com.helper "!gh auth git-credential"; fi' >/dev/null 2>&1 || true

  if devcontainer_cli exec \
    --workspace-folder "$WORKSPACE_FOLDER" \
    -- gh auth status --hostname github.com >/dev/null 2>&1; then
    log "GitHub CLI auth refreshed inside the devcontainer."
  else
    log "Warning: GitHub CLI auth refresh completed, but verification failed."
  fi
}

run_refresh_gh_token() {
  start_devcontainer
  refresh_container_gh_auth
}

run_refresh_gh_token_running() {
  CONTAINER_ID="$(find_running_container_id)"
  if [ -z "$CONTAINER_ID" ]; then
    die "No running devcontainer found for: $WORKSPACE_FOLDER"
  fi

  refresh_container_gh_auth
}

print_port_hint() {
  local container_port
  local host_binding

  container_port="$(publish_container_port_from_devcontainer_json || true)"
  if [ -z "$container_port" ]; then
    echo "Warning: could not find a runArgs publish port (expected a quoted string like \"127.0.0.1::<port>\")." >&2
    echo "         Skipping docker port URL hint." >&2
    return 0
  fi

  host_binding="$(docker port "$CONTAINER_ID" "${container_port}/tcp" 2>/dev/null | sed -n '1p')" || true
  if [ -n "$host_binding" ]; then
    printf '\nDev server available at: http://%s\n\n' "$host_binding"
  else
    echo "Warning: container is running but port ${container_port}/tcp is not mapped." >&2
  fi
}

open_shell() {
  echo "Dropping into container shell..."
  # Resolve TERM to something the container's terminfo knows about.
  # Terminals like kitty, ghostty, alacritty set custom TERM values the container won't have.
  # Fall back to xterm-256color (truecolor still works via COLORTERM=truecolor).
  if ! infocmp "${TERM:-xterm-256color}" &>/dev/null 2>&1; then
    TERM=xterm-256color
  fi
  TERM="${TERM:-xterm-256color}" devcontainer_cli exec --workspace-folder "$WORKSPACE_FOLDER" -- env TERM="${TERM:-xterm-256color}" COLORTERM=truecolor bash
}

ensure_container_sshd_runtime() {
  devcontainer_cli exec --workspace-folder "$WORKSPACE_FOLDER" -- bash .devcontainer/utils/ssh-bootstrap.sh runtime </dev/null >&2
}

run_ssh_proxy() {
  install_ssh_config_alias --quiet >&2
  ensure_host_ssh_key
  start_devcontainer
  ensure_container_sshd_runtime

  exec docker exec -i "$CONTAINER_ID" /usr/sbin/sshd -i \
    -o LogLevel=QUIET \
    -o PubkeyAuthentication=yes \
    -o PasswordAuthentication=no \
    -o KbdInteractiveAuthentication=no \
    -o AllowTcpForwarding=yes \
    -o AllowStreamLocalForwarding=yes \
    -o PermitTTY=yes
}

run_shell() {
  start_devcontainer
  print_port_hint
  open_shell
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help | -h)
      usage
      exit 0
      ;;
    --shell)
      MODE="shell"
      shift
      ;;
    --ssh-proxy)
      MODE="ssh-proxy"
      shift
      ;;
    --install-ssh-config)
      MODE="install-ssh-config"
      shift
      ;;
    --refresh-gh-token)
      MODE="refresh-gh-token"
      shift
      ;;
    --refresh-gh-token-running)
      MODE="refresh-gh-token-running"
      shift
      ;;
    --recreate)
      RECREATE=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

case "$MODE" in
  shell)
    run_shell
    ;;
  ssh-proxy)
    run_ssh_proxy
    ;;
  install-ssh-config)
    install_ssh_config_alias
    ;;
  refresh-gh-token)
    run_refresh_gh_token
    ;;
  refresh-gh-token-running)
    run_refresh_gh_token_running
    ;;
esac
