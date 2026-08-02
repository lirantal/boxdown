#!/usr/bin/env bash
# BASH_ENV entrypoint: mounted code stays read-only; user state remains writable.
set -uo pipefail
source /opt/boxdown/devcontainer/utils/secret-env-bootstrap.sh
toolchains_env="${HOME}/.local/share/boxdown/toolchains/bash-env.sh"
if [[ -f "${toolchains_env}" && ! -L "${toolchains_env}" ]]; then
  source "${toolchains_env}"
fi
