#!/usr/bin/env bash
# Expose a root-only forwarded SSH-agent socket to the non-root container user.

set -euo pipefail

SOURCE_SOCKET="${BOXDOWN_GIT_SIGNING_SOURCE_SOCKET:-/run/boxdown/ssh-agent.sock}"
TARGET_SOCKET="${SSH_AUTH_SOCK:-/run/boxdown/ssh-agent-node.sock}"
PROXY_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ssh-agent-proxy.mjs"

if ssh-add -L >/dev/null 2>&1; then
  exit 0
fi

if ! command -v sudo >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  exit 1
fi

sudo -n node "${PROXY_SCRIPT}" --source "${SOURCE_SOCKET}" --target "${TARGET_SOCKET}" --uid "$(id -u)" --gid "$(id -g)" >/dev/null 2>&1 &

for _ in $(seq 1 20); do
  if [[ -S "${TARGET_SOCKET}" ]] && ssh-add -L >/dev/null 2>&1; then
    exit 0
  fi
  sleep 0.1
done

exit 1
