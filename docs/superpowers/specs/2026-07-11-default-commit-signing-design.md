# Default Commit Signing Design

## Summary

Boxdown will attempt to enable SSH commit signing by default in every newly
created environment. It will forward the host SSH agent into the container,
select a signing identity without user interaction when that choice is
unambiguous, and configure container-global Git settings for SSH signing.

Signing is best-effort. If Boxdown cannot select or use a signing identity, it
will warn, disable signing in the container-global Git configuration, and allow
unsigned commits. Signing readiness will never make `boxdown setup` fail.

This design applies only to newly created Boxdown environments. It does not
migrate existing containers or repair repository-local Git settings written by
older Boxdown versions.

## Goals

- Sign commits by default without a separate Boxdown signing setup command.
- Keep private signing keys on the host and expose only an agent-backed signing
  capability to the container.
- Provide the same signing capability through `boxdown setup`, `start`,
  `codex`, `claude`, `opencode`, `antigravity`, SSH proxy, and tunnel flows.
- Continue allowing commits when signing cannot be configured or validated.
- Detect signing problems in `boxdown doctor` and the setup preflight without
  making signing readiness a setup prerequisite.
- Explain the difference between a cryptographically signed commit and a
  commit that GitHub displays as Verified.

## Non-goals

- Migrating existing Boxdown environments or legacy `.git/config` values.
- Copying a private GPG or SSH key into a container or Boxdown state.
- Automatically changing the user's GitHub account or registering signing
  keys without explicit user action.
- Guaranteeing that a host agent remains available after an interactive
  session has started.
- Intercepting `git commit` and automatically retrying it with
  `--no-gpg-sign`.

## Approaches Considered

### SSH signing through the Docker agent bridge

This is the selected approach. Docker Desktop exposes the host SSH agent to a
container through `/run/host-services/ssh-auth.sock`, while native Linux Docker
can bind-mount the host path in `SSH_AUTH_SOCK`. Git supports signing through
that agent with `gpg.format=ssh`.

This approach works for both SSH sessions and Boxdown's primary
`devcontainer exec` execution path. It does not copy private key material.

### GPG-agent forwarding over SSH

GPG-agent forwarding was validated successfully, but the forwarded socket
exists only during an SSH connection. Boxdown launches shells and coding-agent
CLIs through `devcontainer exec`, so GPG forwarding would require an additional
long-lived host proxy and remote socket lifecycle management. It is not the
default design.

### Container-owned signing key

A key persisted in Boxdown state would remain available independently of the
host agent, but the container could read and copy the private key. Every new
key would also require GitHub registration. This weakens Boxdown's isolation
boundary and is rejected.

## Signing Policy

Signing is default-on but best-effort:

1. Boxdown attempts to resolve one host SSH signing identity.
2. Boxdown attempts to expose the host agent to the container.
3. The container verifies that the selected identity is loaded and can create
   a disposable signed commit.
4. If all checks pass, container-global `commit.gpgsign` is set to `true`.
5. If any check fails, container-global `commit.gpgsign` is set to `false` and
   Boxdown reports a warning.

Boxdown must never select the first of multiple ambiguous candidates. If it
cannot identify exactly one intended key, signing is disabled and commits
continue unsigned. This behavior must be documented in the README, signing
feature documentation, `boxdown doctor` output, and setup warnings.

Boxdown will no longer write `commit.gpgsign` into the repository-local
`.git/config`. Repository-local configuration is shared with the host and is
not container-owned state.

An explicit repository-local `commit.gpgsign=true` remains the user's policy
and can override Boxdown's container-global fallback. Boxdown does not rewrite
explicit repository policy to guarantee unsigned fallback.

## Host Signing Resolution

A new host-side module will produce a typed signing plan before generated
devcontainer configuration is written. The plan records whether signing is
enabled, the selected public key, its fingerprint, the agent mount source, and
a stable reason when signing is unavailable.

Public keys are compared by algorithm and base64 key data. Comments are not
part of identity matching.

Boxdown resolves a signing identity in this order:

1. If the host Git configuration uses `gpg.format=ssh`, resolve its
   `user.signingKey`. Select it only if the corresponding public key is loaded
   in the host agent.
2. Otherwise, when authenticated GitHub CLI access and the network are
   available, intersect the loaded agent identities with the current GitHub
   user's SSH authentication keys. Select the key only when exactly one loaded
   identity matches.
3. Otherwise, select the loaded identity only when the agent contains exactly
   one identity.
4. With zero or multiple unresolved identities, produce a disabled signing
   plan and a warning reason. Do not guess.

