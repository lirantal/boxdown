# Node SSH-Agent Proxy for Commit Signing

## Goal

Make Boxdown's default SSH commit signing usable by the container's `node`
user when Docker Desktop mounts the host agent socket as `root:root` with mode
`0660`. Signing must remain best-effort and never expose a private key.

## Root Cause

The host preflight and the raw socket mount both succeed, but lifecycle hooks
run as `node`. In the reproduced environment, `ssh-add -L` succeeds as root
and fails as `node` with `Permission denied`. The signing bootstrap therefore
sets `commit.gpgsign=false` and reports `container-agent-unavailable`.

## Architecture

Boxdown continues to bind-mount the host-facing agent socket at
`/run/boxdown/ssh-agent.sock`. A small Node Unix-socket proxy runs as root and
forwards each connection from that raw socket to
`/run/boxdown/ssh-agent-node.sock`. The proxy creates the latter socket with
ownership and permissions suitable for `node`. Generated configuration sets
`SSH_AUTH_SOCK` to the node-facing socket and exposes the raw path only through
`BOXDOWN_GIT_SIGNING_SOURCE_SOCKET` for the proxy.

The post-create hook starts the proxy with passwordless `sudo`, waits briefly
for its socket, verifies `ssh-add -L` as `node`, then invokes the existing
signing bootstrap. A proxy failure is non-blocking and has its own stable
reason code.

## Git Configuration Precedence

**Decision:** Boxdown does not make its SSH configuration authoritative over
explicit user Git signing preferences. This is intentional because the
container begins from a writable copy of the user's Git configuration.

- With no explicit global or repository-local signing preference, Boxdown
  configures SSH signing as the default.
- With an explicit SSH preference, Boxdown preserves the selected identity;
  it only translates an inaccessible host public-key path to the mounted
  public-key snapshot in the container.
- With `commit.gpgsign=false`, a non-SSH `gpg.format`, or an explicit
  `gpg.program`, Boxdown preserves that preference and does not replace it.

Repository-local settings retain Git's normal precedence. In particular, a
local `commit.gpgsign=false` keeps commits unsigned even when agent forwarding
is healthy. A future product decision may deliberately reverse this policy and
make Boxdown authoritative; that would be a behavior change, not a bug fix.

## Failure Handling

The proxy never reads, copies, or logs private-key material. It reports
`container-agent-proxy-unavailable` when `sudo`, Node, proxy readiness, or the
node-user agent probe fails. The signing bootstrap remains non-blocking and
preserves explicit user configuration rather than setting a contradictory
global value.

## Validation

Tests cover forwarding a real Unix-socket request through the proxy, a proxy
startup failure, generated socket environment values, successful default SSH
signing, and preservation of global and local user preferences. Documentation
will require `--recreate` after upgrade.
