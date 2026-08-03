#!/usr/bin/env bash

set -euo pipefail

DEVCONTAINER_DIR="${1:?devcontainer asset directory is required}"
NODE_BIN="${2:?Node binary is required}"
ORIGINAL_BOOTSTRAP="${DEVCONTAINER_DIR}/utils/toolchains-bootstrap.sh"
POST_CREATE="${DEVCONTAINER_DIR}/hooks/post-create.sh"
POST_START="${DEVCONTAINER_DIR}/hooks/post-start.sh"
FINGERPRINT='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
VALID_TIME='2026-08-02T00:00:00.000Z'
TEST_ROOT="$(mktemp -d)"
TEST_ROOT="$(cd "${TEST_ROOT}" && pwd -P)"
trap 'rm -rf "${TEST_ROOT}"' EXIT

fail() {
  printf 'toolchains lifecycle fixture: %s\n' "$*" >&2
  exit 1
}

assert_file_equals() {
  local path="$1" expected="$2"
  [[ -f "${path}" ]] || fail "missing file: ${path}"
  [[ "$(cat "${path}")" == "${expected}" ]] || fail "unexpected contents: ${path}"
}

assert_json() {
  local path="$1" expression="$2"
  "${NODE_BIN}" -e "const value = require(process.argv[1]); if (!(${expression})) process.exit(1)" "${path}" ||
    fail "JSON assertion failed for ${path}: ${expression}"
}

write_plan() {
  local path="$1" selected="$2"
  mkdir -p "$(dirname "${path}")"
  printf '{"version":1,"workspaceId":"fixture","fingerprint":"%s","selected":%s,"updatedAt":"%s"}\n' \
    "${FINGERPRINT}" "${selected}" "${VALID_TIME}" > "${path}"
}

make_fake_mise() {
  local path="$1"
  mkdir -p "$(dirname "${path}")"
  cat > "${path}" <<'FAKE_MISE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${MISE_LOG}"
if [[ "${MISE_FAIL_INSTALL:-0}" == 1 && "${1:-}" == --no-config && "${2:-}" == install ]]; then
  exit 23
fi
if [[ "${MISE_FAIL_EXEC:-0}" == 1 && "${1:-}" == --no-config && "${2:-}" == exec ]]; then
  exit 24
fi
exit 0
FAKE_MISE
  chmod 0755 "${path}"
}

make_bootstrap() {
  local target="$1" mise="$2"
  mkdir -p "$(dirname "${target}")"
  sed -e "s#/usr/local/bin/node#${NODE_BIN}#g" -e "s#/usr/local/bin/mise#${mise}#g" \
    "${ORIGINAL_BOOTSTRAP}" > "${target}"
  cp "${DEVCONTAINER_DIR}/utils/deps-install.sh" "$(dirname "${target}")/deps-install.sh"
  chmod 0755 "${target}"
}

make_env_dispatcher() {
  local target="$1" secret_bootstrap="$2"
  mkdir -p "$(dirname "${target}")"
  sed "s#/opt/boxdown/devcontainer/utils/secret-env-bootstrap.sh#${secret_bootstrap}#" \
    "${DEVCONTAINER_DIR}/utils/toolchains-env-bootstrap.sh" > "${target}"
  chmod 0755 "${target}"
}

run_bootstrap() {
  local script="$1" home="$2" plan="$3" results="$4" workspace="$5" log="$6"
  HOME="${home}" PATH='/usr/bin:/bin' MISE_LOG="${log}" \
    BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH="${plan}" \
    BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR="${results}" \
    BOXDOWN_CONTAINER_WORKSPACE_FOLDER="${workspace}" \
    bash "${script}"
}

run_post_create_bootstrap() {
  local script="$1" home="$2" plan="$3" results="$4" workspace="$5" log="$6"
  HOME="${home}" PATH='/usr/bin:/bin' MISE_LOG="${log}" \
    BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH="${plan}" \
    BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR="${results}" \
    BOXDOWN_CONTAINER_WORKSPACE_FOLDER="${workspace}" \
    bash -c 'source "$1"; DEVCONTAINER_DIR="$2"; configure_toolchains' _ \
      "${POST_CREATE}" "$(cd "$(dirname "${script}")/.." && pwd -P)"
}

