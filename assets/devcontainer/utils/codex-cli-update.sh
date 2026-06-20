#!/usr/bin/env bash
#
# Compatibility wrapper for the shared coding-agent CLI updater.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec bash "${SCRIPT_DIR}/coding-agent-cli-update.sh" "${1:-maybe-update}" codex
