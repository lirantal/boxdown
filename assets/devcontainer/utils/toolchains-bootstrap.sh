#!/usr/bin/env bash
# Provision the user-approved workspace toolchains without consulting repository mise files.

set -uo pipefail

DEVCONTAINER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLAN_PATH="${BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH:-/opt/boxdown/state/toolchains/plan/plan.json}"
RESULTS_DIR="${BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR:-/opt/boxdown/state/toolchain-results}"
# Default atomic target: /opt/boxdown/state/toolchain-results/result.json
WORKSPACE_FOLDER="${BOXDOWN_CONTAINER_WORKSPACE_FOLDER:-$PWD}"
BOXDOWN_TOOLCHAINS_HOME="${HOME}/.local/share/boxdown/toolchains"
PLAN_NODE="${BOXDOWN_PLAN_NODE:-/usr/local/bin/node}"
MISE_BIN='/usr/local/bin/mise'

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

ensure_mise_directories() {
  mkdir -p "${MISE_DATA_DIR}" "${MISE_CACHE_DIR}" "${MISE_CONFIG_DIR}" "${MISE_STATE_DIR}"
}

read_plan() {
  [[ "${PLAN_PATH}" = /* && -f "${PLAN_PATH}" && ! -L "${PLAN_PATH}" ]] || return 1
  "${PLAN_NODE}" - "${PLAN_PATH}" <<'NODE'
const { lstatSync, readFileSync } = require('node:fs')
const path = process.argv[2]
let plan
try {
  if (lstatSync(path).isSymbolicLink()) process.exit(2)
  plan = JSON.parse(readFileSync(path, 'utf8'))
} catch {
  process.exit(2)
}
if (plan.version !== 1 || !Array.isArray(plan.selected) || !/^[a-f0-9]{64}$/.test(plan.fingerprint) || plan.selected.length > 4) process.exit(2)
const ids = new Set()
for (const item of plan.selected) {
  if (item === null || typeof item !== 'object' || !['node', 'python', 'go', 'rust'].includes(item.id) ||
      typeof item.version !== 'string' || !/^[0-9][0-9A-Za-z.+-]*$/.test(item.version) || ids.has(item.id)) process.exit(2)
  ids.add(item.id)
}
process.stdout.write(`${plan.fingerprint}\n`)
for (const item of plan.selected) process.stdout.write(`${item.id}\t${item.version}\n`)
NODE
}

write_result() {
  local fingerprint="$1"
  local state="$2"
  local records="$3"
  local temporary

  if [[ "${RESULTS_DIR}" != /* ]]; then
    warn 'toolchain result directory is not absolute; cannot record result.'
    return 1
  fi
  mkdir -p "${RESULTS_DIR}" || return 1
  if [[ -L "${RESULTS_DIR}" || ! -d "${RESULTS_DIR}" ]]; then
    warn 'toolchain result directory is not a safe directory; cannot record result.'
    return 1
  fi
  temporary="$(mktemp "${RESULTS_DIR}/.result.json.XXXXXX")" || return 1

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
}, null, 2)}\n`, { mode: 0o600 })
NODE
  then
    rm -f "${temporary}"
    return 1
  fi

  mv -f "${temporary}" "${RESULTS_DIR}/result.json"
}

write_wrapper() {
  local command="$1"
  local runtime="$2"
  local version="$3"
  local bin_dir="${HOME}/.local/bin"
  local target="${bin_dir}/${command}"
  local temporary

  mkdir -p "${bin_dir}" || return 1
  [[ ! -L "${bin_dir}" && ! -L "${target}" ]] || return 1
  temporary="$(mktemp "${bin_dir}/.${command}.boxdown.XXXXXX")" || return 1
  cat > "${temporary}" <<EOF
#!/usr/bin/env bash
export MISE_NO_CONFIG=1
export MISE_DATA_DIR='${MISE_DATA_DIR}'
export MISE_CACHE_DIR='${MISE_CACHE_DIR}'
export MISE_CONFIG_DIR='${MISE_CONFIG_DIR}'
export MISE_STATE_DIR='${MISE_STATE_DIR}'
exec /usr/local/bin/mise --no-config exec '${runtime}@${version}' -- '${command}' "\$@"
EOF
  chmod 0755 "${temporary}" && mv -f "${temporary}" "${target}"
}

write_runtime_wrappers() {
  local id="$1"
  local version="$2"
  local command
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

ensure_ssh_login_path() {
  local file
  local path_line='export PATH="$HOME/.local/bin:$PATH"'

  for file in "${HOME}/.bashrc" "${HOME}/.profile"; do
    touch "${file}" || return 1
    grep -Fqx "${path_line}" "${file}" || printf '%s\n' "${path_line}" >> "${file}"
  done
  if [[ -n "${BASH_ENV:-}" && "${BASH_ENV}" = /* && ! -L "${BASH_ENV}" ]]; then
    touch "${BASH_ENV}" || return 1
    grep -Fqx "${path_line}" "${BASH_ENV}" || printf '%s\n' "${path_line}" >> "${BASH_ENV}"
  fi
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
    if [[ -f "${target}" && ! -L "${target}" ]] && grep -Fq '/usr/local/bin/mise --no-config exec' "${target}"; then
      rm -f "${target}"
    fi
  done
}

install_runtime() {
  local id="$1"
  local version="$2"

  if [[ "${id}" == node ]] && [[ -x "${PLAN_NODE}" ]] && [[ "$("${PLAN_NODE}" --version 2>/dev/null)" == "v${version}" ]]; then
    return 0
  fi
  MISE_NO_CONFIG=1 /usr/local/bin/mise --no-config install "${id}@${version}"
}

run_python_sync() {
  local requirements=''
  local candidate
  local -a requirement_matches=()

  MISE_NO_CONFIG=1 /usr/local/bin/mise --no-config install uv@0.11.32 || return 1
  if [[ -f "${WORKSPACE_FOLDER}/pyproject.toml" && ! -L "${WORKSPACE_FOLDER}/pyproject.toml" &&
        -f "${WORKSPACE_FOLDER}/uv.lock" && ! -L "${WORKSPACE_FOLDER}/uv.lock" ]]; then
    (cd "${WORKSPACE_FOLDER}" && MISE_NO_CONFIG=1 /usr/local/bin/mise --no-config exec uv@0.11.32 -- uv sync)
    return
  fi
  for candidate in requirements.txt requirements-dev.txt; do
    if [[ -f "${WORKSPACE_FOLDER}/${candidate}" && ! -L "${WORKSPACE_FOLDER}/${candidate}" ]]; then
      requirements="${WORKSPACE_FOLDER}/${candidate}"
      break
    fi
  done
  if [[ -z "${requirements}" && -d "${WORKSPACE_FOLDER}/requirements" && ! -L "${WORKSPACE_FOLDER}/requirements" ]]; then
    shopt -s nullglob
    requirement_matches=("${WORKSPACE_FOLDER}"/requirements/*.txt)
    shopt -u nullglob
    for candidate in "${requirement_matches[@]}"; do
      if [[ -f "${candidate}" && ! -L "${candidate}" ]]; then
        requirements="${candidate}"
        break
      fi
    done
  fi
  [[ -n "${requirements}" ]] || return 0
  MISE_NO_CONFIG=1 /usr/local/bin/mise --no-config exec uv@0.11.32 -- uv pip install -r "${requirements}"
}

sync_runtime() {
  local id="$1"
  case "${id}" in
    node) (cd "${WORKSPACE_FOLDER}" && bash "${DEVCONTAINER_DIR}/utils/deps-install.sh") ;;
    python) run_python_sync ;;
    go) (cd "${WORKSPACE_FOLDER}" && go mod download) ;;
    rust) (cd "${WORKSPACE_FOLDER}" && cargo fetch) ;;
    *) return 1 ;;
  esac
}

main() {
  local plan_records fingerprint record id version message
  local aggregate_state='succeeded'
  local runtime_records=''

  if [[ ! -e "${PLAN_PATH}" ]]; then
    return 0
  fi
  if ! plan_records="$(read_plan)"; then
    warn 'mounted toolchain plan is missing or invalid; retrying on the next container start.'
    write_result 'invalid-plan' failed '' || true
    return 0
  fi
  fingerprint="${plan_records%%$'\n'*}"
  plan_records="${plan_records#*$'\n'}"

  if [[ ! -d "${WORKSPACE_FOLDER}" || -L "${WORKSPACE_FOLDER}" ]]; then
    warn 'workspace path is unavailable or a symlink; retrying on the next container start.'
    write_result "${fingerprint}" failed '' || true
    return 0
  fi
  if ! ensure_mise_directories || ! ensure_ssh_login_path; then
    warn 'could not prepare Boxdown-owned toolchain directories; retrying on the next container start.'
    write_result "${fingerprint}" failed '' || true
    return 0
  fi
  export PATH="${HOME}/.local/bin:${PATH}"
  remove_deselected_wrappers "${plan_records}"

  while IFS=$'\t' read -r id version; do
    [[ -n "${id}" ]] || continue
    message=''
    if ! install_runtime "${id}" "${version}"; then
      message='mise install failed'
    elif ! write_runtime_wrappers "${id}" "${version}"; then
      message='could not create runtime wrappers'
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

main "$@"