validator_status() {
  local plan="$1" result="$2"
  set +e
  HOME="${TEST_ROOT}" BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH="${plan}" \
    BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR="$(dirname "${result}")" \
    bash -c 'source "$1"; toolchains_need_bootstrap "$2"' _ "${POST_START}" "${NODE_BIN}" >/dev/null 2>&1
  local status=$?
  set -e
  printf '%s' "${status}"
}

test_post_start_validator() {
  local dir="${TEST_ROOT}/validator" plan="${TEST_ROOT}/validator/plan.json" result="${TEST_ROOT}/validator/results/result.json"
  mkdir -p "$(dirname "${result}")"
  write_plan "${plan}" '[{"id":"node","version":"24.17.0"}]'
  printf '{"version":1,"fingerprint":"%s","state":"succeeded","updatedAt":"%s","runtimes":[{"id":"node","version":"24.17.0","state":"succeeded"}]}\n' \
    "${FINGERPRINT}" "${VALID_TIME}" > "${result}"
  [[ "$(validator_status "${plan}" "${result}")" == 1 ]] || fail 'valid exact result was retried'

  local invalid_result
  for invalid_result in \
    "{\"version\":1,\"fingerprint\":\"${FINGERPRINT}\",\"state\":\"succeeded\",\"runtimes\":[{\"id\":\"node\",\"version\":\"24.17.0\",\"state\":\"succeeded\"}]}" \
    "{\"version\":1,\"fingerprint\":\"${FINGERPRINT}\",\"state\":\"succeeded\",\"updatedAt\":\"not-a-time\",\"runtimes\":[{\"id\":\"node\",\"version\":\"24.17.0\",\"state\":\"succeeded\"}]}" \
    "{\"version\":1,\"fingerprint\":\"${FINGERPRINT}\",\"state\":\"succeeded\",\"updatedAt\":\"${VALID_TIME}\",\"runtimes\":[]}" \
    "{\"version\":1,\"fingerprint\":\"${FINGERPRINT}\",\"state\":\"succeeded\",\"updatedAt\":\"${VALID_TIME}\",\"runtimes\":[{\"id\":\"node\",\"version\":\"24.17.0\",\"state\":\"succeeded\"},{\"id\":\"node\",\"version\":\"24.17.0\",\"state\":\"succeeded\"}]}" \
    "{\"version\":1,\"fingerprint\":\"${FINGERPRINT}\",\"state\":\"succeeded\",\"updatedAt\":\"${VALID_TIME}\",\"runtimes\":[{\"id\":\"python\",\"version\":\"24.17.0\",\"state\":\"succeeded\"}]}" \
    "{\"version\":1,\"fingerprint\":\"${FINGERPRINT}\",\"state\":\"succeeded\",\"updatedAt\":\"${VALID_TIME}\",\"runtimes\":[{\"id\":\"node\",\"version\":\"24.17.0\\n\",\"state\":\"succeeded\"}]}"
  do
    printf '%s\n' "${invalid_result}" > "${result}"
    [[ "$(validator_status "${plan}" "${result}")" == 0 ]] || fail "invalid result skipped retry: ${invalid_result}"
  done

  write_plan "${plan}" '[{"id":"node","version":"24.17.0"},{"id":"node","version":"24.17.0"}]'
  [[ "$(validator_status "${plan}" "${result}")" == 0 ]] || fail 'duplicate plan IDs skipped retry'
  write_plan "${plan}" '[{"id":"node","version":"24.17.0\n"}]'
  [[ "$(validator_status "${plan}" "${result}")" == 0 ]] || fail 'injected plan version skipped retry'
  : > "${plan}"
  [[ "$(validator_status "${plan}" "${result}")" == 0 ]] || fail 'empty plan skipped retry'
}

