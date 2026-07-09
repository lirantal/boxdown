#!/usr/bin/env bash
#
# Container-side Python runtime setup for the repo-local devcontainer workflow.

set -euo pipefail

PYTHON_PACKAGES=(python3 python3-venv python3-pip pipx)

progress() {
  if [ "${BOXDOWN_PROGRESS:-0}" = "1" ]; then
    printf 'BOXDOWN_PROGRESS: %s\n' "$*"
  fi
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

python_runtime_ready() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 -m venv --help >/dev/null 2>&1 || return 1
  python3 -m pip --version >/dev/null 2>&1 || return 1
  command -v pipx >/dev/null 2>&1 || return 1
}

apt_lists_present() {
  find /var/lib/apt/lists -mindepth 1 -type f -name '*_Packages*' -print -quit 2>/dev/null | grep -q .
}

install_python_packages() {
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${PYTHON_PACKAGES[@]}"
}

install_python_runtime() {
  if python_runtime_ready; then
    return 0
  fi

  progress "Installing Python runtime packages"
  if ! apt_lists_present; then
    as_root apt-get update
  fi

  if ! install_python_packages; then
    as_root apt-get update
    install_python_packages
  fi

  as_root rm -rf /var/lib/apt/lists/*
  python_runtime_ready
}

main() {
  case "${1:-install}" in
    install)
      install_python_runtime
      ;;
    *)
      echo "Usage: $(basename "$0") [install]" >&2
      return 1
      ;;
  esac
}

main "$@"
