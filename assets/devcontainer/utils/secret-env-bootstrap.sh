#!/usr/bin/env bash
# Shell bootstrap for Boxdown runtime-mounted secret environment files.

SECRET_ENV_DIR="${BOXDOWN_SECRET_ENV_DIR:-/run/boxdown/secrets}"

export_if_present() {
  local name="$1"
  local path="${SECRET_ENV_DIR}/${name}"
  local value

  [[ -r "${path}" ]] || return 0
  IFS= read -r value < "${path}" || true

  if [[ -n "${value}" ]]; then
    export "${name}=${value}"
  fi
}

# When the host runs a varlock credential proxy, this file carries placeholder
# values plus HTTP(S)_PROXY and CA-bundle wiring instead of real secrets. The
# plaintext per-secret files below are then absent by construction.
if [[ -r "${SECRET_ENV_DIR}/varlock.env" ]]; then
  # shellcheck disable=SC1091
  source "${SECRET_ENV_DIR}/varlock.env"
fi

export_if_present ANTHROPIC_API_KEY
export_if_present SNYK_TOKEN
export_if_present OP_SERVICE_ACCOUNT_TOKEN
unset value
