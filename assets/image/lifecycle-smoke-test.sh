#!/usr/bin/env bash

set -euo pipefail

test "$(id -u)" -ne 0
sudo -n true
sudo -n -l /usr/local/sbin/boxdown-ssh-agent-proxy >/dev/null

workspace="$(mktemp -d)"
trap 'rm -rf "${workspace}"' EXIT

profile_source="${workspace}/agent-profile-source"
profile_home="${workspace}/agent-profile-home"
profile_marker="${workspace}/agent-profile-state/agent-profile"
mkdir -p "${profile_source}/agents" "${profile_home}"
printf '%s\n' 'smoke test agent profile' > "${profile_source}/agents/SMOKE.md"
printf '%s\n' '{"token":"smoke-test"}' > "${profile_source}/codex-auth.json"

BOXDOWN_AGENT_PROFILE=auth \
BOXDOWN_AGENT_PROFILE_SOURCE_DIR="${profile_source}" \
BOXDOWN_AGENT_PROFILE_HOME="${profile_home}" \
BOXDOWN_AGENT_PROFILE_MARKER_PATH="${profile_marker}" \
  node "/opt/boxdown/devcontainer/utils/agent-profile-bootstrap.mjs"

test -w "${profile_home}/.agents/SMOKE.md"
test -w "${profile_home}/.codex/auth.json"
test -w "${profile_marker}"
printf '%s\n' 'container write' >> "${profile_home}/.agents/SMOKE.md"
printf '%s\n' 'container write' >> "${profile_home}/.codex/auth.json"
printf '%s\n' 'container write' >> "${profile_marker}"

BOXDOWN_CONTAINER_WORKSPACE_FOLDER="${workspace}" \
DEVCONTAINER_SSH_PUBLIC_KEY_FILE="${workspace}/missing.pub" \
  bash "/opt/boxdown/devcontainer/utils/ssh-bootstrap.sh" runtime

test -d /run/sshd
test -L "${HOME}/$(basename "${workspace}")"
