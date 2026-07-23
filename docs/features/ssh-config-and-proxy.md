# SSH Config and Proxy Workflow

## Commands

```sh
boxdown setup --target codex
boxdown setup --target claude
boxdown ssh install
boxdown ssh install --target codex
boxdown ssh install --target claude
boxdown ssh uninstall --target claude
boxdown ssh uninstall --target codex --target claude
boxdown ssh uninstall
boxdown ssh-proxy
boxdown tunnel --port 3030
```

`boxdown ssh` is accepted as a convenience shortcut for
`boxdown ssh install`, but docs use the explicit install form.
`boxdown setup` is the higher-level workflow when you also want to start or
recreate the devcontainer before installing the SSH alias.

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

When `boxdown ssh install` runs without `--target` in an interactive terminal,
Boxdown asks which optional install targets to update in addition to the SSH
alias. The menu supports selecting multiple targets or skipping all optional
targets. In non-interactive contexts, Boxdown skips optional targets instead of
blocking and prints the explicit `--target` form for scripts.

`boxdown ssh uninstall` has two cleanup modes:

| Invocation | SSH alias block | Removed integrations |
| --- | --- | --- |
| `boxdown ssh uninstall --target claude` | Preserved | Claude only |
| `boxdown ssh uninstall --target codex --target claude` | Preserved | Codex and Claude |
| `boxdown ssh uninstall` | Removed | All registered targets |

`--target` is repeatable. Supplying every known target is still targeted mode,
so the Boxdown-managed SSH alias remains in place. Only an unqualified
uninstall removes the alias. Targeted cleanup removes only the selected app
integration; complete cleanup removes the marker block for the selected alias
and every registered integration. Both modes leave unrelated OpenSSH config
entries, unrelated app projects, generated state, and SSH key files in place.

`boxdown status` reports whether that Boxdown-managed block is `installed`,
`missing`, or `outdated`. It only recognizes blocks wrapped in Boxdown's marker
comments; an unrelated OpenSSH `Host` entry with the same alias is not treated
as an installed Boxdown alias.

## Codex App Target

Selecting Codex from the interactive prompt or running
`boxdown ssh install --target codex` keeps the normal SSH install flow and also
writes a Codex app remote project entry for the same alias. `--target` is
repeatable so future optional SSH install targets can be combined in one
install command.

The Codex app config is written to:

```text
~/.codex/codex-app/config.json
```

`BOXDOWN_CODEX_APP_CONFIG` overrides this path for tests and local development.

The generated Codex entry points at the canonical container workspace path:

```json
{
  "sshAlias": "<repo-name>-devcontainer",
  "projects": [
    {
      "remotePath": "/workspaces/<repo-name>",
      "label": "<repo-name>"
    }
  ]
}
```

Boxdown merges by SSH alias and normalized remote path, so repeated installs
update the existing Codex project instead of duplicating it. If an older
Boxdown install registered `/home/node/<repo-name>`, the next Codex target
install migrates that entry to `/workspaces/<repo-name>`. Existing known Codex
config keys are preserved, but unknown keys are not written back because
Codex's app config parser is strict.

Boxdown normalizes matching Codex sidebar state for the same SSH alias when it
installs the Codex target. Restart Codex after installing the target so Codex
applies the app config, discovers the SSH alias from normal OpenSSH config, and
creates or updates its sidebar project entry.

## Claude App Target

Selecting Claude from the interactive prompt or running
`boxdown ssh install --target claude` keeps the normal SSH install flow and also
writes a Claude app SSH remote entry for the same alias. `--target` is
repeatable, so `codex` and `claude` can be installed in one command.

The Claude SSH config is written to:

```text
~/Library/Application Support/Claude/ssh_configs.json
```

`BOXDOWN_CLAUDE_SSH_CONFIGS` overrides this path for tests and local
development.

The generated Claude entry mirrors the desktop app's SSH remote shape:

```json
{
  "configs": [
    {
      "name": "<repo-name>",
      "sshHost": "<repo-name>-devcontainer",
      "id": "<uuid>",
      "source": "desktop"
    }
  ],
  "trustedHosts": [
    "<repo-name>-devcontainer"
  ]
}
```

Boxdown merges by `sshHost`, preserves an existing Claude remote ID, and adds
the alias to `trustedHosts`. Restart Claude after installing the target so the
app applies the SSH remote entry.