test_post_create_dispatch() {
  local dir="${TEST_ROOT}/post-create" plan="${TEST_ROOT}/post-create/plan.json" marker="${TEST_ROOT}/post-create/legacy-ran"
  local dev="${TEST_ROOT}/post-create/dev"
  mkdir -p "${dev}/utils"
  printf '#!/usr/bin/env bash\ntouch %q\n' "${marker}" > "${dev}/utils/deps-install.sh"
  write_plan "${plan}" '[]'
  DEVCONTAINER_DIR="${dev}" BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH="${plan}" \
    bash -c 'source "$1"; run_deps_install "$2"' _ "${POST_CREATE}" "${NODE_BIN}"
  [[ ! -e "${marker}" ]] || fail 'empty valid plan ran legacy dependencies'
  write_plan "${plan}" '[{"id":"python","version":"3.14.6"}]'
  DEVCONTAINER_DIR="${dev}" BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH="${plan}" \
    bash -c 'source "$1"; run_deps_install "$2"' _ "${POST_CREATE}" "${NODE_BIN}"
  [[ ! -e "${marker}" ]] || fail 'non-Node valid plan ran legacy dependencies'
  rm -f "${plan}"
  BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH="${plan}" \
    bash -c 'source "$1"; DEVCONTAINER_DIR="$3"; run_deps_install "$2"' _ "${POST_CREATE}" "${NODE_BIN}" "${dev}"
  [[ -e "${marker}" ]] || fail 'legacy no-plan dependency behavior changed'
}

test_dependency_exit_semantics() {
  local workspace="${TEST_ROOT}/dependency-status/workspace"
  local bin="${TEST_ROOT}/dependency-status/bin" plan="${TEST_ROOT}/dependency-status/missing-plan.json"
  mkdir -p "${workspace}" "${bin}"
  printf '{}\n' > "${workspace}/package.json"
  printf '{}\n' > "${workspace}/package-lock.json"
  printf '#!/usr/bin/env bash\nexit 29\n' > "${bin}/npm"
  chmod 0755 "${bin}/npm"

  (cd "${workspace}" && BASH_ENV=/dev/null PATH="${bin}:/usr/bin:/bin" \
    bash "${DEVCONTAINER_DIR}/utils/deps-install.sh") || fail 'legacy non-strict dependency failure returned nonzero'
  if (cd "${workspace}" && BASH_ENV=/dev/null PATH="${bin}:/usr/bin:/bin" BOXDOWN_DEPS_INSTALL_STRICT=1 \
    bash "${DEVCONTAINER_DIR}/utils/deps-install.sh"); then
    fail 'strict dependency failure returned zero'
  fi
  (cd "${workspace}" && BASH_ENV=/dev/null PATH="${bin}:/usr/bin:/bin" \
    BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH="${plan}" DEVCONTAINER_DIR="${DEVCONTAINER_DIR}" \
    bash -c 'source "$1"; run_deps_install "$2"' _ "${POST_CREATE}" "${NODE_BIN}") ||
    fail 'post-create legacy dependency failure returned nonzero'
}

test_noninteractive_bashrc_path() {
  local home="${TEST_ROOT}/bashrc/home" workspace="${TEST_ROOT}/bashrc/workspace"
  local plan="${TEST_ROOT}/bashrc/plan.json" results="${TEST_ROOT}/bashrc/results" log="${TEST_ROOT}/bashrc/mise.log"
  local mise="${TEST_ROOT}/bashrc/bin/mise" bootstrap="${TEST_ROOT}/bashrc/devcontainer/utils/toolchains-bootstrap.sh"
  mkdir -p "${home}" "${workspace}"
  cat > "${home}/.bashrc" <<'BASHRC'
# Standard Debian noninteractive guard.
case $- in
  *i*) ;;
  *) return ;;
esac
export USER_BASHRC_MARKER=preserved
BASHRC
  make_fake_mise "${mise}"
  make_bootstrap "${bootstrap}" "${mise}"
  write_plan "${plan}" '[]'
  : > "${log}"
  run_bootstrap "${bootstrap}" "${home}" "${plan}" "${results}" "${workspace}" "${log}"
  [[ "$(sed -n '1p' "${home}/.bashrc")" == 'source /opt/boxdown/devcontainer/utils/toolchains-env-bootstrap.sh' ]] ||
    fail 'secret and toolchain dispatcher was not placed before the noninteractive bashrc return'
  [[ "$(sed -n '2p' "${home}/.bashrc")" == 'export PATH="$HOME/.local/bin:$PATH"' ]] ||
    fail 'toolchain PATH was not placed before the noninteractive bashrc return'
  grep -Fqx 'export USER_BASHRC_MARKER=preserved' "${home}/.bashrc" || fail 'bashrc contents were not preserved'
}

