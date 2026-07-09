#!/usr/bin/env bash
#
# @file start.sh
# @summary Start the Dev Container for this workspace and attach an interactive shell or SSH proxy.
#
# Uses Boxdown's packaged @devcontainers/cli to run `devcontainer up` then either
# `devcontainer exec bash` or a portless SSH ProxyCommand backed by
# `docker exec ... sshd -i`.
# Host port publishing comes from **runArgs** in devcontainer.json (e.g. `-p` and
# `127.0.0.1::<containerPort>` for dynamic host binding). After `devcontainer up`, this
# script reads that container port from runArgs and prints the mapped URL via `docker port`
# in shell mode.
#
# @usage
#   .devcontainer/start.sh [command] [options]
#
# @options
#   --shell     Start the dev container and attach an interactive shell (default).
#   --ssh-proxy Start/reuse the dev container and proxy SSH over docker exec.
#   ssh install
#               Install/update the host SSH config alias and exit.
#   --refresh-gh-token
#               Start/reuse the dev container, then refresh container GitHub CLI
#               auth from the host gh token when available.
#   --refresh-gh-token-running
#               Refresh container GitHub CLI auth from the host gh token, but only
#               when the dev container is already running.
#   --recreate  Remove the existing dev container for this workspace before `up`, so
#               changes to runArgs (or other create-time settings) take effect.
#   --verbose   Stream raw devcontainer, Docker, and hook output.
#   --help, -h  Print usage and exit.
#
# @example
#   .devcontainer/start.sh
#   .devcontainer/start.sh ssh install
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
SSH_KEY_DIR="${DEVCONTAINER_SSH_KEY_DIR:-${SCRIPT_DIR}/.ssh}"
SSH_KEY_PATH="${DEVCONTAINER_SSH_KEY_PATH:-${SSH_KEY_DIR}/id_ed25519}"
MODE="shell"
RECREATE=false
VERBOSE=false
CONTAINER_ID=""
PROGRESS_STEP_IDS=()
PROGRESS_STEP_LABELS=()
PROGRESS_STEP_STATES=()
PROGRESS_RENDERED_STEP_LINE_COUNT=0
PROGRESS_CHECKLIST_PID=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [command] [options]

Start the dev container for:
  $WORKSPACE_FOLDER

By default, open an interactive bash session inside the container.

Options:
  --shell       Start the dev container and open an interactive shell (default).
  --ssh-proxy  Start/reuse the dev container and proxy SSH over docker exec.
                Intended for SSH ProxyCommand; stdout is reserved for SSH traffic.
  --refresh-gh-token
                Start/reuse the dev container, then refresh container GitHub CLI
                auth from the host gh token when available.
  --refresh-gh-token-running
                Refresh container GitHub CLI auth from the host gh token, but only
                when the dev container is already running.
  --recreate    Remove the existing dev container for this workspace before starting,
                so Docker picks up new settings (e.g. runArgs / port mappings).
  --verbose     Stream raw devcontainer, Docker, and hook output.
  --help, -h    Show this help and exit.

Commands:
  ssh install
                Install/update the host SSH config alias and exit.

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

log_raw() {
  if [ "$MODE" = "ssh-proxy" ]; then
    printf '%b' "$*" >&2
  else
    printf '%b' "$*"
  fi
}

supports_progress_tty() {
  if [ "$MODE" = "ssh-proxy" ]; then
    [ -t 2 ]
  else
    [ -t 1 ]
  fi
}

style() {
  local code="$1"
  local text="$2"

  if supports_progress_tty; then
    printf '\033[%sm%s\033[0m' "$code" "$text"
  else
    printf '%s' "$text"
  fi
}

style_bold() { style 1 "$1"; }
style_cyan() { style 36 "$1"; }
style_dim() { style 2 "$1"; }
style_green() { style 32 "$1"; }
progress_rail() { style_cyan "│"; }

progress_section() {
  if [ "$VERBOSE" = true ]; then
    return 0
  fi

  log "$(style_cyan "◆")  $(style_bold "$*")"
}

progress_end() {
  if [ "$VERBOSE" = true ]; then
    return 0
  fi

  stop_spinner clear
  progress_stop_checklist_timer
  log "$(style_cyan "└")"
  PROGRESS_STEP_IDS=()
  PROGRESS_STEP_LABELS=()
  PROGRESS_STEP_STATES=()
  PROGRESS_RENDERED_STEP_LINE_COUNT=0
}