## Proxy Flow

When OpenSSH launches `boxdown ssh-proxy`, Boxdown:

1. Quietly refreshes the SSH config block.
2. Ensures the per-workspace host key exists.
3. Reuses a running devcontainer when possible.
4. Starts the devcontainer when needed.
5. Runs a throttled default coding-agent CLI update preflight inside the
   container.
6. Runs the container SSH bootstrap runtime.
7. Bridges OpenSSH to `/usr/sbin/sshd -i` through `docker exec -i`.

This does not publish an SSH port. The SSH stream travels through Docker exec.

Boxdown augments child-process `PATH` with common macOS GUI-missing tool
locations, including `/usr/local/bin`, Homebrew paths, `~/.docker/bin`, and
Docker Desktop's bundled CLI directory. This lets GUI apps such as Claude launch
the SSH proxy through OpenSSH even when their launchd environment cannot
resolve `docker` by default.

The default coding-agent CLI update preflight covers Codex and Claude Code in
already-running containers, where `postStartCommand` does not necessarily run
before a new SSH session. OpenCode and Antigravity remain lazy installs through
their direct `boxdown` commands. The preflight output is routed to stderr so
stdout remains reserved for SSH traffic.

SSH proxy startup uses the same concise progress protocol as `setup` and
`start`, but routes progress and failure summaries to stderr because stdout is
reserved for the SSH stream. Use `boxdown ssh-proxy --verbose` only for manual
debugging.

## Local Web Tunnels

The SSH proxy supports TCP forwarding, so Boxdown can expose a web server that is
listening only inside the devcontainer.

From the target project directory:

```sh
boxdown tunnel --port 3030
```

When `--port` is omitted in an interactive terminal, Boxdown prompts for one or
more port mappings. Pressing Enter accepts the generated devcontainer published
port when Boxdown can read one from the config, currently `3000`. Non-TTY and
CI runs keep requiring an explicit `--port`.

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

Tunnel setup also hides raw devcontainer startup logs by default; pass
`--verbose` before the foreground tunnel opens when debugging startup.

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

## IPv4 and IPv6 Loopback Options

The Codex detected-port issue is not an `/etc/hosts` problem. `/etc/hosts` maps
names such as `localhost` to addresses, but a generated SSH forward that targets
remote `127.0.0.1:<port>` uses a numeric IP literal. No name lookup happens, so
changing the container's `localhost` entry would not make `127.0.0.1` reach a
server that is listening only on `[::1]`.

Potential Boxdown-side approaches:

1. Inject a Node.js IPv4 preference.

   Boxdown could add this to the generated devcontainer environment:

   ```sh
   NODE_OPTIONS=--dns-result-order=ipv4first
   ```

   This would likely make Node-based dev servers such as Vite and Slidev resolve
   `localhost` to `127.0.0.1` first, causing Codex's generated
   `127.0.0.1:<port>` forward to work without app-specific flags.

   This is the smallest built-in fix to evaluate, but it mainly helps Node.js
   tools. It would not normalize loopback behavior for dev servers written in
   other runtimes.

2. Run a Boxdown-managed loopback bridge inside the container.

   A background helper could detect a listener on `[::1]:<port>` where
   `127.0.0.1:<port>` is not listening, then bind `127.0.0.1:<port>` and proxy
   traffic to `[::1]:<port>`.

   This would be runtime-agnostic and would let Codex's generated
   `127.0.0.1:<port>` forwards work for more tools. The tradeoff is a more
   complex container-side service: it would need port discovery, race handling,
   conflict handling, lifecycle cleanup, and clear diagnostics.

3. Keep `boxdown tunnel` as the explicit escape hatch.

   The current `boxdown tunnel --port <port>` command creates Boxdown's own SSH
   local forward and targets remote `localhost:<port>` rather than remote
   `127.0.0.1:<port>`. That covers dev servers bound to IPv6 loopback,
   IPv4 loopback, or all interfaces, as long as the remote `localhost` name
   resolves to a reachable address for that server.

   This is reliable and fully under Boxdown's control, but it requires an extra
   foreground command. It is useful as a debugging and fallback path, not a
   fully automatic browser-forwarding experience.

## Key Boundary

The private key stays on the host. The container receives only the public key,
mounted from a public-key-only runtime directory.