test_env_dispatcher_preserves_caller_shell_options() {
  local dir="${TEST_ROOT}/env-dispatcher" home="${TEST_ROOT}/env-dispatcher/home"
  local dispatcher="${dir}/toolchains-env-bootstrap.sh" secret_bootstrap="${dir}/secret-env-bootstrap.sh"
  mkdir -p "${home}/.local/share/boxdown/toolchains"
  printf 'export PATH="$HOME/.local/bin:$PATH"\n' > "${home}/.local/share/boxdown/toolchains/bash-env.sh"
  printf '#!/usr/bin/env bash\nexport BOXDOWN_SECRET_DISPATCHER_SENTINEL=present\n' > "${secret_bootstrap}"
  make_env_dispatcher "${dispatcher}" "${secret_bootstrap}"

  HOME="${home}" PATH='/usr/bin:/bin' bash -c '
    set +u
    set +o pipefail
    source "$1"
    [[ "$-" != *u* ]] || exit 11
    false | true
    [[ $? == 0 ]] || exit 12
    [[ -z "${unset_after_dispatcher}" ]] || exit 13
    [[ "$PATH" == "$HOME/.local/bin:/usr/bin:/bin" ]] || exit 14
    [[ "${BOXDOWN_SECRET_DISPATCHER_SENTINEL}" == present ]] || exit 15
  ' _ "${dispatcher}" || fail 'dispatcher changed disabled caller shell options or did not load PATH and secrets'

  HOME="${home}" PATH='/usr/bin:/bin' bash -c '
    set -u
    set -o pipefail
    source "$1"
    [[ "$-" == *u* ]] || exit 21
    if false | true; then exit 22; fi
    [[ "$PATH" == "$HOME/.local/bin:/usr/bin:/bin" ]] || exit 23
    [[ "${BOXDOWN_SECRET_DISPATCHER_SENTINEL}" == present ]] || exit 24
  ' _ "${dispatcher}" || fail 'dispatcher changed enabled caller shell options or did not load PATH and secrets'
}

test_results_failures_and_modes() {
  local dir="${TEST_ROOT}/results" home="${TEST_ROOT}/results/home" workspace="${TEST_ROOT}/results/workspace"
  local plan="${TEST_ROOT}/results/plan.json" results="${TEST_ROOT}/results/output" log="${TEST_ROOT}/results/mise.log"
  local mise="${TEST_ROOT}/results/bin/mise" bootstrap="${TEST_ROOT}/results/devcontainer/utils/toolchains-bootstrap.sh"
  mkdir -p "${home}" "${workspace}"
  make_fake_mise "${mise}"
  make_bootstrap "${bootstrap}" "${mise}"
  write_plan "${plan}" '[{"id":"node","version":"1.2.3"}]'
  : > "${log}"
  MISE_FAIL_INSTALL=1 run_bootstrap "${bootstrap}" "${home}" "${plan}" "${results}" "${workspace}" "${log}"
  assert_json "${results}/result.json" 'value.state === "failed" && value.runtimes.length === 1 && value.runtimes[0].state === "failed"'

  printf '{}\n' > "${workspace}/package.json"
  write_plan "${plan}" "[{\"id\":\"node\",\"version\":\"$(${NODE_BIN} --version | sed 's/^v//')\"}]"
  MISE_FAIL_EXEC=1 run_post_create_bootstrap "${bootstrap}" "${home}" "${plan}" "${results}" "${workspace}" "${log}"
  assert_json "${results}/result.json" 'value.state === "failed" && value.runtimes.length === 1 && value.runtimes[0].message === "dependency synchronization failed"'
  rm -f "${workspace}/package.json"

  write_plan "${plan}" '[]'
  : > "${log}"
  (umask 000; run_bootstrap "${bootstrap}" "${home}" "${plan}" "${results}" "${workspace}" "${log}")
  [[ ! -s "${log}" ]] || fail 'empty plan invoked mise'
  "${NODE_BIN}" - "${home}" "${results}" <<'NODE'
const { statSync } = require('node:fs')
for (const path of [
  `${process.argv[2]}/.local/share/boxdown/toolchains`,
  `${process.argv[2]}/.local/share/boxdown/toolchains/data`,
  `${process.argv[2]}/.local/bin`,
  process.argv[3]
]) {
  if ((statSync(path).mode & 0o777) !== 0o700) process.exit(1)
}
if ((statSync(`${process.argv[3]}/result.json`).mode & 0o777) !== 0o600) process.exit(1)
NODE
}