progress_item() {
  if [ "$VERBOSE" = true ]; then
    return 0
  fi

  log "$(progress_rail)  $(style_green "■") $*"
}

progress_running() {
  if [ "$VERBOSE" = true ]; then
    return 0
  fi

  log "$(progress_rail)  $(style_cyan "◒") $*"
}

progress_detail() {
  if [ "$VERBOSE" = true ]; then
    return 0
  fi

  log "$(progress_rail)  $(style_dim "$*")"
}

progress_warn() {
  if [ "$VERBOSE" = true ]; then
    return 0
  fi

  log "$(progress_rail)  $(style_dim "!") $*"
}

progress_has_steps() {
  [ "${#PROGRESS_STEP_IDS[@]}" -gt 0 ]
}

progress_step_index() {
  local id="$1"
  local index

  for index in "${!PROGRESS_STEP_IDS[@]}"; do
    if [ "${PROGRESS_STEP_IDS[$index]}" = "$id" ]; then
      printf '%s\n' "$index"
      return 0
    fi
  done

  return 1
}

progress_has_step() {
  progress_step_index "$1" >/dev/null 2>&1
}

progress_set_steps() {
  local step
  local id
  local label

  if [ "$VERBOSE" = true ]; then
    return 0
  fi

  progress_stop_checklist_timer
  PROGRESS_STEP_IDS=()
  PROGRESS_STEP_LABELS=()
  PROGRESS_STEP_STATES=()
  PROGRESS_RENDERED_STEP_LINE_COUNT=0

  for step in "$@"; do
    id="${step%%:*}"
    label="${step#*:}"
    PROGRESS_STEP_IDS+=("$id")
    PROGRESS_STEP_LABELS+=("$label")
    PROGRESS_STEP_STATES+=("pending")
  done

  progress_render_checklist
}

progress_step_mark() {
  local state="$1"
  local frame="$2"

  case "$state" in
    running)
      style_cyan "$frame"
      ;;
    complete)
      style_green "✔"
      ;;
    failed)
      style_dim "!"
      ;;
    *)
      style_dim "□"
      ;;
  esac
}

progress_step_line() {
  local index="$1"
  local frame="$2"
  local state="${PROGRESS_STEP_STATES[$index]}"
  local label="${PROGRESS_STEP_LABELS[$index]}"

  if [ "$state" = "skipped" ]; then
    label="$(style_dim "$label")"
  fi

  printf '%s  %s %s' "$(progress_rail)" "$(progress_step_mark "$state" "$frame")" "$label"
}

progress_render_checklist_frame() {
  local frame="$1"
  local index

  if [ "$VERBOSE" = true ] || ! progress_has_steps; then
    return 0
  fi

  if supports_progress_tty; then
    if [ "$PROGRESS_RENDERED_STEP_LINE_COUNT" -gt 0 ]; then
      log_raw "\033[${PROGRESS_RENDERED_STEP_LINE_COUNT}A"
    fi

    for index in "${!PROGRESS_STEP_IDS[@]}"; do
      log_raw "\033[2K\r$(progress_step_line "$index" "$frame")\n"
    done

    PROGRESS_RENDERED_STEP_LINE_COUNT="${#PROGRESS_STEP_IDS[@]}"
    return 0
  fi

  if [ "$PROGRESS_RENDERED_STEP_LINE_COUNT" -eq 0 ]; then
    for index in "${!PROGRESS_STEP_IDS[@]}"; do
      log "$(progress_step_line "$index" "$frame")"
    done
    PROGRESS_RENDERED_STEP_LINE_COUNT="${#PROGRESS_STEP_IDS[@]}"
  fi
}

progress_render_checklist() {
  progress_render_checklist_frame "◐"
}

progress_update_step() {
  local id="$1"
  local state="$2"
  local index

  index="$(progress_step_index "$id")" || return 0
  PROGRESS_STEP_STATES[$index]="$state"
  progress_render_checklist
}

progress_start_step() {
  progress_update_step "$1" "running"
  progress_start_checklist_timer
}

progress_complete_step() {
  progress_stop_checklist_timer
  progress_update_step "$1" "complete"
}

progress_fail_step() {
  progress_stop_checklist_timer
  progress_update_step "$1" "failed"
}

progress_skip_step() {
  progress_stop_checklist_timer
  progress_update_step "$1" "skipped"
}

