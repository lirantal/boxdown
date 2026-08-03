#!/usr/bin/env bash
# BASH_ENV entrypoint: mounted code stays read-only; user state remains writable.
# This file is sourced by BASH_ENV and .bashrc. Do not change the caller's
# shell options here: interactive and noninteractive callers own those modes.
source /opt/boxdown/devcontainer/utils/secret-env-bootstrap.sh

if [[ -n "${HOME:-}" ]]; then
  toolchains_bin="${HOME}/.local/bin"
  case ":${PATH:-}:" in
    *":${toolchains_bin}:"*) ;;
    *) export PATH="${toolchains_bin}${PATH:+:${PATH}}" ;;
  esac
fi