test_owned_wrappers() {
  local dir="${TEST_ROOT}/wrappers" home="${TEST_ROOT}/wrappers/home" workspace="${TEST_ROOT}/wrappers/workspace"
  local plan="${TEST_ROOT}/wrappers/plan.json" results="${TEST_ROOT}/wrappers/results" log="${TEST_ROOT}/wrappers/mise.log"
  local mise="${TEST_ROOT}/wrappers/bin/mise" bootstrap="${TEST_ROOT}/wrappers/devcontainer/utils/toolchains-bootstrap.sh"
  mkdir -p "${home}/.local/bin" "${workspace}"
  make_fake_mise "${mise}"
  make_bootstrap "${bootstrap}" "${mise}"
  printf '#!/usr/bin/env bash\nprintf user-node\n' > "${home}/.local/bin/node"
  chmod 0755 "${home}/.local/bin/node"
  write_plan "${plan}" "[{\"id\":\"node\",\"version\":\"$(${NODE_BIN} --version | sed 's/^v//')\"}]"
  : > "${log}"
  run_bootstrap "${bootstrap}" "${home}" "${plan}" "${results}" "${workspace}" "${log}"
  assert_file_equals "${home}/.local/bin/node" $'#!/usr/bin/env bash\nprintf user-node'
  assert_json "${results}/result.json" 'value.state === "failed" && value.runtimes[0].state === "failed"'

  rm -f "${home}/.local/bin/node"
  write_plan "${plan}" '[{"id":"python","version":"3.14.6"}]'
  run_bootstrap "${bootstrap}" "${home}" "${plan}" "${results}" "${workspace}" "${log}"
  grep -Fqx '# boxdown-toolchain-wrapper-v1' "${home}/.local/bin/python" || fail 'wrapper lacks exact ownership marker'
  printf '#!/usr/bin/env bash\n# mentions %s --no-config exec but is user owned\n' "${mise}" > "${home}/.local/bin/node"
  write_plan "${plan}" '[]'
  run_bootstrap "${bootstrap}" "${home}" "${plan}" "${results}" "${workspace}" "${log}"
  [[ -e "${home}/.local/bin/node" ]] || fail 'stale cleanup removed user executable'
  [[ ! -e "${home}/.local/bin/python" ]] || fail 'stale cleanup retained owned wrapper'

  rm -f "${home}/.local/bin/node" "${home}/.local/bin/npm" "${home}/.local/bin/npx" "${home}/.local/bin/corepack"
  write_plan "${plan}" "[{\"id\":\"node\",\"version\":\"$(${NODE_BIN} --version | sed 's/^v//')\"}]"
  run_bootstrap "${bootstrap}" "${home}" "${plan}" "${results}" "${workspace}" "${log}"
  grep -Fqx '# boxdown-toolchain-wrapper-v1' "${home}/.local/bin/node" || fail 'successful runtime did not create an owned node wrapper'
  printf '#!/usr/bin/env bash\nprintf user-corepack\n' > "${home}/.local/bin/corepack"
  chmod 0755 "${home}/.local/bin/corepack"

  write_plan "${plan}" '[{"id":"node","version":"1.2.3"}]'
  MISE_FAIL_INSTALL=1 run_bootstrap "${bootstrap}" "${home}" "${plan}" "${results}" "${workspace}" "${log}"
  [[ ! -e "${home}/.local/bin/node" && ! -e "${home}/.local/bin/npm" && ! -e "${home}/.local/bin/npx" ]] ||
    fail 'failed runtime install retained stale Boxdown-owned wrappers'
  assert_file_equals "${home}/.local/bin/corepack" $'#!/usr/bin/env bash\nprintf user-corepack'
  assert_json "${results}/result.json" 'value.state === "failed" && value.runtimes[0].message === "mise install failed"'
}

