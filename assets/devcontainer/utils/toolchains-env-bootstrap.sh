#!/usr/bin/env bash
# BASH_ENV entrypoint: mounted code stays read-only; user state remains writable.
# This file is sourced by BASH_ENV and .bashrc. Do not change the caller's
# shell options here: interactive and noninteractive callers own those modes.
source /opt/boxdown/devcontainer/utils/secret-env-bootstrap.sh

source "${BASH_SOURCE[0]%/*}/npm-global-env.sh"
