# Commit signing

New Boxdown environments attempt SSH commit signing by default. Boxdown forwards
the host SSH agent, selects a signing identity only when there is one
unambiguous candidate, and keeps the private key on the host.

If the agent is unavailable, has no identities, or has multiple identities
that Boxdown cannot distinguish, Boxdown warns and configures unsigned commits.
It never guesses a key and does not block setup or commits.

Signing readiness is resolved when generated devcontainer configuration is
written. A container created while readiness is unavailable does not gain an
SSH-agent mount later; recreate it after correcting the warning:

```bash
boxdown setup --workspace /path/to/project --recreate
```

The container can request operations from identities exposed by the forwarded
agent. Use a dedicated signing identity or an agent that confirms sensitive
operations when that exposure is unacceptable.

On Docker Desktop, Boxdown places a small root-owned relay between the
host-facing agent socket and the non-root container user. The relay exposes no
private-key material and lets normal `node`-user Git commits reach the host
agent.

GitHub verification is separate from signing. Upload the selected public key as
a GitHub SSH signing key once to receive the Verified badge:

```bash
gh ssh-key add /path/to/signing-key.pub --type signing --title "Boxdown commit signing"
```

The same key may already be registered for GitHub SSH authentication; GitHub
requires a second registration with type `signing`.

## Optional: configure SSH signing on the host

Boxdown can sign commits without changing the host Git configuration. The
container uses the selected identity from the host SSH agent directly. Configure
the host as well when you also make commits outside Boxdown, or when you want
to make the selected Boxdown identity explicit.

First, verify the intended identity is loaded in the SSH agent. `ssh-add -l`
prints loaded key fingerprints:

```bash
ssh-add -l
```

Then configure Git to use that public key for SSH signing:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global --unset-all gpg.program || true
git config --global commit.gpgsign true
```

Replace `~/.ssh/id_ed25519.pub` with the selected public key when you use a
different identity. The public key must also be registered with GitHub as a
Signing key for pushed commits to display the Verified badge.

Boxdown accepts `user.signingkey` as an inline SSH public key, a `key::` public
key, an absolute path, a `~/` path, or a path relative to the workspace. Only
public-key files are read. An explicitly configured key is authoritative: if
it is unreadable, invalid, or absent from the SSH agent, Boxdown disables
signing instead of selecting another identity.

## User configuration precedence

Boxdown defaults to SSH signing only when Git has no explicit signing
preference. A repository-local `commit.gpgsign=false`, a non-SSH `gpg.format`,
or an explicit `gpg.program` is preserved. Explicit SSH signing remains
supported; Boxdown maps an inaccessible host public-key path to the selected
public-key snapshot inside the container. This policy is intentional and may
be revisited in a future release if Boxdown becomes authoritative.

Git can require `gpg.ssh.allowedSignersFile` for trust-aware local verification
such as `git log --show-signature`. It is not required to create SSH signatures
or for GitHub to verify a commit.

## GPG and WSL

Boxdown's automatic signing integration supports SSH signing through the host
SSH agent. When Git is configured for GPG/OpenPGP signing, Boxdown preserves
that configuration but warns during lifecycle setup and in `boxdown doctor`:
the default image does not include GnuPG or GPG-agent forwarding, so commits in
the container may fail to sign. The warning is non-blocking and does not change
Git configuration.

Detection respects repository-local Git configuration as well as global
configuration. It also recognizes the standard Git boolean spellings for
`commit.gpgsign`, including `true`, `yes`, `on`, and `1`.

A custom devcontainer image may provide its own GPG and GPG-agent integration.
Boxdown does not mount `~/.gnupg`, copy private keys, forward a GPG agent, or
validate custom GPG integrations.

For the supported SSH-signing path in WSL, confirm that the WSL environment can
reach a running SSH agent and that the intended identity is loaded:

```bash
ssh-add -l
printf '%s\n' "$SSH_AUTH_SOCK"
```

After correcting SSH-agent availability or identity selection, recreate the
container so its create-time SSH-agent mount can be updated.

## Troubleshooting

Signing failures remain non-blocking. User-facing lifecycle commands print a
concise reason, while the workspace `boxdown.log` records a stable reason code
and sanitized diagnostic detail. Container validation further distinguishes a
missing mounted public key, an unavailable forwarded agent, a selected key that
is not loaded, and a failed disposable signed-commit probe.

Run `boxdown doctor --workspace /path/to/project` to recheck host identity
selection and GitHub signing-key registration. After fixing the reported
condition, use `--recreate`; existing unsigned commits are not rewritten.
