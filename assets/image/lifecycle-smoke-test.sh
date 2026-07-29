#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" == "--remap-node" ]]; then
  test "$(id -u)" -eq 0
  remapped_uid=2001
  remapped_gid=2001
  groupmod --gid "${remapped_gid}" node
  usermod --uid "${remapped_uid}" --gid "${remapped_gid}" node
  chown -R node:node /home/node
  exec sudo -H -u node "$0"
fi

test "$(id -u)" -ne 0
test "$(id -u)" -ne 1000
sudo -n true
sudo -n -l /usr/local/sbin/boxdown-ssh-agent-proxy >/dev/null

workspace="$(mktemp -d)"
trap 'rm -rf "${workspace}"' EXIT

profile_source="${workspace}/agent-profile-source"
profile_home="${workspace}/agent-profile-home"
profile_marker="/opt/boxdown/state/agent-profile"
mkdir -p "${profile_source}/agents" "${profile_home}"
printf '%s\n' 'smoke test agent profile' > "${profile_source}/agents/SMOKE.md"
printf '%s\n' '{"token":"smoke-test"}' > "${profile_source}/codex-auth.json"

BOXDOWN_AGENT_PROFILE=auth \
BOXDOWN_AGENT_PROFILE_SOURCE_DIR="${profile_source}" \
BOXDOWN_AGENT_PROFILE_HOME="${profile_home}" \
  node "/opt/boxdown/devcontainer/utils/agent-profile-bootstrap.mjs"

test -w "${profile_home}/.agents/SMOKE.md"
test -w "${profile_home}/.codex/auth.json"
test -w "${profile_marker}"
test "$(stat -c '%a' "${profile_marker}")" = "600"
test "$(stat -c '%u' "${profile_marker}")" = "$(id -u)"
printf '%s\n' 'container write' >> "${profile_home}/.agents/SMOKE.md"
printf '%s\n' 'container write' >> "${profile_home}/.codex/auth.json"
printf '%s\n' 'container write' >> "${profile_marker}"

BOXDOWN_CONTAINER_WORKSPACE_FOLDER="${workspace}" \
DEVCONTAINER_SSH_PUBLIC_KEY_FILE="${workspace}/missing.pub" \
  bash "/opt/boxdown/devcontainer/utils/ssh-bootstrap.sh" runtime

test -d /run/sshd
test -L "${HOME}/$(basename "${workspace}")"
