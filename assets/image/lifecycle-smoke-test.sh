#!/usr/bin/env bash

set -euo pipefail

test "$(id -u)" -ne 0
sudo -n true
sudo -n -l /usr/local/sbin/boxdown-ssh-agent-proxy >/dev/null

workspace="$(mktemp -d)"
trap 'rm -rf "${workspace}"' EXIT

BOXDOWN_CONTAINER_WORKSPACE_FOLDER="${workspace}" \
DEVCONTAINER_SSH_PUBLIC_KEY_FILE="${workspace}/missing.pub" \
  bash "/opt/boxdown/devcontainer/utils/ssh-bootstrap.sh" runtime

test -d /run/sshd
test -L "${HOME}/$(basename "${workspace}")"
