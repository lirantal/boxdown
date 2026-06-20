# SSH Config and Proxy Workflow

## Commands

```sh
boxdown ssh-config install
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
