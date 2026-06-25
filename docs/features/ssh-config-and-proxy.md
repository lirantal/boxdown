# SSH Config and Proxy Workflow

## Commands

```sh
boxdown ssh-config install
boxdown ssh-config install --target codex
boxdown ssh-config uninstall
boxdown ssh-proxy
boxdown tunnel --port 3030
```

`boxdown ssh-config` is accepted as a convenience shortcut for
`boxdown ssh-config install`, but docs use the explicit install form.

`ssh-proxy` is primarily an internal command launched by OpenSSH as a
`ProxyCommand`.

## SSH Alias Installation

By default, Boxdown creates an alias named:

```text
<repo-name>-devcontainer
```

The generated SSH config block includes:

- `User node`
- a per-workspace host identity file
- `IdentitiesOnly yes`
- a `ProxyCommand` that runs the current Boxdown installation's built CLI

The block is wrapped in Boxdown markers so repeated installs replace the managed
block instead of duplicating it.

`boxdown ssh-config uninstall` removes the Boxdown-managed marker block for the
selected alias, the matching Codex app remote project entry, and the matching
Codex persisted sidebar state for the workspace. It leaves unrelated OpenSSH
config entries, unrelated Codex remote projects, generated state, and SSH key
files in place.

`boxdown status` reports whether that Boxdown-managed block is `installed`,
`missing`, or `outdated`. It only recognizes blocks wrapped in Boxdown's marker
comments; an unrelated OpenSSH `Host` entry with the same alias is not treated
as an installed Boxdown alias.

## Codex App Target

`boxdown ssh-config install --target codex` keeps the normal SSH install flow
and also writes a Codex app remote project entry for the same alias.

The Codex app config is written to:

```text
~/.codex/codex-app/config.json
```

`BOXDOWN_CODEX_APP_CONFIG` overrides this path for tests and local development.

The generated Codex entry points at the container-side project symlink:

```json
{
  "sshAlias": "<repo-name>-devcontainer",
  "projects": [
    {
      "remotePath": "/home/node/<repo-name>",
      "label": "<repo-name>"
    }
  ]
}
```

Boxdown merges by SSH alias and normalized remote path, so repeated installs
update the existing Codex project instead of duplicating it. Existing known
Codex config keys are preserved, but unknown keys are not written back because
Codex's app config parser is strict.

Boxdown does not edit `~/.codex/.codex-global-state.json`. Restart Codex after
installing the target so Codex applies the app config, discovers the SSH alias
from normal OpenSSH config, and creates or updates its sidebar project entry.

## Proxy Flow

When OpenSSH launches `boxdown ssh-proxy`, Boxdown:

1. Quietly refreshes the SSH config block.
2. Ensures the per-workspace host key exists.
3. Reuses a running devcontainer when possible.
4. Starts the devcontainer when needed.
5. Runs a throttled coding-agent CLI update preflight inside the container.
6. Runs the container SSH bootstrap runtime.
7. Bridges OpenSSH to `/usr/sbin/sshd -i` through `docker exec -i`.

This does not publish an SSH port. The SSH stream travels through Docker exec.

The coding-agent CLI update preflight covers already-running containers, where
`postStartCommand` does not necessarily run before a new SSH session. Its output
is routed to stderr so stdout remains reserved for SSH traffic.

## Local Web Tunnels

The SSH proxy supports TCP forwarding, so Boxdown can expose a web server that is
listening only inside the devcontainer.

From the target project directory:

```sh
boxdown tunnel --port 3030
```

From another directory:

```sh
boxdown tunnel --workspace /path/to/project --port 3030
```

This starts or reuses the devcontainer, ensures the SSH alias exists, and then
keeps a foreground SSH tunnel open:

```text
127.0.0.1:3030 -> localhost:3030
```

While the tunnel is running, host browsers and the Codex in-app browser can open
`http://localhost:3030/`.

Repeat `--port` for multiple forwards. Use `<local:remote>` when the host port
should differ from the container port:

```sh
boxdown tunnel --port 3030 --port 8080:3031
```

The tunnel targets remote `localhost` rather than `127.0.0.1` so servers that
bind to the container's IPv6 loopback, such as some Slidev dev sessions, still
work.

Devcontainer `forwardPorts` is an editor hint, not a host listener in the Codex
desktop app. Docker `runArgs` / `appPort` publishing can also expose services,
but it requires the server to bind to an externally reachable container address
such as `0.0.0.0` and may require recreating the container.

Codex's own detected-port forwarding may create a random host URL such as
`http://localhost:52548/`. That is expected, but the generated SSH forward may
target remote `127.0.0.1:<port>`. If the dev server is only listening on remote
IPv6 loopback (`[::1]:<port>`), the random forwarded URL can reset even though a
listener exists. In that case, either use `boxdown tunnel --port <port>`, or
start the dev server with a host flag such as `--host 0.0.0.0`.

## Key Boundary

The private key stays on the host. The container receives only the public key,
mounted from a public-key-only runtime directory.
