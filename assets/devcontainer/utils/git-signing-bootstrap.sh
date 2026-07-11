#!/usr/bin/env bash
# Configure best-effort SSH commit signing without modifying the workspace Git config.

set -euo pipefail

TARGET_PATH="${BOXDOWN_GITCONFIG_TARGET_PATH:-/home/node/.gitconfig}"
KEY_PATH="${BOXDOWN_GIT_SIGNING_KEY_PATH:-/opt/boxdown/state/git-signing/signing-key.pub}"
ENABLED="${BOXDOWN_GIT_SIGNING_ENABLED:-0}"

git_global() {
  GIT_CONFIG_GLOBAL="${TARGET_PATH}" git config --global "$@"
}

disable_signing() {
  git_global --unset-all gpg.format >/dev/null 2>&1 || true
  git_global --unset-all user.signingkey >/dev/null 2>&1 || true
  git_global --unset-all gpg.program >/dev/null 2>&1 || true
  git_global --replace-all commit.gpgsign false
  printf '%s\n' 'boxdown: commit signing unavailable; commits will remain unsigned.' >&2
}

enable_signing() {
  if [[ ! -r "${KEY_PATH}" ]] || ! ssh-add -L | grep -qF "$(awk 'NR == 1 { print $1 " " $2 }' "${KEY_PATH}")"; then
    disable_signing
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
    disable_signing
    return 0
  fi
  rm -rf "${probe_dir}"
}

if [[ "${ENABLED}" == "1" ]]; then
  enable_signing
else
  disable_signing
fi
