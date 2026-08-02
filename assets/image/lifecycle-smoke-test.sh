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

toolchain_plan="${workspace}/toolchains/plan.json"
toolchain_results="${workspace}/toolchain-results"
mkdir -p "$(dirname "${toolchain_plan}")" "${toolchain_results}"
cat > "${toolchain_plan}" <<'JSON'
{
  "version": 1,
  "workspaceId": "lifecycle-smoke-test",
  "fingerprint": "lifecycle-smoke-toolchains-v1",
  "selected": [
    {"id": "node", "version": "24.17.0"},
    {"id": "python", "version": "3.14.6"},
    {"id": "go", "version": "1.26.5"},
    {"id": "rust", "version": "1.97.1"}
  ],
  "updatedAt": "2026-08-02T00:00:00.000Z"
}
JSON
printf 'module lifecycle-smoke\n\ngo 1.26.5\n' > "${workspace}/go.mod"
cat > "${workspace}/Cargo.toml" <<'TOML'
[package]
name = "lifecycle-smoke"
version = "0.1.0"
edition = "2024"
TOML
mkdir -p "${workspace}/src"
printf 'pub fn lifecycle_smoke() {}\n' > "${workspace}/src/lib.rs"

BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH="${toolchain_plan}" \
BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR="${toolchain_results}" \
BOXDOWN_CONTAINER_WORKSPACE_FOLDER="${workspace}" \
  bash "/opt/boxdown/devcontainer/utils/toolchains-bootstrap.sh"

export PATH="${HOME}/.local/bin:${PATH}"
test "$(node --version)" = "v24.17.0"
test "$(python --version)" = "Python 3.14.6"
[[ "$(go version)" == *"go1.26.5"* ]]
[[ "$(rustc --version)" == *"1.97.1"* ]]
test "$(node -e 'process.stdout.write(`ok`)')" = "ok"
test "$(python -c 'print("ok")')" = "ok"
test -x "${HOME}/.local/bin/cargo"
test "$(node -e 'const r = require(process.argv[1]); process.stdout.write(`${r.state}:${r.runtimes.length}`)' "${toolchain_results}/result.json")" = "succeeded:4"

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