Failure to execute `ssh-add`, query GitHub, parse a public key, or resolve a
single identity is non-fatal.

The selected public key is written outside the repository under:

```text
~/.local/share/boxdown/workspaces/<workspace-id>/git-signing/signing-key.pub
```

The signing state directory contains public material only. It is mounted
read-only at `/opt/boxdown/state/git-signing`.

## Agent Socket Resolution

The generated configuration uses the fixed container path:

```text
/run/boxdown/ssh-agent.sock
```

and sets:

```text
SSH_AUTH_SOCK=/run/boxdown/ssh-agent.sock
```

On Docker Desktop for macOS and Linux, the mount source is Docker Desktop's
host-service socket:

```text
/run/host-services/ssh-auth.sock
```

On native Linux Docker, the source is the host value of `SSH_AUTH_SOCK`.

Boxdown probes a candidate source through Docker before adding it to generated
configuration. If the probe fails, the mount and `SSH_AUTH_SOCK` container
environment value are omitted and the signing plan is disabled. This prevents
an unavailable bind source from blocking container creation.

Because mounts are create-time state, an environment created while the agent
bridge is unavailable remains unsigned until it is recreated. Boxdown warns
about this limitation; it does not mutate existing container mounts.

## Generated Devcontainer Configuration

When signing is enabled, the generated configuration includes mounts
equivalent to:

```json
{
  "mounts": [
    "type=bind,source=/run/host-services/ssh-auth.sock,target=/run/boxdown/ssh-agent.sock",
    "type=bind,source=<workspace-signing-state>,target=/opt/boxdown/state/git-signing,readonly"
  ],
  "containerEnv": {
    "SSH_AUTH_SOCK": "/run/boxdown/ssh-agent.sock"
  }
}
```

Native Linux substitutes the resolved host agent socket for the first source.
The signing mount and environment value are absent from a disabled plan.

Generated configuration accepts the resolved signing plan as input rather
than discovering host or Docker state inside the pure configuration builder.
This keeps mount generation deterministic and unit-testable.

## Container Git Configuration

Container Git bootstrap will stop unconditionally disabling commit signing.
When the selected identity and socket validate, it will configure the writable
container-global Git configuration with:

```ini
[gpg]
    format = ssh
[user]
    signingKey = /opt/boxdown/state/git-signing/signing-key.pub
[commit]
    gpgSign = true
```

The bootstrap removes incompatible copied host settings such as
`gpg.program=/opt/homebrew/bin/gpg`. It does not need a global
`gpg.ssh.allowedSignersFile` to create signatures. A disposable repository may
use a temporary allowed-signers file when validating its own signature.

When validation fails, the container-global configuration uses:

```ini
[commit]
    gpgSign = false
```

and removes Boxdown-owned SSH signing values that would otherwise leave an
inconsistent configuration.

Tag-signing behavior is not changed beyond removing the current unconditional
`tag.gpgsign=false`. When a copied host configuration explicitly enables tag
signing, the selected SSH signing configuration can satisfy it. Commit signing
is the feature guaranteed by this design.

## Lifecycle Consistency

The Docker agent mount makes the host agent available to all container
processes. It therefore covers both SSH access and the `devcontainer exec`
path used by `boxdown start` and coding-agent commands.

A focused container script owns signing configuration and validation. A shared
`ensureContainerGitSigning` lifecycle helper invokes it after a container is
started or reused and before control is handed to a shell, coding agent, SSH
proxy, tunnel, or setup completion.

All entry points use the same sequence:

1. Resolve the host signing plan.
2. Write signing-aware generated configuration.
3. Start or reuse the container.
4. Refresh container signing readiness.
5. Continue normally whether signing is enabled or disabled.

The signing refresh performs a disposable signed-commit test. A failed test
changes the container-global fallback to unsigned and reports a warning. The
test does not write to the user's repository.

If the host agent or selected key disappears after an interactive process has
started, a later `git commit` can still fail. Boxdown will document this narrow
runtime limitation instead of replacing or wrapping the Git executable.

## Doctor and Setup Preflight

Signing readiness is optional. Every signing-related doctor result has `pass`
or `warn` severity and never contributes a required setup failure.

Host and preliminary checks cover:

1. The host SSH agent can be queried.
2. A signing identity can be selected unambiguously.
3. Docker can expose the candidate agent socket to a container.
4. When GitHub CLI and the network are available, the selected key is
   registered as a GitHub SSH signing key.

Container checks cover:

