#!/usr/bin/env bash
# Provision the user-approved workspace toolchains without consulting repository mise files.

set -uo pipefail

DEVCONTAINER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLAN_PATH="${BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH:-/opt/boxdown/state/toolchains/plan/plan.json}"
RESULTS_DIR="${BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR:-/opt/boxdown/state/toolchain-results}"
# Default atomic target: /opt/boxdown/state/toolchain-results/result.json
WORKSPACE_FOLDER="${BOXDOWN_CONTAINER_WORKSPACE_FOLDER:-$PWD}"
BOXDOWN_TOOLCHAINS_HOME="${HOME}/.local/share/boxdown/toolchains"
TOOLCHAINS_BASH_ENV="${BOXDOWN_TOOLCHAINS_HOME}/bash-env.sh"
PLAN_NODE='/usr/local/bin/node'
WRAPPER_MARKER='# boxdown-toolchain-wrapper-v1'

export MISE_DATA_DIR="${BOXDOWN_TOOLCHAINS_HOME}/data"
export MISE_CACHE_DIR="${BOXDOWN_TOOLCHAINS_HOME}/cache"
export MISE_CONFIG_DIR="${BOXDOWN_TOOLCHAINS_HOME}/config"
export MISE_STATE_DIR="${BOXDOWN_TOOLCHAINS_HOME}/state"

warn() {
  printf 'toolchains-bootstrap: warning: %s\n' "$*" >&2
}

one_line() {
  printf '%s' "$1" | tr '\r\n\t' '   ' | tr -s ' '
}

# Accept only absolute, normalized paths whose existing leaf and ancestors are
# not symbolic links. Every read/write call performs this check immediately
# before operating on its target.
path_is_safe() {
  local target="$1"
  "${PLAN_NODE}" - "${target}" <<'NODE'
const { lstatSync } = require('node:fs')
const { isAbsolute, normalize, parse, sep } = require('node:path')
const target = process.argv[2]
if (!isAbsolute(target) || normalize(target) !== target || target.includes('\0')) process.exit(1)
const root = parse(target).root
let current = root
for (const part of target.slice(root.length).split(sep).filter(Boolean)) {
  current = current === root ? `${root}${part}` : `${current}${sep}${part}`
  try {
    if (lstatSync(current).isSymbolicLink()) process.exit(1)
  } catch (error) {
    if (error?.code !== 'ENOENT') process.exit(1)
  }
}
NODE
}

secure_mkdir() {
  local target="$1" current='/' part
  local -a parts=()
  path_is_safe "${target}" || return 1
  IFS='/' read -r -a parts <<< "${target#/}"
  for part in "${parts[@]}"; do
    [[ -n "${part}" && "${part}" != '.' && "${part}" != '..' ]] || return 1
    current="${current%/}/${part}"
    if [[ -e "${current}" ]]; then
      path_is_safe "${current}" && [[ -d "${current}" ]] || return 1
    else
      mkdir -m 0700 "${current}" || return 1
      path_is_safe "${current}" && [[ -d "${current}" ]] || return 1
    fi
  done
  chmod 0700 "${target}"
}

regular_file_is_safe() {
  local target="$1"
  path_is_safe "${target}" && [[ -f "${target}" && ! -L "${target}" ]]
}

target_is_missing_or_regular() {
  local target="$1"
  path_is_safe "${target}" || return 1
  [[ ! -e "${target}" || ( -f "${target}" && ! -L "${target}" ) ]]
}

ensure_mise_directories() {
  path_is_safe "${HOME}" && [[ -d "${HOME}" ]] || return 1
  secure_mkdir "${BOXDOWN_TOOLCHAINS_HOME}" || return 1
  secure_mkdir "${MISE_DATA_DIR}" || return 1
  secure_mkdir "${MISE_CACHE_DIR}" || return 1
  secure_mkdir "${MISE_CONFIG_DIR}" || return 1
  secure_mkdir "${MISE_STATE_DIR}" || return 1
  secure_mkdir "${HOME}/.local/bin"
}

