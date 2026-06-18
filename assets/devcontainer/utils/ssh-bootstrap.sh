#!/usr/bin/env bash
#
# Container-side SSH setup for the repo-local devcontainer workflow.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_FOLDER="${BOXDOWN_CONTAINER_WORKSPACE_FOLDER:-$(cd "${SCRIPT_DIR}/../.." && pwd -P)}"
REPO_NAME="${BOXDOWN_WORKSPACE_BASENAME:-$(basename "${WORKSPACE_FOLDER}")}"
SSH_USER="${DEVCONTAINER_SSH_USER:-node}"
PUBLIC_KEY_FILE="${DEVCONTAINER_SSH_PUBLIC_KEY_FILE:-${WORKSPACE_FOLDER}/.devcontainer/.ssh/id_ed25519.pub}"
OPENSSH_CONFIGURE_TIMEOUT_SECONDS="${DEVCONTAINER_OPENSSH_CONFIGURE_TIMEOUT_SECONDS:-180}"

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

ssh_user_home() {
  getent passwd "${SSH_USER}" | cut -d: -f6
}

openssh_server_package_configured() {
  local status

  if ! command -v dpkg-query >/dev/null 2>&1; then
    return 0
  fi

  status="$(dpkg-query -W -f='${Status}' openssh-server 2>/dev/null || true)"
  [ "${status}" = "install ok installed" ]
}

openssh_server_configured() {
  [ -x /usr/sbin/sshd ] || return 1
  getent passwd sshd >/dev/null 2>&1 || return 1
  openssh_server_package_configured
}

package_manager_running() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -x apt >/dev/null 2>&1 ||
      pgrep -x apt-get >/dev/null 2>&1 ||
      pgrep -x dpkg >/dev/null 2>&1
    return $?
  fi

  ps -eo comm= | grep -Eq '^(apt|apt-get|dpkg)$'
}

configure_pending_dpkg_packages() {
  if ! command -v dpkg >/dev/null 2>&1; then
    return 1
  fi

  # Feed "no" answers so a recovering openssh-server postinst cannot block if
  # another path already generated host keys before dpkg completed.
  printf 'n\nn\nn\nn\nn\n' |
    as_root env DEBIAN_FRONTEND=noninteractive dpkg --configure -a
}

ensure_openssh_server_configured() {
  local deadline

  if openssh_server_configured; then
    return 0
  fi

  echo "ssh-bootstrap: waiting for openssh-server package configuration before generating SSH host keys." >&2
  deadline=$((SECONDS + OPENSSH_CONFIGURE_TIMEOUT_SECONDS))

  while ! openssh_server_configured; do
    if ! package_manager_running; then
      configure_pending_dpkg_packages || true
    fi

    if openssh_server_configured; then
      return 0
    fi

    if [ "${SECONDS}" -ge "${deadline}" ]; then
      echo "ssh-bootstrap: openssh-server did not finish configuring within ${OPENSSH_CONFIGURE_TIMEOUT_SECONDS}s." >&2
      if command -v dpkg-query >/dev/null 2>&1; then
        dpkg-query -W -f='ssh-bootstrap: openssh-server status: ${Status}\n' openssh-server >&2 || true
      fi
      if ! getent passwd sshd >/dev/null 2>&1; then
        echo "ssh-bootstrap: missing sshd privilege separation user." >&2
      fi
      return 1
    fi

    sleep 2
  done
}

install_openssh_server() {
  if [ ! -x /usr/sbin/sshd ]; then
    as_root apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server
  fi

  ensure_openssh_server_configured
}

install_authorized_key_if_present() {
  local user_home
  local authorized_keys
  local public_key

  if [ ! -r "${PUBLIC_KEY_FILE}" ]; then
    echo "ssh-bootstrap: no public key at ${PUBLIC_KEY_FILE}; skipping authorized_keys setup."
    return 0
  fi

  user_home="$(ssh_user_home)"
  if [ -z "${user_home}" ]; then
    echo "ssh-bootstrap: could not resolve home directory for ${SSH_USER}." >&2
    return 1
  fi

  authorized_keys="${user_home}/.ssh/authorized_keys"
  public_key="$(sed -n '1p' "${PUBLIC_KEY_FILE}")"

  as_root install -d -m 0700 -o "${SSH_USER}" -g "${SSH_USER}" "${user_home}/.ssh"
  as_root touch "${authorized_keys}"
  as_root chown "${SSH_USER}:${SSH_USER}" "${authorized_keys}"
  as_root chmod 0600 "${authorized_keys}"

  if ! as_root grep -qxF "${public_key}" "${authorized_keys}"; then
    printf '%s\n' "${public_key}" | as_root tee -a "${authorized_keys}" >/dev/null
  fi

  as_root chown "${SSH_USER}:${SSH_USER}" "${authorized_keys}"
  as_root chmod 0600 "${authorized_keys}"
}

ensure_workspace_home_symlink() {
  local user_home
  local link_path

  user_home="$(ssh_user_home)"
  if [ -z "${user_home}" ]; then
    echo "ssh-bootstrap: could not resolve home directory for ${SSH_USER}." >&2
    return 1
  fi

  link_path="${user_home}/${REPO_NAME}"

  if [ -e "${link_path}" ] && [ ! -L "${link_path}" ]; then
    echo "ssh-bootstrap: ${link_path} already exists and is not a symlink; leaving it unchanged." >&2
    return 0
  fi

  as_root ln -sfn "${WORKSPACE_FOLDER}" "${link_path}"
  as_root chown -h "${SSH_USER}:${SSH_USER}" "${link_path}"
}

ensure_runtime_ready() {
  if [ ! -x /usr/sbin/sshd ]; then
    echo "ssh-bootstrap: /usr/sbin/sshd is missing. Recreate the devcontainer so post-create installs openssh-server." >&2
    return 1
  fi

  ensure_openssh_server_configured
  as_root ssh-keygen -A
  as_root install -d -m 0755 /run/sshd
  install_authorized_key_if_present
  ensure_workspace_home_symlink
  as_root /usr/sbin/sshd -t \
    -o PubkeyAuthentication=yes \
    -o PasswordAuthentication=no \
    -o KbdInteractiveAuthentication=no \
    -o AllowTcpForwarding=yes \
    -o AllowStreamLocalForwarding=yes \
    -o PermitTTY=yes
}

main() {
  case "${1:-runtime}" in
    install)
      install_openssh_server
      ;;
    runtime)
      ensure_runtime_ready
      ;;
    all)
      install_openssh_server
      ensure_runtime_ready
      ;;
    *)
      echo "Usage: $(basename "$0") [install|runtime|all]" >&2
      return 1
      ;;
  esac
}

main "$@"