1. `SSH_AUTH_SOCK` is reachable.
2. The selected public key is present in `ssh-add -L`.
3. A disposable Git repository can create a signed commit.
4. The disposable commit contains a valid SSH signature from the selected
   fingerprint.

`boxdown setup` runs relevant host checks during its existing preliminary
doctor stage and prints warnings before container creation. After the
container starts, the shared signing refresh supplies the full container
validation.

`boxdown doctor` runs the host checks on every invocation. It runs full
container validation in an existing Boxdown container. When no Boxdown
container exists, it may use an already available local Boxdown image for a
disposable probe; it does not pull an image solely for signing diagnostics.
If a full probe is unavailable, doctor reports that limitation as a warning.

## GitHub Verification

A commit is cryptographically signed when Git creates and validates its SSH
signature. GitHub displays that commit as Verified only when the corresponding
public key is registered in the user's GitHub account as an SSH signing key.

GitHub treats authentication and signing registrations separately. A public
key already registered for SSH authentication must be uploaded a second time
with type `signing`.

Boxdown checks the selected key against `user/ssh_signing_keys` when possible.
If it is absent, Boxdown keeps local signing enabled and warns that GitHub will
not display Verified until the user completes the one-time registration. The
warning includes an actionable command such as:

```bash
gh ssh-key add <public-key-file> --type signing --title "Boxdown commit signing"
```

Boxdown does not execute this account mutation automatically. GitHub or
network unavailability never disables a locally usable signing identity after
that identity has already been selected.

## Security Model

The agent bridge does not expose private key bytes, but any process in the
container that can access the socket can request operations from every identity
exposed by that host agent. Enabling signing therefore grants the container a
signing oracle and potentially SSH authentication capability for the lifetime
of the mount.

Documentation will recommend a dedicated signing identity or an agent that
requires confirmation for sensitive keys. The capability is default-on by
product decision, but doctor output and security documentation must describe
the exposure accurately.

## Error Reporting

Signing warnings use stable reasons so CLI and JSON doctor output remain
testable. At minimum, reasons distinguish:

- host agent unavailable;
- no loaded identities;
- ambiguous loaded identities;
- configured host SSH signing key not loaded;
- Docker agent bridge unavailable;
- public-key snapshot failure;
- selected identity missing in the container;
- disposable signing failure;
- GitHub signing registration missing;
- GitHub registration check unavailable.

Human-readable warnings state that commits will remain unsigned but are not
blocked. A missing GitHub registration warning instead states that commits are
signed locally but will not appear Verified on GitHub.

## Testing Strategy

### Unit tests

- Resolve a host-configured SSH signing key that is loaded in the agent.
- Resolve exactly one loaded key that matches GitHub authentication keys.
- Resolve a single loaded key without GitHub access.
- Disable signing for zero keys, multiple ambiguous keys, malformed keys, and
  command or API failures.
- Compare public keys without considering comments.
- Generate Docker Desktop and native Linux socket mounts correctly.
- Omit signing mounts and environment values for disabled plans.
- Generate the signing public-key state mount as read-only.
- Configure SSH signing after a successful container probe.
- Fall back to unsigned global configuration after every validation failure.
- Prove that post-create no longer writes repository-local
  `commit.gpgsign`.
- Report all signing preflight failures as warnings rather than failures.
- Exercise `setup`, `start`, coding-agent, SSH proxy, and tunnel paths through
  the shared signing lifecycle.

### Shell-script tests

Container signing bootstrap tests use temporary Git homes, repositories, fake
agent output, and disposable public keys. They verify both the enabled Git
configuration and the non-blocking unsigned fallback.

### Docker integration test

A gated manual or integration test mounts a real agent bridge into a disposable
container, creates an empty signed commit, and verifies the signature and
fingerprint. It is skipped when Docker or a usable agent identity is absent.
It does not push a commit or change a GitHub account.

### Manual acceptance

Create a new Boxdown environment and verify signed commits from:

- `boxdown start`;
- `boxdown codex`;
- an SSH session through the generated Boxdown alias.

Push a test branch only when explicitly authorized, then verify GitHub's badge
before and after registering the selected public key as a signing key.

## Documentation

Implementation updates will include:

- a dedicated commit-signing feature document;
- README behavior and security notes;
- setup and doctor documentation;
- architecture documentation for signing state, generated mounts, and trust
  boundaries;
- troubleshooting for ambiguity, absent agents, Docker mount failures,
  unsigned fallback, and missing GitHub verification;
- a changeset describing default-on best-effort signing.

The documentation will explicitly state that multiple ambiguous agent keys
disable signing rather than causing Boxdown to guess, and that this fallback
allows unsigned commits.
