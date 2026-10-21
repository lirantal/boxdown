#!/usr/bin/env bash
set -euo pipefail

UTILS="${1:?utils directory required}"
NODE_BIN="${2:?node required}"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT
export HOME="${TEST_ROOT}/home"
unset NPM_CONFIG_PREFIX npm_config_prefix
export npm_config_cache="${TEST_ROOT}/npm-cache"
export npm_config_update_notifier=false
mkdir -p "${HOME}/.local/node_modules/boxdown-fixture" "${TEST_ROOT}/workspace" "${TEST_ROOT}/assets"
cd "${TEST_ROOT}/workspace"

fail() { printf 'npm global fixture: %s\n' "$*" >&2; exit 1; }

package() {
  local path="$1" name="$2" version="$3" command="$4"
  mkdir -p "${path}"
  printf '{"name":"%s","version":"%s","bin":{"%s":"cli.js"}}\n' "${name}" "${version}" "${command}" > "${path}/package.json"
  printf '#!/usr/bin/env node\nconsole.log(process.argv.includes("--runtime") ? process.env.BOXDOWN_TEST_NODE : "%s")\n' "${version}" > "${path}/cli.js"
  chmod 0755 "${path}/cli.js"
}

package "${HOME}/.local/node_modules/boxdown-fixture" boxdown-fixture 1.0.0 boxdown-fixture
printf '{"dependencies":{"boxdown-fixture":"1.0.0"}}\n' > "${HOME}/.local/package.json"
mkdir -p "${HOME}/.local/node_modules/.bin"
ln -s ../boxdown-fixture/cli.js "${HOME}/.local/node_modules/.bin/boxdown-fixture"
export PATH="${HOME}/.local/node_modules/.bin:${PATH}"
cp "${UTILS}/npm-global-env.sh" "${TEST_ROOT}/assets/"
printf 'export BOXDOWN_TEST_SECRET=present\n' > "${TEST_ROOT}/assets/secrets.sh"
sed "s#/opt/boxdown/devcontainer/utils/secret-env-bootstrap.sh#${TEST_ROOT}/assets/secrets.sh#" \
  "${UTILS}/toolchains-env-bootstrap.sh" > "${TEST_ROOT}/assets/dispatcher.sh"
export BASH_ENV="${TEST_ROOT}/assets/dispatcher.sh"

"${NODE_BIN}" "${UTILS}/npm-global-bootstrap.mjs"
source "${BASH_ENV}"
[[ "$(command -v boxdown-fixture)" == "${NPM_CONFIG_PREFIX}/bin/boxdown-fixture" ]] || fail 'image executable did not resolve through the stable global prefix'
# Run outside command substitution so Bash really caches this command.
boxdown-fixture > "${TEST_ROOT}/before"
[[ "$(cat "${TEST_ROOT}/before")" == 1.0.0 ]] || fail 'image fallback did not run'
hash -t boxdown-fixture >/dev/null || fail 'fixture did not cache the old executable'

package "${TEST_ROOT}/upgrade" boxdown-fixture 2.0.0 boxdown-fixture
package "${TEST_ROOT}/arbitrary" @boxdown/harmless 3.0.0 boxdown-harmless
npm pack "${TEST_ROOT}/upgrade" --pack-destination "${TEST_ROOT}" --ignore-scripts >/dev/null
npm pack "${TEST_ROOT}/arbitrary" --pack-destination "${TEST_ROOT}" --ignore-scripts >/dev/null
npm install -g --ignore-scripts --no-audit --no-fund "${TEST_ROOT}/boxdown-fixture-2.0.0.tgz" "${TEST_ROOT}/boxdown-harmless-3.0.0.tgz"
# No PATH assignment, new shell, or hash reset between installation and execution.
boxdown-fixture > "${TEST_ROOT}/after"
[[ "$(cat "${TEST_ROOT}/after")" == 2.0.0 ]] || fail 'cached image CLI shadowed its upgrade'
[[ "$(boxdown-harmless)" == 3.0.0 ]] || fail 'arbitrary global executable missing'
[[ "$("${NODE_BIN}" "${HOME}/.local/node_modules/boxdown-fixture/cli.js")" == 1.0.0 ]] || fail 'upgrade changed the image package'
npm ls -g --depth=0 | grep -F 'boxdown-fixture@2.0.0' >/dev/null

original_path="${PATH}"
source "${BASH_ENV}"
source "${BASH_ENV}"
[[ "${PATH}" == "${original_path}" ]] || fail 'shell startup accumulated PATH entries'
[[ "${BOXDOWN_TEST_SECRET}" == present ]] || fail 'secret dispatcher regressed'
bash -c '[[ "$(boxdown-fixture)" == 2.0.0 && "$(boxdown-harmless)" == 3.0.0 ]]' || fail 'BASH_ENV command resolution failed'
printf 'source "%s"\n' "${BASH_ENV}" > "${HOME}/.bashrc"
bash -ic '[[ "$(boxdown-fixture)" == 2.0.0 ]]' || fail 'new interactive shell resolved old executable'

# Repeated lifecycle initialization preserves user-installed packages and bins.
"${NODE_BIN}" "${UTILS}/npm-global-bootstrap.mjs"
bash -c '[[ "$(boxdown-fixture)" == 2.0.0 ]]' || fail 'restart replaced upgraded tool'

# A different selected runtime remains ahead of the stable prefix; globals use
# that runtime via their env-node shebang without inheriting a versioned prefix.
mkdir -p "${HOME}/.local/bin"
printf '#!/usr/bin/env bash\nexport BOXDOWN_TEST_NODE=selected\nexec %q "$@"\n' "${NODE_BIN}" > "${HOME}/.local/bin/node"
chmod 0755 "${HOME}/.local/bin/node"
bash -c '[[ "$(command -v node)" == "$HOME/.local/bin/node" && "$(boxdown-fixture)" == 2.0.0 && "$(boxdown-fixture --runtime)" == selected ]]' || fail 'runtime wrapper or globals lost precedence'

# Explicit npm prefix configuration is honored and does not duplicate PATH.
npm_config_prefix="${HOME}/.local" bash -c 'source "$BASH_ENV"; [[ "$NPM_CONFIG_PREFIX" == "$HOME/.local" ]]; [[ "$PATH" != *"$HOME/.local/bin:$HOME/.local/bin"* ]]' || fail 'explicit npm prefix precedence failed'

# A user-provided symlink must not redirect prefix creation outside managed state.
rm -rf "${HOME}/.local/share/boxdown/npm-global"
mkdir -p "${TEST_ROOT}/outside"
ln -s "${TEST_ROOT}/outside" "${HOME}/.local/share/boxdown/npm-global"
if "${NODE_BIN}" "${UTILS}/npm-global-bootstrap.mjs"; then fail 'unsafe prefix symlink accepted'; fi
[[ ! -e "${TEST_ROOT}/outside/bin" ]] || fail 'prefix initialization wrote through a symlink'

printf 'npm global lifecycle fixture: ok\n'
