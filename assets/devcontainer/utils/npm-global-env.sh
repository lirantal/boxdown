#!/usr/bin/env bash
# Shared by shell startup, lifecycle commands, and coding-agent refreshes.
# Keep caller shell options and explicit npm prefix overrides intact.
boxdown_npm_global_env() {
  [[ -n "${HOME:-}" ]] || return 0
  export NPM_CONFIG_PREFIX="${npm_config_prefix:-${NPM_CONFIG_PREFIX:-${HOME}/.local/share/boxdown/npm-global}}"

  local entry managed remaining="${PATH:-}" result='' separator=''
  local -a entries=() candidates=(
    "${HOME}/.local/bin"
    "${NPM_CONFIG_PREFIX}/bin"
    "${HOME}/.local/node_modules/.bin"
    "${HOME}/.opencode/bin"
    "${CODEX_HOME:-${HOME}/.codex}/packages/standalone/current/bin"
  )
  for entry in "${candidates[@]}"; do
    for managed in "${entries[@]}"; do
      [[ "${entry}" == "${managed}" ]] && break
    done
    [[ "${entry}" == "${managed:-}" ]] && continue
    entries+=("${entry}")
    result+="${separator}${entry}"
    separator=':'
  done
  while :; do
    [[ -n "${PATH:-}" ]] || break
    entry="${remaining%%:*}"
    managed=''
    for managed in "${entries[@]}"; do
      [[ "${entry}" == "${managed}" ]] && break
    done
    if [[ "${entry}" != "${managed}" ]]; then
      result+=":${entry}"
    fi
    [[ "${remaining}" == *:* ]] || break
    remaining="${remaining#*:}"
  done
  export PATH="${result}"
}

boxdown_npm_global_env
unset -f boxdown_npm_global_env
