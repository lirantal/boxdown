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