read_plan() {
  regular_file_is_safe "${PLAN_PATH}" || return 1
  "${PLAN_NODE}" - "${PLAN_PATH}" <<'NODE'
const { lstatSync, readFileSync, statSync } = require('node:fs')
const path = process.argv[2]
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactHex = value => typeof value === 'string' && value.length === 64 && [...value].every(char => '0123456789abcdef'.includes(char))
const exactVersion = value => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
  '0123456789'.includes(value[0]) && [...value].every(char => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.+-'.includes(char))
let plan
try {
  if (lstatSync(path).isSymbolicLink() || statSync(path).size > 65536) process.exit(2)
  plan = JSON.parse(readFileSync(path, 'utf8'))
} catch {
  process.exit(2)
}
if (!isRecord(plan) || plan.version !== 1 || !exactHex(plan.fingerprint) || !Array.isArray(plan.selected) || plan.selected.length > 4) process.exit(2)
const ids = new Set()
for (const item of plan.selected) {
  if (!isRecord(item) || !['node', 'python', 'go', 'rust'].includes(item.id) || !exactVersion(item.version) || ids.has(item.id)) process.exit(2)
  ids.add(item.id)
}
process.stdout.write(`${plan.fingerprint}\n`)
for (const item of plan.selected) process.stdout.write(`${item.id}\t${item.version}\n`)
NODE
}

write_result() {
  local fingerprint="$1" state="$2" records="$3" temporary target="${RESULTS_DIR}/result.json"
  path_is_safe "${RESULTS_DIR}" || return 1
  secure_mkdir "${RESULTS_DIR}" || return 1
  target_is_missing_or_regular "${target}" || return 1
  temporary="$(mktemp "${RESULTS_DIR}/.result.json.XXXXXX")" || return 1
  chmod 0600 "${temporary}" || return 1

  if ! RESULT_FINGERPRINT="${fingerprint}" RESULT_STATE="${state}" RESULT_RECORDS="${records}" \
    "${PLAN_NODE}" - "${temporary}" <<'NODE'
const { writeFileSync } = require('node:fs')
const [target] = process.argv.slice(2)
const runtimes = process.env.RESULT_RECORDS === ''
  ? []
  : process.env.RESULT_RECORDS.split('\n').filter(Boolean).map((line) => {
      const [id, version, state, message = ''] = line.split('\t')
      return message === '' ? { id, version, state } : { id, version, state, message }
    })
writeFileSync(target, `${JSON.stringify({
  version: 1,
  fingerprint: process.env.RESULT_FINGERPRINT,
  state: process.env.RESULT_STATE,
  updatedAt: new Date().toISOString(),
  runtimes
}, null, 2)}\n`)
NODE
  then
    rm -f "${temporary}"
    return 1
  fi

  target_is_missing_or_regular "${target}" || {
    rm -f "${temporary}"
    return 1
  }
  mv -f "${temporary}" "${target}"
}

is_owned_wrapper() {
  local target="$1"
  regular_file_is_safe "${target}" || return 1
  [[ "$(sed -n '2p' "${target}")" == "${WRAPPER_MARKER}" ]]
}

write_wrapper() {
  local command="$1" runtime="$2" version="$3"
  local bin_dir="${HOME}/.local/bin" target="${HOME}/.local/bin/${command}" temporary
  secure_mkdir "${bin_dir}" || return 1
  path_is_safe "${target}" || return 1
  if [[ -e "${target}" ]] && ! is_owned_wrapper "${target}"; then
    return 1
  fi
  temporary="$(mktemp "${bin_dir}/.${command}.boxdown.XXXXXX")" || return 1
  cat > "${temporary}" <<EOF
#!/usr/bin/env bash
${WRAPPER_MARKER}
export MISE_NO_CONFIG=1
export MISE_DATA_DIR='${MISE_DATA_DIR}'
export MISE_CACHE_DIR='${MISE_CACHE_DIR}'
export MISE_CONFIG_DIR='${MISE_CONFIG_DIR}'
export MISE_STATE_DIR='${MISE_STATE_DIR}'
exec /usr/local/bin/mise --no-config exec '${runtime}@${version}' -- '${command}' "\$@"
EOF
  chmod 0755 "${temporary}" || return 1
  if [[ -e "${target}" ]] && ! is_owned_wrapper "${target}"; then
    rm -f "${temporary}"
    return 1
  fi
  path_is_safe "${target}" || return 1
  mv -f "${temporary}" "${target}"
}

write_runtime_wrappers() {
  local id="$1" version="$2" command
  local -a commands=()
  case "${id}" in
    node) commands=(node npm npx corepack) ;;
    python) commands=(python python3 pip) ;;
    go) commands=(go) ;;
    rust) commands=(cargo rustc rustup) ;;
    *) return 1 ;;
  esac
  for command in "${commands[@]}"; do
    write_wrapper "${command}" "${id}" "${version}" || return 1
  done
}

