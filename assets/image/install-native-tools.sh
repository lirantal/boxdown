#!/usr/bin/env bash

set -euo pipefail

architecture="${1:-}"
lock_path="${2:-}"

if [ "$#" -ne 2 ]; then
  echo "usage: install-native-tools.sh <amd64|arm64> <lock-path>" >&2
  exit 2
fi

case "${architecture}" in
  amd64 | arm64) ;;
  *)
    echo "unsupported architecture: ${architecture}" >&2
    exit 2
    ;;
esac

if [ ! -f "${lock_path}" ]; then
  echo "native tool lock does not exist: ${lock_path}" >&2
  exit 2
fi

lock_values="$(
  node - "${lock_path}" "${architecture}" <<'NODE'
const { readFileSync } = require('node:fs')

const lockPath = process.argv[2]
const architecture = process.argv[3]
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const sha256 = /^[a-f0-9]{64}$/

function artifact(tool, arch) {
  const value = lock[tool]?.artifacts?.[arch]
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.url !== 'string' ||
    !value.url.startsWith('https://') ||
    typeof value.sha256 !== 'string' ||
    !sha256.test(value.sha256)
  ) {
    throw new Error(`invalid ${tool} artifact for ${arch}`)
  }
  if (/[\t\r\n]/.test(value.url)) throw new Error(`invalid ${tool} URL for ${arch}`)
  return value
}

if (lock.schemaVersion !== 1) throw new Error('unsupported native tool lock schema')

const onepassword = artifact('onepassword', architecture)
let apmUrl = ''
let apmSha256 = ''

if (architecture === 'amd64') {
  const apm = artifact('apm', architecture)
  apmUrl = apm.url
  apmSha256 = apm.sha256
} else if (
  lock.apm?.artifacts?.arm64 !== undefined ||
  !Array.isArray(lock.apm?.deferredPlatforms) ||
  !lock.apm.deferredPlatforms.includes('arm64')
) {
  throw new Error('APM must be explicitly deferred on arm64')
}

process.stdout.write([
  onepassword.url,
  onepassword.sha256,
  apmUrl,
  apmSha256
].join('\t'))
NODE
)"

IFS=$'\t' read -r onepassword_url onepassword_sha256 apm_url apm_sha256 <<<"${lock_values}"
if [ -z "${onepassword_url}" ] || [ -z "${onepassword_sha256}" ]; then
  echo "native tool lock is missing required values" >&2
  exit 2
fi
if [ "${architecture}" = "amd64" ] && { [ -z "${apm_url}" ] || [ -z "${apm_sha256}" ]; }; then
  echo "native tool lock is missing the AMD64 APM artifact" >&2
  exit 2
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "${temporary_directory}"' EXIT

download_and_verify() {
  local url="$1"
  local checksum="$2"
  local destination="$3"

  curl --fail --location --silent --show-error "${url}" --output "${destination}"
  printf '%s  %s\n' "${checksum}" "${destination}" | sha256sum --check --status
}

onepassword_archive="${temporary_directory}/onepassword.zip"
download_and_verify "${onepassword_url}" "${onepassword_sha256}" "${onepassword_archive}"
unzip -Z1 "${onepassword_archive}" | grep -Fxq op
unzip -p "${onepassword_archive}" op >"${temporary_directory}/op"
install -m 0755 "${temporary_directory}/op" /usr/local/bin/op

if [ "${architecture}" = "amd64" ]; then
  apm_archive="${temporary_directory}/apm.tar.gz"
  apm_install_directory="/opt/boxdown/image-tools/apm"
  download_and_verify "${apm_url}" "${apm_sha256}" "${apm_archive}"
  tar -tzf "${apm_archive}" apm-linux-x86_64/apm >/dev/null
  mkdir -p "${apm_install_directory}"
  tar -xzf "${apm_archive}" \
    --directory "${apm_install_directory}" \
    --strip-components=1 \
    apm-linux-x86_64
  test -x "${apm_install_directory}/apm"
  ln -s "${apm_install_directory}/apm" /usr/local/bin/apm
else
  marker="/opt/boxdown/image-tools/apm-arm64-deferred"
  printf '%s\n' 'APM has no supported native ARM64 artifact; installation is deferred.' >"${marker}"
  chmod 0444 "${marker}"
fi
