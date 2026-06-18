# SSH Config and Proxy Workflow

## Commands

```sh
boxdown ssh-config install
boxdown install-ssh-config
boxdown ssh-proxy
```

`install-ssh-config` is a convenience alias for `ssh-config install`.
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
- a `ProxyCommand` that runs `npx --yes boxdown ssh-proxy`

The block is wrapped in Boxdown markers so repeated installs replace the managed
block instead of duplicating it.

## Proxy Flow

When OpenSSH launches `boxdown ssh-proxy`, Boxdown:

1. Quietly refreshes the SSH config block.
2. Ensures the per-workspace host key exists.
3. Reuses a running devcontainer when possible.
4. Starts the devcontainer when needed.
5. Runs the container SSH bootstrap runtime.
6. Bridges OpenSSH to `/usr/sbin/sshd -i` through `docker exec -i`.

This does not publish an SSH port. The SSH stream travels through Docker exec.

## Key Boundary

The private key stays on the host. The container receives only the public key,
mounted from a public-key-only runtime directory.