progress_any_running_step() {
  local state

  for state in "${PROGRESS_STEP_STATES[@]}"; do
    if [ "$state" = "running" ]; then
      return 0
    fi
  done

  return 1
}

progress_start_checklist_timer() {
  if [ "$VERBOSE" = true ] || ! supports_progress_tty || [ -n "$PROGRESS_CHECKLIST_PID" ]; then
    return 0
  fi

  if ! progress_any_running_step; then
    return 0
  fi

  (
    frames=("◒" "◐" "◓" "◑")
    index=0
    while true; do
      progress_render_checklist_frame "${frames[$index]}"
      index=$(( (index + 1) % ${#frames[@]} ))
      sleep 0.12
    done
  ) &
  PROGRESS_CHECKLIST_PID="$!"
}

progress_stop_checklist_timer() {
  if [ -z "$PROGRESS_CHECKLIST_PID" ]; then
    return 0
  fi

  kill "$PROGRESS_CHECKLIST_PID" >/dev/null 2>&1 || true
  wait "$PROGRESS_CHECKLIST_PID" 2>/dev/null || true
  PROGRESS_CHECKLIST_PID=""
}

SPINNER_PID=""
SPINNER_LABEL=""
SPINNER_TTY=false

start_spinner() {
  local label="$*"

  if [ "$VERBOSE" = true ]; then
    return 0
  fi

  stop_spinner clear
  SPINNER_LABEL="$label"

  if ! supports_progress_tty; then
    SPINNER_TTY=false
    progress_running "$label"
    return 0
  fi

  SPINNER_TTY=true
  (
    frames=("◒" "◐" "◓" "◑")
    index=0
    while true; do
      log_raw "\r\033[2K$(progress_rail)  $(style_cyan "${frames[$index]}") ${label}"
      index=$(( (index + 1) % ${#frames[@]} ))
      sleep 0.12
    done
  ) &
  SPINNER_PID="$!"
}

stop_spinner() {
  local status="${1:-clear}"
  local label="$SPINNER_LABEL"

  if [ -n "$SPINNER_PID" ]; then
    kill "$SPINNER_PID" >/dev/null 2>&1 || true
    wait "$SPINNER_PID" 2>/dev/null || true
  fi

  if [ "$SPINNER_TTY" = true ]; then
    log_raw "\r\033[2K"
  fi

  SPINNER_PID=""
  SPINNER_LABEL=""
  SPINNER_TTY=false

  if [ "$status" = "complete" ] && [ -n "$label" ]; then
    progress_item "$label"
  fi
}

trap 'stop_spinner clear; progress_stop_checklist_timer' EXIT

export_progress_env() {
  if [ "$VERBOSE" = true ]; then
    export BOXDOWN_VERBOSE=1
    export BOXDOWN_PROGRESS=0
  else
    export BOXDOWN_VERBOSE=0
    export BOXDOWN_PROGRESS=1
  fi
}

print_progress_markers() {
  local output="$1"
  local line

  if progress_has_steps; then
    return 0
  fi

  while IFS= read -r line; do
    case "$line" in
      BOXDOWN_PROGRESS:*)
        progress_item "${line#BOXDOWN_PROGRESS: }"
        ;;
    esac
  done <<< "$output"
}

print_command_failure() {
  local label="$1"
  local code="$2"
  local output="$3"
  local filtered

  progress_warn "${label} failed with exit code ${code}."
  log "$(progress_rail)  $(style_dim "Rerun with --verbose to see full command output.")"

  filtered="$(printf '%s\n' "$output" | sed '/^[[:space:]]*BOXDOWN_PROGRESS:/d' | sed '/^[[:space:]]*$/d' | tail -n 20)"
  if [ -n "$filtered" ]; then
    log "$(progress_rail)  $(style_dim "output tail:")"
    while IFS= read -r line; do
      progress_detail "$line"
    done <<< "$filtered"
  fi
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

devcontainer_cli() {
  local cli_bin
  local package_root

  package_root="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
  cli_bin="$(
    PACKAGE_ROOT="$package_root" node -e '
      const { existsSync, readFileSync } = require("node:fs");
      const { createRequire } = require("node:module");
      const { dirname, resolve } = require("node:path");

      const packageRoot = process.env.PACKAGE_ROOT;
      const requireFromBoxdown = createRequire(`${packageRoot}/package.json`);
      const packageJsonPath = requireFromBoxdown.resolve("@devcontainers/cli/package.json");
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.devcontainer;

      if (!bin) process.exit(1);

      const cliPath = resolve(dirname(packageJsonPath), bin);
      if (!existsSync(cliPath)) process.exit(1);

      process.stdout.write(cliPath);
    '
  )" || die "Boxdown's packaged @devcontainers/cli dependency is missing. Reinstall boxdown."

  node "$cli_bin" "$@"
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
    if [ "$VERBOSE" = true ]; then
      log "Generating devcontainer SSH identity: $SSH_KEY_PATH"
      ssh-keygen -t ed25519 -f "$SSH_KEY_PATH" -N "" -C "${REPO_NAME}-devcontainer" >/dev/null
    elif progress_has_step "ssh-identity"; then
      ssh-keygen -t ed25519 -f "$SSH_KEY_PATH" -N "" -C "${REPO_NAME}-devcontainer" >/dev/null 2>&1 || return $?
    else
      progress_detail "$SSH_KEY_PATH"
      start_spinner "Generating devcontainer SSH identity"
      if ssh-keygen -t ed25519 -f "$SSH_KEY_PATH" -N "" -C "${REPO_NAME}-devcontainer" >/dev/null 2>&1; then
        stop_spinner complete
      else
        code=$?
        stop_spinner clear
        return "$code"
      fi
    fi
  fi

  if [ ! -f "${SSH_KEY_PATH}.pub" ]; then
    if [ "$VERBOSE" = true ]; then
      ssh-keygen -y -f "$SSH_KEY_PATH" > "${SSH_KEY_PATH}.pub"
    elif progress_has_step "ssh-identity"; then
      ssh-keygen -y -f "$SSH_KEY_PATH" > "${SSH_KEY_PATH}.pub" 2>/dev/null || return $?
    else
      ssh-keygen -y -f "$SSH_KEY_PATH" > "${SSH_KEY_PATH}.pub"
    fi
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
  local up_code

  if [ "$MODE" = "ssh-proxy" ] && [ "$RECREATE" = false ]; then
    CONTAINER_ID="$(find_running_container_id)"
    if [ -n "$CONTAINER_ID" ]; then
      if [ "$VERBOSE" = true ]; then
        log "Using running devcontainer for: $WORKSPACE_FOLDER"
      elif progress_has_step "devcontainer-start"; then
        progress_start_step "devcontainer-start"
        progress_complete_step "devcontainer-start"
      else
        progress_item "Using running devcontainer"
        progress_detail "$CONTAINER_ID"
      fi
      return 0
    fi
  fi

  if [ "$VERBOSE" = true ]; then
    log "Starting devcontainer for: $WORKSPACE_FOLDER"
  elif progress_has_step "devcontainer-start"; then
    progress_start_step "devcontainer-start"
  else
    start_spinner "Starting devcontainer"
  fi

  up_args=(--workspace-folder "$WORKSPACE_FOLDER")
  if [ "$RECREATE" = true ]; then
    up_args+=(--remove-existing-container)
    if [ "$VERBOSE" = true ]; then
      log "Removing existing dev container so create-time settings (e.g. runArgs) apply."
    elif progress_has_step "devcontainer-start"; then
      :
    else
      stop_spinner clear
      progress_item "Removing existing devcontainer before start"
      start_spinner "Starting devcontainer"
    fi
  fi

  export_progress_env

  if [ "$MODE" = "ssh-proxy" ]; then
    if up_output="$(devcontainer_cli up "${up_args[@]}" </dev/null 2>&1)"; then
      :
    else
      up_code=$?
      if [ "$VERBOSE" = true ]; then
        [ -z "$up_output" ] || log "$up_output"
      else
        if progress_has_step "devcontainer-start"; then
          progress_fail_step "devcontainer-start"
        else
          stop_spinner clear
        fi
        print_progress_markers "$up_output"
        print_command_failure "devcontainer up" "$up_code" "$up_output"
      fi
      return "$up_code"
    fi
  elif up_output="$(devcontainer_cli up "${up_args[@]}" 2>&1)"; then
    :
  else
    up_code=$?
    if [ "$VERBOSE" = true ]; then
      [ -z "$up_output" ] || log "$up_output"
    else
      if progress_has_step "devcontainer-start"; then
        progress_fail_step "devcontainer-start"
      else
        stop_spinner clear
      fi
      print_progress_markers "$up_output"
      print_command_failure "devcontainer up" "$up_code" "$up_output"
    fi
    return "$up_code"
  fi

  if [ "$VERBOSE" = true ]; then
    log "$up_output"
  elif progress_has_step "devcontainer-start"; then
    print_progress_markers "$up_output"
    progress_complete_step "devcontainer-start"
  else
    stop_spinner clear
    print_progress_markers "$up_output"
    progress_item "Starting devcontainer"
  fi

  CONTAINER_ID="$(printf '%s\n' "$up_output" | parse_container_id_from_up_output)"
  if [ -z "$CONTAINER_ID" ]; then
    CONTAINER_ID="$(find_running_container_id)"
  fi

  if [ -z "$CONTAINER_ID" ]; then
    if progress_has_step "devcontainer-start"; then
      progress_fail_step "devcontainer-start"
    fi
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

  if progress_has_step "gh-token-read"; then
    progress_start_step "gh-token-read"
  fi

  token="$(host_gh_token_or_empty)"
  if progress_has_step "gh-token-read"; then
    progress_complete_step "gh-token-read"
  fi

  if [ -z "$token" ]; then
    progress_skip_step "gh-auth-refresh"
    progress_skip_step "gh-git-auth"
    progress_skip_step "gh-auth-verify"
    if [ "$VERBOSE" = false ]; then
      progress_warn "Host GitHub CLI token unavailable; skipping container auth refresh."
    fi
    return 0
  fi

  if [ "$VERBOSE" = true ]; then
    if ! printf '%s\n' "$token" | devcontainer_cli exec \
      --workspace-folder "$WORKSPACE_FOLDER" \
      -- gh auth login --hostname github.com --git-protocol https --with-token --insecure-storage >/dev/null 2>&1; then
      log "Warning: could not refresh GitHub CLI auth inside the devcontainer."
      return 0
    fi
  else
    if progress_has_step "gh-auth-refresh"; then
      progress_start_step "gh-auth-refresh"
    else
      start_spinner "Refreshing GitHub CLI auth inside the devcontainer"
    fi

    if printf '%s\n' "$token" | devcontainer_cli exec \
      --workspace-folder "$WORKSPACE_FOLDER" \
      -- gh auth login --hostname github.com --git-protocol https --with-token --insecure-storage >/dev/null 2>&1; then
      if progress_has_step "gh-auth-refresh"; then
        progress_complete_step "gh-auth-refresh"
      else
        stop_spinner complete
      fi
    else
      if progress_has_step "gh-auth-refresh"; then
        progress_fail_step "gh-auth-refresh"
      else
        stop_spinner clear
      fi
      progress_skip_step "gh-git-auth"
      progress_skip_step "gh-auth-verify"
      progress_warn "Could not refresh GitHub CLI auth inside the devcontainer."
      return 0
    fi
  fi

  if progress_has_step "gh-git-auth"; then
    progress_start_step "gh-git-auth"
  else
    progress_item "Configuring workspace GitHub Git auth"
  fi

  if ! configure_container_github_git_auth; then
    progress_fail_step "gh-git-auth"
    if [ "$VERBOSE" = true ]; then
      log "Warning: GitHub CLI auth refreshed, but GitHub Git auth was not configured for this workspace."
    else
      progress_warn "GitHub CLI auth refreshed, but GitHub Git auth was not configured for this workspace."
    fi
  elif progress_has_step "gh-git-auth"; then
    progress_complete_step "gh-git-auth"
  fi

  if [ "$VERBOSE" = true ]; then
    if devcontainer_cli exec \
      --workspace-folder "$WORKSPACE_FOLDER" \
      -- gh auth status --hostname github.com >/dev/null 2>&1; then
      log "GitHub CLI auth refreshed inside the devcontainer."
    else
      log "Warning: GitHub CLI auth refresh completed, but verification failed."
    fi
  else
    if progress_has_step "gh-auth-verify"; then
      progress_start_step "gh-auth-verify"
    else
      start_spinner "Verifying GitHub CLI auth inside the devcontainer"
    fi

    if devcontainer_cli exec \
      --workspace-folder "$WORKSPACE_FOLDER" \
      -- gh auth status --hostname github.com >/dev/null 2>&1; then
      if progress_has_step "gh-auth-verify"; then
        progress_complete_step "gh-auth-verify"
      else
        stop_spinner complete
        progress_item "GitHub CLI auth refreshed inside the devcontainer"
      fi
    else
      if progress_has_step "gh-auth-verify"; then
        progress_fail_step "gh-auth-verify"
      else
        stop_spinner clear
      fi
      progress_warn "GitHub CLI auth refresh completed, but verification failed."
    fi
  fi
}

configure_container_github_git_auth() {
  devcontainer_cli exec \
    --workspace-folder "$WORKSPACE_FOLDER" \
    -- bash -s >/dev/null 2>&1 <<'EOF'
set -euo pipefail

canonical_github_remote_url() {
  local remote_url="$1"
  local owner repo rest

  case "$remote_url" in
    git@github.com:*)
      rest="${remote_url#git@github.com:}"
      owner="${rest%%/*}"
      repo="${rest#*/}"
      ;;
    ssh://git@github.com/*)
      rest="${remote_url#ssh://git@github.com/}"
      owner="${rest%%/*}"
      repo="${rest#*/}"
      ;;
    https://github.com/*)
      rest="${remote_url#https://github.com/}"
      owner="${rest%%/*}"
      repo="${rest#*/}"
      ;;
    https://*@github.com/*)
      rest="${remote_url#https://*@github.com/}"
      owner="${rest%%/*}"
      repo="${rest#*/}"
      ;;
    *)
      return 1
      ;;
  esac

  repo="${repo%/}"
  repo="${repo%.git}"

  if [ -z "$owner" ] || [ -z "$repo" ] || [ "$owner" = "$repo" ] || [[ "$repo" == */* ]]; then
    return 1
  fi

  printf 'https://github.com/%s/%s.git\n' "$owner" "$repo"
}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

remote_lines="$(git config --local --get-regexp '^remote\..*\.url$' || true)"
if [ -z "$remote_lines" ]; then
  exit 0
fi

configured_urls=()
while IFS= read -r line; do
  key="${line%% *}"
  raw_url="${line#* }"
  remote_name="${key#remote.}"
  remote_name="${remote_name%.url}"

  if canonical_url="$(canonical_github_remote_url "$raw_url")"; then
    git remote set-url "$remote_name" "$canonical_url"
    git remote set-url --push "$remote_name" "$canonical_url"
    configured_urls+=("$canonical_url")
  fi
done <<< "$remote_lines"

if [ "${#configured_urls[@]}" -eq 0 ]; then
  exit 0
fi

git config --local --unset-all credential.https://github.com.helper >/dev/null 2>&1 || true
git config --local --add credential.https://github.com.helper ''
git config --local --add credential.https://github.com.helper '!gh auth git-credential'

for canonical_url in "${configured_urls[@]}"; do
  git config --local --replace-all "url.${canonical_url}.insteadOf" "$canonical_url"
done
EOF
}

run_refresh_gh_token() {
  progress_section "Boxdown GitHub auth refresh"
  progress_detail "Workspace: $WORKSPACE_FOLDER"
  progress_set_steps \
    "devcontainer-start:Starting devcontainer" \
    "gh-token-read:Reading host GitHub CLI token" \
    "gh-auth-refresh:Refreshing GitHub CLI auth inside the devcontainer" \
    "gh-git-auth:Configuring workspace GitHub Git auth" \
    "gh-auth-verify:Verifying GitHub CLI auth inside the devcontainer"
  start_devcontainer || {
    code=$?
    progress_end
    return "$code"
  }
  refresh_container_gh_auth || {
    code=$?
    progress_end
    return "$code"
  }
  progress_end
}

run_refresh_gh_token_running() {
  progress_section "Boxdown GitHub auth refresh"
  progress_detail "Workspace: $WORKSPACE_FOLDER"
  progress_set_steps \
    "devcontainer-running:Using running devcontainer" \
    "gh-token-read:Reading host GitHub CLI token" \
    "gh-auth-refresh:Refreshing GitHub CLI auth inside the devcontainer" \
    "gh-git-auth:Configuring workspace GitHub Git auth" \
    "gh-auth-verify:Verifying GitHub CLI auth inside the devcontainer"
  CONTAINER_ID="$(find_running_container_id)"
  if [ -z "$CONTAINER_ID" ]; then
    progress_fail_step "devcontainer-running"
    progress_end
    die "No running devcontainer found for: $WORKSPACE_FOLDER"
  fi

  progress_start_step "devcontainer-running"
  progress_complete_step "devcontainer-running"
  refresh_container_gh_auth || {
    code=$?
    progress_end
    return "$code"
  }
  progress_end
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
  TERM="${TERM:-xterm-256color}" devcontainer_cli exec --workspace-folder "$WORKSPACE_FOLDER" -- env TERM="${TERM:-xterm-256color}" COLORTERM=truecolor bash -c '
    if ! infocmp "${TERM:-xterm-256color}" >/dev/null 2>&1; then
      export TERM=xterm-256color
    fi
    export COLORTERM="${COLORTERM:-truecolor}"
    exec bash -i
  '
}

ensure_container_sshd_runtime() {
  local output
  local code
  local -a env_args

  if [ "$VERBOSE" = true ]; then
    env_args=(BOXDOWN_VERBOSE=1 BOXDOWN_PROGRESS=0)
  else
    env_args=(BOXDOWN_VERBOSE=0 BOXDOWN_PROGRESS=1)
  fi

  if [ "$VERBOSE" = true ]; then
    devcontainer_cli exec --workspace-folder "$WORKSPACE_FOLDER" -- env "${env_args[@]}" bash .devcontainer/utils/ssh-bootstrap.sh runtime </dev/null >&2
    return $?
  fi

  if progress_has_step "ssh-runtime"; then
    progress_start_step "ssh-runtime"
  else
    start_spinner "Preparing container SSH runtime"
  fi

  if output="$(devcontainer_cli exec --workspace-folder "$WORKSPACE_FOLDER" -- env "${env_args[@]}" bash .devcontainer/utils/ssh-bootstrap.sh runtime </dev/null 2>&1)"; then
    if progress_has_step "ssh-runtime"; then
      progress_complete_step "ssh-runtime"
    else
      stop_spinner clear
    fi
    print_progress_markers "$output"
    if ! progress_has_step "ssh-runtime"; then
      progress_item "Preparing container SSH runtime"
    fi
    return 0
  fi

  code=$?
  if progress_has_step "ssh-runtime"; then
    progress_fail_step "ssh-runtime"
  else
    stop_spinner clear
  fi
  print_progress_markers "$output"
  print_command_failure "prepare SSH runtime" "$code" "$output"
  return "$code"
}

run_ssh_proxy() {
  progress_section "Boxdown SSH proxy"
  progress_detail "Workspace: $WORKSPACE_FOLDER"
  progress_set_steps \
    "ssh-alias:Updating SSH alias" \
    "ssh-identity:Preparing SSH identity" \
    "devcontainer-start:Starting devcontainer" \
    "ssh-runtime:Preparing container SSH runtime"
  progress_start_step "ssh-alias"
  if install_ssh_config_alias --quiet >&2; then
    progress_complete_step "ssh-alias"
  else
    progress_fail_step "ssh-alias"
    progress_end
    return 1
  fi

  progress_start_step "ssh-identity"
  if ensure_host_ssh_key; then
    progress_complete_step "ssh-identity"
  else
    progress_fail_step "ssh-identity"
    progress_end
    return 1
  fi

  start_devcontainer || {
    code=$?
    progress_end
    return "$code"
  }
  ensure_container_sshd_runtime || {
    code=$?
    progress_end
    return "$code"
  }
  progress_end

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
  progress_section "Boxdown start"
  progress_detail "Workspace: $WORKSPACE_FOLDER"
  progress_set_steps \
    "devcontainer-start:Starting devcontainer"
  start_devcontainer || {
    code=$?
    progress_end
    return "$code"
  }
  progress_end
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
    ssh)
      MODE="ssh-config-install"
      if [ "${2:-}" = "install" ]; then
        shift 2
      elif [ "$#" -eq 1 ] || [ "${2#-}" != "$2" ]; then
        shift
      else
        die "Unknown command: ssh ${2}"
      fi
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
    --verbose)
      VERBOSE=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

if [ "$VERBOSE" = false ]; then
  if [ -n "${CI:-}" ] && [ "${CI:-}" != "0" ] && [ "${CI:-}" != "false" ]; then
    VERBOSE=true
  elif ! supports_progress_tty; then
    VERBOSE=true
  fi
fi

case "$MODE" in
  shell)
    run_shell
    ;;
  ssh-proxy)
    run_ssh_proxy
    ;;
  ssh-config-install)
    install_ssh_config_alias
    ;;
  refresh-gh-token)
    run_refresh_gh_token
    ;;
  refresh-gh-token-running)
    run_refresh_gh_token_running
    ;;
esac
