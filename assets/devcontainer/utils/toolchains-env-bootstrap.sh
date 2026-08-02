#!/usr/bin/env bash
# BASH_ENV entrypoint: mounted code stays read-only; user state remains writable.
set -uo pipefail
source /opt/boxdown/devcontainer/utils/secret-env-bootstrap.sh
toolchains_env="${HOME}/.local/share/boxdown/toolchains/bash-env.sh"

path_has_no_symlinks() {
  local target="$1" current='/' part
  local -a parts=()
  [[ "${target}" = /* && "${target}" != *'/../'* && "${target}" != *'/./'* ]] || return 1
  IFS='/' read -r -a parts <<< "${target#/}"
  for part in "${parts[@]}"; do
    [[ -n "${part}" ]] || return 1
    current="${current%/}/${part}"
    [[ ! -L "${current}" ]] || return 1
  done
}

if path_has_no_symlinks "${toolchains_env}" && [[ -f "${toolchains_env}" ]]; then
  source "${toolchains_env}"
fi
