# SSH Config and Proxy Workflow

## Commands

```sh
boxdown ssh-config install
boxdown ssh-config install --target codex
boxdown ssh-config uninstall
boxdown ssh-proxy
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
selected alias and the matching Codex app remote project entry for the
workspace. It leaves unrelated OpenSSH config entries, unrelated Codex remote
projects, generated state, and SSH key files in place.

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

## Key Boundary

The private key stays on the host. The container receives only the public key,
mounted from a public-key-only runtime directory.