test_symlink_refusal() {
  local dir="${TEST_ROOT}/symlinks" real_home="${TEST_ROOT}/symlinks/real-home" workspace="${TEST_ROOT}/symlinks/workspace"
  local plan="${TEST_ROOT}/symlinks/plan.json" results="${TEST_ROOT}/symlinks/results" log="${TEST_ROOT}/symlinks/mise.log"
  local mise="${TEST_ROOT}/symlinks/bin/mise" bootstrap="${TEST_ROOT}/symlinks/devcontainer/utils/toolchains-bootstrap.sh" outside="${TEST_ROOT}/symlinks/outside"
  mkdir -p "${real_home}" "${workspace}" "${outside}"
  make_fake_mise "${mise}"
  make_bootstrap "${bootstrap}" "${mise}"
  write_plan "${plan}" '[]'
  ln -s "${real_home}" "${dir}/home-link"
  run_bootstrap "${bootstrap}" "${dir}/home-link" "${plan}" "${results}" "${workspace}" "${log}"
  [[ ! -e "${real_home}/.local" ]] || fail 'HOME ancestor symlink caused an outside write'

  mkdir -p "${dir}/safe-home"
  printf 'outside-result' > "${outside}/result.json"
  mkdir -p "${results}"
  rm -f "${results}/result.json"
  ln -s "${outside}/result.json" "${results}/result.json"
  run_bootstrap "${bootstrap}" "${dir}/safe-home" "${plan}" "${results}" "${workspace}" "${log}"
  assert_file_equals "${outside}/result.json" 'outside-result'
  [[ -L "${results}/result.json" ]] || fail 'result leaf symlink was replaced'

  rm -rf "${results}"
  ln -s "${outside}" "${results}"
  run_bootstrap "${bootstrap}" "${dir}/safe-home" "${plan}" "${results}" "${workspace}" "${log}"
  assert_file_equals "${outside}/result.json" 'outside-result'

  rm -rf "${dir}/safe-home"
  mkdir -p "${dir}/safe-home"
  printf 'user bashrc' > "${outside}/bashrc"
  ln -s "${outside}/bashrc" "${dir}/safe-home/.bashrc"
  run_bootstrap "${bootstrap}" "${dir}/safe-home" "${plan}" "${dir}/safe-results" "${workspace}" "${log}"
  assert_file_equals "${outside}/bashrc" 'user bashrc'

  rm -rf "${dir}/safe-home" "${dir}/safe-results"
  mkdir -p "${dir}/safe-home" "${dir}/safe-results"
  ln -s "${outside}" "${dir}/safe-home/.local"
  run_bootstrap "${bootstrap}" "${dir}/safe-home" "${plan}" "${dir}/safe-results" "${workspace}" "${log}"
  [[ ! -e "${outside}/share" ]] || fail 'mise/wrapper ancestor symlink caused an outside write'

  mkdir -p "${outside}/plan-parent"
  write_plan "${outside}/plan-parent/plan.json" '[]'
  ln -s "${outside}/plan-parent" "${dir}/plan-link"
  rm -rf "${dir}/safe-home" "${dir}/safe-results"
  mkdir -p "${dir}/safe-home"
  run_bootstrap "${bootstrap}" "${dir}/safe-home" "${dir}/plan-link/plan.json" "${dir}/safe-results" "${workspace}" "${log}"
  [[ ! -e "${dir}/safe-results/result.json" ]] || fail 'plan ancestor symlink was read'

  write_plan "${plan}" '[]'
  ln -s "${outside}" "${dir}/workspace-link"
  run_bootstrap "${bootstrap}" "${dir}/safe-home" "${plan}" "${dir}/workspace-results" "${dir}/workspace-link" "${log}"
  assert_json "${dir}/workspace-results/result.json" 'value.state === "failed"'
}

test_post_start_validator
test_post_create_dispatch
test_dependency_exit_semantics
test_noninteractive_bashrc_path
test_env_dispatcher_preserves_caller_shell_options
test_results_failures_and_modes
test_owned_wrappers
test_symlink_refusal

printf 'toolchains lifecycle fixture: ok\n'
