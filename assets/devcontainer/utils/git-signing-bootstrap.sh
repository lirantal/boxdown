#!/usr/bin/env bash
# Configure best-effort SSH commit signing without modifying the workspace Git config.

set -euo pipefail

TARGET_PATH="${BOXDOWN_GITCONFIG_TARGET_PATH:-/home/node/.gitconfig}"
KEY_PATH="${BOXDOWN_GIT_SIGNING_KEY_PATH:-/opt/boxdown/state/git-signing/signing-key.pub}"
ENABLED="${BOXDOWN_GIT_SIGNING_ENABLED:-0}"
HOST_REASON="${BOXDOWN_GIT_SIGNING_REASON:-host-preflight-unavailable}"

git_global() {
  GIT_CONFIG_GLOBAL="${TARGET_PATH}" git config --global "$@"
}

git_local_value() {
  git config --local --get "$1" 2>/dev/null || true
}

git_global_value() {
  git_global --get "$1" 2>/dev/null || true
}

preserve_user_signing_preference() {
  local local_commit global_commit local_format global_format local_program global_program
  local_commit="$(git_local_value commit.gpgsign)"
  global_commit="$(git_global_value commit.gpgsign)"
  local_format="$(git_local_value gpg.format)"
  global_format="$(git_global_value gpg.format)"
  local_program="$(git_local_value gpg.program)"
  global_program="$(git_global_value gpg.program)"

  [[ "${local_commit}" == "false" || "${global_commit}" == "false" ]] && return 0
  [[ -n "${local_program}" || -n "${global_program}" ]] && return 0
  [[ -n "${local_format}" && "${local_format}" != "ssh" ]] && return 0
  [[ -n "${global_format}" && "${global_format}" != "ssh" ]] && return 0
  return 1
}

disable_signing() {
  local reason="${1:-unknown}"
  if preserve_user_signing_preference; then
    printf 'boxdown: commit signing configuration preserved (reason: %s).\n' "${reason}" >&2
    return 0
  fi
  git_global --unset-all gpg.format >/dev/null 2>&1 || true
  git_global --unset-all user.signingkey >/dev/null 2>&1 || true
  git_global --unset-all gpg.program >/dev/null 2>&1 || true
  git_global --replace-all commit.gpgsign false
  printf 'boxdown: commit signing unavailable (reason: %s); commits will remain unsigned.\n' "${reason}" >&2
}

enable_signing() {
  if preserve_user_signing_preference; then
    printf '%s\n' 'boxdown: preserving explicit user Git signing configuration.' >&2
    return 0
  fi

  if [[ ! -r "${KEY_PATH}" ]]; then
    disable_signing 'container-key-unavailable'
    return 0
  fi

  if ! bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ssh-agent-proxy-bootstrap.sh"; then
    disable_signing 'container-agent-proxy-unavailable'
    return 0
  fi

  local agent_identities
  if ! agent_identities="$(ssh-add -L 2>/dev/null)"; then
    disable_signing 'container-agent-unavailable'
    return 0
  fi

  local selected_key
  selected_key="$(awk 'NR == 1 { print $1 " " $2 }' "${KEY_PATH}")"
  if ! grep -qF -- "${selected_key}" <<<"${agent_identities}"; then
    disable_signing 'container-key-not-loaded'
    return 0
  fi

  git_global --unset-all gpg.program >/dev/null 2>&1 || true
  git_global --replace-all gpg.format ssh
  git_global --replace-all user.signingkey "${KEY_PATH}"
  git_global --replace-all commit.gpgsign true

  local probe_dir
  probe_dir="$(mktemp -d)"
  if ! (
    cd "${probe_dir}"
    git init -q
    git config user.name 'Boxdown signing probe'
    git config user.email 'signing-probe@boxdown.invalid'
    git config gpg.format ssh
    git config user.signingkey "${KEY_PATH}"
    git config commit.gpgsign true
    git commit --allow-empty -m 'boxdown signing probe' >/dev/null
  ); then
    rm -rf "${probe_dir}"
    disable_signing 'container-signing-probe-failed'
    return 0
  fi
  rm -rf "${probe_dir}"
}

if [[ "${ENABLED}" == "1" ]]; then
  enable_signing
else
  disable_signing "${HOST_REASON}"
fi
