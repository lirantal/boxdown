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

export_if_present ANTHROPIC_API_KEY
export_if_present SNYK_TOKEN
export_if_present OP_SERVICE_ACCOUNT_TOKEN
unset value
