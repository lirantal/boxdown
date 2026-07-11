# Commit signing

New Boxdown environments attempt SSH commit signing by default. Boxdown forwards
the host SSH agent, selects a signing identity only when there is one
unambiguous candidate, and keeps the private key on the host.

If the agent is unavailable, has no identities, or has multiple identities
that Boxdown cannot distinguish, Boxdown warns and configures unsigned commits.
It never guesses a key and does not block setup or commits.

The container can request operations from identities exposed by the forwarded
agent. Use a dedicated signing identity or an agent that confirms sensitive
operations when that exposure is unacceptable.

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

Git can require `gpg.ssh.allowedSignersFile` for trust-aware local verification
such as `git log --show-signature`. It is not required to create SSH signatures
or for GitHub to verify a commit.