append_path_line() {
  local file="$1" path_line='export PATH="$HOME/.local/bin:$PATH"'
  target_is_missing_or_regular "${file}" || return 1
  if [[ ! -e "${file}" ]]; then
    (umask 077; : > "${file}") || return 1
  fi
  regular_file_is_safe "${file}" || return 1
  grep -Fqx "${path_line}" "${file}" || printf '%s\n' "${path_line}" >> "${file}"
}

prepend_ssh_bootstrap_lines() {
  local file="$1" temporary
  local dispatcher_line='source /opt/boxdown/devcontainer/utils/toolchains-env-bootstrap.sh'
  local path_line='export PATH="$HOME/.local/bin:$PATH"'
  local legacy_secret_line='source /opt/boxdown/devcontainer/utils/secret-env-bootstrap.sh'
  target_is_missing_or_regular "${file}" || return 1
  temporary="$(mktemp "$(dirname "${file}")/.bashrc.boxdown.XXXXXX")" || return 1
  chmod 0600 "${temporary}" || {
    rm -f "${temporary}"
    return 1
  }
  if [[ -e "${file}" ]] && ! regular_file_is_safe "${file}"; then
    rm -f "${temporary}"
    return 1
  fi
  {
    printf '%s\n' "${dispatcher_line}"
    printf '%s\n' "${path_line}"
    if [[ -e "${file}" ]]; then
      grep -Fvx -e "${dispatcher_line}" -e "${path_line}" -e "${legacy_secret_line}" "${file}" || true
    fi
  } > "${temporary}" || {
    rm -f "${temporary}"
    return 1
  }
  target_is_missing_or_regular "${file}" || {
    rm -f "${temporary}"
    return 1
  }
  mv -f "${temporary}" "${file}"
}

ensure_ssh_login_path() {
  prepend_ssh_bootstrap_lines "${HOME}/.bashrc" || return 1
  append_path_line "${HOME}/.profile" || return 1
  append_path_line "${TOOLCHAINS_BASH_ENV}" || return 1
  chmod 0600 "${TOOLCHAINS_BASH_ENV}"
}

remove_deselected_wrappers() {
  local records="$1" id command target
  local -a commands=(node npm npx corepack python python3 pip go cargo rustc rustup)
  for command in "${commands[@]}"; do
    case "${command}" in
      node|npm|npx|corepack) id=node ;;
      python|python3|pip) id=python ;;
      go) id=go ;;
      *) id=rust ;;
    esac
    grep -q "^${id}"$'\t' <<< "${records}" && continue
    target="${HOME}/.local/bin/${command}"
    path_is_safe "${target}" || return 1
    if [[ -e "${target}" ]] && is_owned_wrapper "${target}"; then
      rm -f "${target}" || return 1
    fi
  done
}

install_runtime() {
  local id="$1" version="$2"
  if [[ "${id}" == node && -x "${PLAN_NODE}" ]] && [[ "$("${PLAN_NODE}" --version 2>/dev/null)" == "v${version}" ]]; then
    return 0
  fi
  MISE_NO_CONFIG=1 /usr/local/bin/mise --no-config install "${id}@${version}"
}

workspace_targets_are_safe() {
  local candidate
  for candidate in "$@"; do
    path_is_safe "${WORKSPACE_FOLDER}/${candidate}" || return 1
  done
}

