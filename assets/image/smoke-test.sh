#!/usr/bin/env bash

set -euo pipefail

for command in node git gh rg sshd codex claude snyk op; do
  command -v "${command}" >/dev/null
done

if [ "$(uname -m)" = "x86_64" ]; then
  apm --version
else
  test -f /opt/boxdown/image-tools/apm-arm64-deferred
fi

node --version
git --version
codex --version
claude --version
snyk --version
op --version
