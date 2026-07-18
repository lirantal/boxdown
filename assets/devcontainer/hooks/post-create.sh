#!/bin/bash
set -e

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVCONTAINER_DIR="$(cd "${HOOKS_DIR}/.." && pwd)"

main() {
  run_step "Configuring global Git" configure_global_git
  run_step "Configuring Git commit signing" configure_git_signing
  run_step "Configuring workspace Git" configure_local_git
  run_step "Configuring runtime secret environment" configure_runtime_secret_environment
  run_step "Installing OpenSSH server" install_openssh_server
  run_step "Installing Python runtime" install_python_runtime
  run_step "Installing Agent Package Manager" install_apm
  run_step "Installing coding-agent CLIs" install_or_update_coding_agent_clis
  run_step "Installing 1Password CLI" install_1password_cli
  run_step "Installing Snyk CLI" install_snyk_cli
  run_step "Installing workspace dependencies" run_deps_install
}

progress() {
  if [[ "${BOXDOWN_PROGRESS:-0}" == "1" ]]; then
    printf 'BOXDOWN_PROGRESS: %s\n' "$*"
  fi
}

run_step() {
  local label="$1"
  shift

  progress "$label"
  "$@"
}

configure_global_git() {
  bash "${DEVCONTAINER_DIR}/utils/git-config-bootstrap.sh"
}

configure_git_signing() {
  bash "${DEVCONTAINER_DIR}/utils/git-signing-bootstrap.sh"
}

configure_local_git() {
  # Local git prefs only apply inside a repository; skip when there is no .git (avoids postCreate failure).
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git config --local --replace-all core.pager 'less -R'
    git config --local --unset-all credential.https://github.com.helper >/dev/null 2>&1 || true
    git config --local --add credential.https://github.com.helper ''
    git config --local --add credential.https://github.com.helper '!gh auth git-credential'
  fi
}

configure_runtime_secret_environment() {
  local bashrc="${HOME}/.bashrc"
  local source_line='source /opt/boxdown/devcontainer/utils/secret-env-bootstrap.sh'

  touch "${bashrc}"
  if ! grep -Fqx "${source_line}" "${bashrc}"; then
    printf '%s\n' "${source_line}" >> "${bashrc}"
  fi
}

install_apm() {
  # Agent Package Manager: https://github.com/microsoft/apm
  local installer

  installer="$(mktemp)"
  if ! curl -fsSL https://aka.ms/apm-unix -o "${installer}"; then
    rm -f "${installer}"
    echo "post-create: warning: could not download APM installer; skipping APM." >&2
    return 0
  fi

  if ! sh "${installer}"; then
    rm -f "${installer}"
    echo "post-create: warning: APM installer failed; skipping APM." >&2
    return 0
  fi

  rm -f "${installer}"
}

install_or_update_coding_agent_clis() {
  bash "${DEVCONTAINER_DIR}/utils/coding-agent-cli-update.sh" install ||
    echo "post-create: warning: one or more coding-agent CLI refreshes failed." >&2
}

install_openssh_server() {
  bash "${DEVCONTAINER_DIR}/utils/ssh-bootstrap.sh" install
}

install_python_runtime() {
  bash "${DEVCONTAINER_DIR}/utils/python-bootstrap.sh" install
}

install_snyk_cli() {
  # https://docs.snyk.io/snyk-cli/install-the-snyk-cli
  local url
  case "$(uname -m)" in
    aarch64 | arm64) url="https://static.snyk.io/cli/latest/snyk-linux-arm64" ;;
    x86_64 | amd64) url="https://static.snyk.io/cli/latest/snyk-linux" ;;
    *)
      echo "post-create: skipping Snyk CLI (unsupported arch: $(uname -m))" >&2
      return 0
      ;;
  esac
  curl --compressed -fsSL "${url}" -o /tmp/snyk
  chmod +x /tmp/snyk
  sudo mv -f /tmp/snyk /usr/local/bin/snyk
}

install_1password_cli() {
  local op_version="2.32.1"
  local op_arch

  case "$(uname -m)" in
    aarch64 | arm64) op_arch="arm64" ;;
    x86_64 | amd64) op_arch="amd64" ;;
    *)
      echo "post-create: skipping 1Password CLI (unsupported arch: $(uname -m))" >&2
      return 0
      ;;
  esac

  curl -fsSL "https://cache.agilebits.com/dist/1P/op2/pkg/v${op_version}/op_linux_${op_arch}_v${op_version}.zip" -o /tmp/op.zip
  python3 -c "import zipfile; zipfile.ZipFile('/tmp/op.zip').extract('op', '/tmp')"
  sudo mv /tmp/op /usr/local/bin/op && chmod +x /usr/local/bin/op && rm /tmp/op.zip
}

run_deps_install() {
  bash "${DEVCONTAINER_DIR}/utils/deps-install.sh"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
