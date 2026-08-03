#!/usr/bin/env bash

set -euo pipefail

cleanup_ssh_proxy_host_smoke() {
  if [[ -n "${ssh_smoke_container_id:-}" ]]; then
    docker rm -f "${ssh_smoke_container_id}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${ssh_smoke_root:-}" ]]; then
    rm -rf "${ssh_smoke_root}"
  fi
}

run_ssh_proxy_host_smoke() {
  local image="${1:?image name is required}" assets="${2:?devcontainer assets directory is required}"
  local proxy_command version command_path
  assets="$(cd "${assets}" && pwd -P)"
  ssh_smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/boxdown-ssh-proxy-smoke.XXXXXX")"
  ssh_smoke_container_id=''
  trap cleanup_ssh_proxy_host_smoke EXIT INT TERM
  mkdir -p "${ssh_smoke_root}/plan" "${ssh_smoke_root}/results" "${ssh_smoke_root}/secrets"
  ssh-keygen -q -t ed25519 -N '' -f "${ssh_smoke_root}/id_ed25519"
  printf '%s\n' 'ssh-secret-sentinel' > "${ssh_smoke_root}/secrets/ANTHROPIC_API_KEY"
  cat > "${ssh_smoke_root}/plan/plan.json" <<'JSON'
{"version":1,"workspaceId":"ssh-proxy-smoke","fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","selected":[{"id":"node","version":"24.17.0"}],"updatedAt":"2026-08-02T00:00:00.000Z"}
JSON

  ssh_smoke_container_id="$(docker run --rm -d --user root \
    --mount "type=bind,source=${assets},target=/opt/boxdown/devcontainer,readonly" \
    --mount "type=bind,source=${ssh_smoke_root}/plan,target=/opt/boxdown/state/toolchains/plan,readonly" \
    --mount "type=bind,source=${ssh_smoke_root}/results,target=/opt/boxdown/state/toolchain-results" \
    --mount "type=bind,source=${ssh_smoke_root}/secrets,target=/run/boxdown/secrets,readonly" \
    --mount "type=bind,source=${ssh_smoke_root}/id_ed25519.pub,target=/tmp/boxdown-smoke.pub,readonly" \
    "${image}" /usr/bin/tail -f /dev/null)"

  docker exec --user root "${ssh_smoke_container_id}" \
    /usr/bin/chown node:node /opt/boxdown/state/toolchain-results
  docker exec --user node --env HOME=/home/node \
    --env BOXDOWN_CONTAINER_WORKSPACE_FOLDER=/tmp/boxdown-ssh-proxy-workspace \
    --env DEVCONTAINER_SSH_PUBLIC_KEY_FILE=/tmp/boxdown-smoke.pub \
    "${ssh_smoke_container_id}" bash -c \
    'mkdir -p "$BOXDOWN_CONTAINER_WORKSPACE_FOLDER" &&
      bash /opt/boxdown/devcontainer/utils/toolchains-bootstrap.sh &&
      bash /opt/boxdown/devcontainer/utils/ssh-bootstrap.sh runtime'

  proxy_command="docker exec --user root -i ${ssh_smoke_container_id} /usr/sbin/sshd -i -o LogLevel=QUIET -o PubkeyAuthentication=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o AllowTcpForwarding=yes -o AllowStreamLocalForwarding=yes -o PermitTTY=yes"
  local -a ssh_options=(
    -F /dev/null
    -i "${ssh_smoke_root}/id_ed25519"
    -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
    -o LogLevel=ERROR
    -o "ProxyCommand=${proxy_command}"
    node@boxdown-toolchain-smoke
  )
  command_path="$(ssh "${ssh_options[@]}" command -v node)"
  version="$(ssh "${ssh_options[@]}" node --version)"
  test "${command_path}" = '/home/node/.local/bin/node'
  test "${version}" = 'v24.17.0'
  ssh "${ssh_options[@]}" 'test "$ANTHROPIC_API_KEY" = ssh-secret-sentinel'
  ssh "${ssh_options[@]}" 'test ! -w /opt/boxdown/devcontainer/utils/toolchains-env-bootstrap.sh'

  cat > "${ssh_smoke_root}/plan/plan.json" <<'JSON'
{"version":1,"workspaceId":"ssh-proxy-smoke","fingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","selected":[],"updatedAt":"2026-08-02T00:00:00.000Z"}
JSON
  docker exec --user node --env HOME=/home/node \
    --env BOXDOWN_CONTAINER_WORKSPACE_FOLDER=/tmp/boxdown-ssh-proxy-workspace \
    "${ssh_smoke_container_id}" bash /opt/boxdown/devcontainer/utils/toolchains-bootstrap.sh
  docker exec --user node "${ssh_smoke_container_id}" /usr/local/bin/node -e \
    'const result = require("/opt/boxdown/state/toolchain-results/result.json"); if (result.state !== "succeeded" || result.runtimes.length !== 0) process.exit(1)'

  printf 'ssh proxy toolchain smoke: ok\n'
}

if [[ "${1:-}" == "--ssh-proxy-host" ]]; then
  run_ssh_proxy_host_smoke "${2:-}" "${3:-}"
  exit 0
fi

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
  "fingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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

toolchain_dispatcher='/opt/boxdown/devcontainer/utils/toolchains-env-bootstrap.sh'
test ! -w "${toolchain_dispatcher}"
test "$(BASH_ENV="${toolchain_dispatcher}" bash -c 'node --version')" = 'v24.17.0'
BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH="${toolchain_plan}" \
BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR="${toolchain_results}" \
  bash -c 'source /opt/boxdown/devcontainer/hooks/post-start.sh; ! toolchains_need_bootstrap'

strict_workspace="${workspace}/strict-node-deps"
strict_bin="${workspace}/strict-bin"
mkdir -p "${strict_workspace}" "${strict_bin}"
printf '{}\n' > "${strict_workspace}/package.json"
printf '{}\n' > "${strict_workspace}/package-lock.json"
printf '#!/usr/bin/env bash\nexit 29\n' > "${strict_bin}/npm"
chmod 0755 "${strict_bin}/npm"
if (cd "${strict_workspace}" && BASH_ENV=/dev/null PATH="${strict_bin}:/usr/bin:/bin" BOXDOWN_DEPS_INSTALL_STRICT=1 \
  bash /opt/boxdown/devcontainer/utils/deps-install.sh); then
  echo 'strict dependency fixture unexpectedly succeeded' >&2
  exit 1
fi

empty_home="${workspace}/empty-home"
empty_plan="${workspace}/empty-plan.json"
empty_results="${workspace}/empty-results"
mkdir -m 0700 "${empty_home}"
cat > "${empty_plan}" <<'JSON'
{"version":1,"workspaceId":"empty","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","selected":[],"updatedAt":"2026-08-02T00:00:00.000Z"}
JSON
HOME="${empty_home}" \
BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH="${empty_plan}" \
BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR="${empty_results}" \
BOXDOWN_CONTAINER_WORKSPACE_FOLDER="${workspace}" \
  bash /opt/boxdown/devcontainer/utils/toolchains-bootstrap.sh
test "$(/usr/local/bin/node -e 'const r = require(process.argv[1]); process.stdout.write(`${r.state}:${r.runtimes.length}`)' "${empty_results}/result.json")" = 'succeeded:0'

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