run_python_sync() {
  local requirements='' candidate
  local -a requirement_matches=()
  workspace_targets_are_safe pyproject.toml uv.lock requirements.txt requirements-dev.txt requirements || return 1
  MISE_NO_CONFIG=1 /usr/local/bin/mise --no-config install uv@0.11.32 || return 1
  if [[ -f "${WORKSPACE_FOLDER}/pyproject.toml" && -f "${WORKSPACE_FOLDER}/uv.lock" ]]; then
    (cd "${WORKSPACE_FOLDER}" && MISE_NO_CONFIG=1 /usr/local/bin/mise --no-config exec uv@0.11.32 -- uv sync)
    return
  fi
  for candidate in requirements.txt requirements-dev.txt; do
    if [[ -f "${WORKSPACE_FOLDER}/${candidate}" ]]; then
      requirements="${WORKSPACE_FOLDER}/${candidate}"
      break
    fi
  done
  if [[ -z "${requirements}" && -d "${WORKSPACE_FOLDER}/requirements" ]]; then
    shopt -s nullglob
    requirement_matches=("${WORKSPACE_FOLDER}"/requirements/*.txt)
    shopt -u nullglob
    for candidate in "${requirement_matches[@]}"; do
      regular_file_is_safe "${candidate}" || return 1
      requirements="${candidate}"
      break
    done
  fi
  [[ -n "${requirements}" ]] || return 0
  MISE_NO_CONFIG=1 /usr/local/bin/mise --no-config exec uv@0.11.32 -- uv pip install -r "${requirements}"
}

sync_runtime() {
  local id="$1"
  case "${id}" in
    node)
      workspace_targets_are_safe package.json pnpm-lock.yaml bun.lockb bun.lock yarn.lock package-lock.json pnpm-workspace.yaml bunfig.toml .yarnrc.yml || return 1
      (cd "${WORKSPACE_FOLDER}" && BOXDOWN_DEPS_INSTALL_STRICT=1 bash "${DEVCONTAINER_DIR}/utils/deps-install.sh")
      ;;
    python) run_python_sync ;;
    go)
      workspace_targets_are_safe go.mod go.sum || return 1
      (cd "${WORKSPACE_FOLDER}" && go mod download)
      ;;
    rust)
      workspace_targets_are_safe Cargo.toml Cargo.lock || return 1
      (cd "${WORKSPACE_FOLDER}" && cargo fetch)
      ;;
    *) return 1 ;;
  esac
}

main() {
  local plan_records fingerprint id version message
  local aggregate_state='succeeded' runtime_records=''

  if ! path_is_safe "${PLAN_PATH}"; then
    warn 'mounted toolchain plan path is unsafe; refusing provisioning.'
    return 0
  fi
  if [[ ! -e "${PLAN_PATH}" ]]; then
    return 0
  fi
  if ! plan_records="$(read_plan)"; then
    warn 'mounted toolchain plan is invalid; retrying on the next container start.'
    write_result 'invalid-plan' failed '' || true
    return 0
  fi
  fingerprint="${plan_records%%$'\n'*}"
  if [[ "${plan_records}" == *$'\n'* ]]; then
    plan_records="${plan_records#*$'\n'}"
  else
    plan_records=''
  fi

  if ! path_is_safe "${WORKSPACE_FOLDER}" || [[ ! -d "${WORKSPACE_FOLDER}" ]]; then
    warn 'workspace path is unavailable or unsafe; retrying on the next container start.'
    write_result "${fingerprint}" failed '' || true
    return 0
  fi
  if ! ensure_mise_directories || ! ensure_ssh_login_path || ! remove_deselected_wrappers "${plan_records}"; then
    warn 'could not prepare safe Boxdown-owned toolchain paths; retrying on the next container start.'
    write_result "${fingerprint}" failed '' || true
    return 0
  fi
  export PATH="${HOME}/.local/bin:${PATH}"

  while IFS=$'\t' read -r id version; do
    [[ -n "${id}" ]] || continue
    message=''
    if ! install_runtime "${id}" "${version}"; then
      message='mise install failed'
    elif ! write_runtime_wrappers "${id}" "${version}"; then
      message='refused to replace a non-Boxdown runtime command'
    elif ! sync_runtime "${id}"; then
      message='dependency synchronization failed'
    fi
    if [[ -n "${message}" ]]; then
      message="$(one_line "${message}")"
      runtime_records+="${id}"$'\t'"${version}"$'\t''failed'$'\t'"${message}"$'\n'
      aggregate_state='failed'
      warn "${id} ${version}: ${message}; retrying on the next container start."
    else
      runtime_records+="${id}"$'\t'"${version}"$'\t''succeeded'$'\n'
    fi
  done <<< "${plan_records}"

  write_result "${fingerprint}" "${aggregate_state}" "${runtime_records}" ||
    warn 'could not write toolchain result; retrying on the next container start.'
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
