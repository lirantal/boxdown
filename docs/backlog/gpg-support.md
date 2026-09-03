# GPG Commit Signing Support

## Status

Backlog proposal. This document describes a future, opt-in OpenPGP/GPG commit
signing capability; it does not change the current SSH-signing integration.

## Problem

Boxdown copies or preserves Git configuration that may request OpenPGP commit
signing, but the default container image does not provide a usable GnuPG
signing environment. Installing `gpg` alone is insufficient: a commit can be
signed only when GnuPG can reach the private signing key (normally through a
host `gpg-agent`).

The current behavior is intentionally non-destructive: Boxdown preserves an
explicit GPG configuration and reports when it cannot work in the container.
This proposal defines a supported path that keeps private key material on the
host while allowing a container to request commit signatures.

## Goals

- Enable opt-in OpenPGP-signed commits from a Boxdown container.
- Keep private keys, secret-key keyrings, and passphrase-management state on
  the host; never copy or mount `~/.gnupg` into a container.
- Use the host GPG agent's restricted extra socket for remote clients rather
  than its general-purpose agent socket.
- Start with environments where a host GPG agent and a Linux container can be
  connected reliably, including Linux and GPG setups that run inside WSL.
- Preserve existing Git configuration precedence and SSH signing behavior.
- Make readiness, failure, and remediation visible without blocking setup.
- Leave a well-defined extension point for host platforms that need a socket
  relay rather than a direct mount.

## Non-goals

- Generating, importing, exporting, rotating, or revoking users' GPG keys.
- Uploading public keys to GitHub or any other forge.
- Supporting a host-side GPG agent that cannot be reached from the container
  in the initial release.
- Copying private keys into an image, workspace, volume, cache, or runtime
  directory.
- Replacing custom GPG integrations supplied by a custom devcontainer image.
- Rewriting commits that were created before signing became available.

## Recommendation

Implement a phased, capability-based integration.

### Phase 1: native Linux and in-WSL agents

Support OpenPGP signing when all of the following are true:

1. Git is explicitly configured for OpenPGP signing.
2. The host has a compatible `gpg`, `gpgconf`, and running `gpg-agent`.
3. The host exposes its GPG-agent extra socket.
4. Boxdown can safely expose that socket to the container at the location the
   container's GnuPG client expects.
5. The container has `gnupg` and the public key needed to identify the signing
   key.

This is the smallest useful implementation because it provides real signing,
not merely a `gpg` binary that will still fail for lack of a secret key.

### Phase 2: host-to-VM socket transport

Add a platform adapter only after validating the relevant container runtime.
Some desktop runtimes run Linux containers inside a VM. A host Unix socket is
a live kernel endpoint, not ordinary file content, so a direct bind mount may
not reliably transport its protocol across that boundary.

When a direct mount is not viable, the adapter must relay only the GPG-agent
extra-socket protocol between a container-local Unix socket and a
host-reachable endpoint. The relay must be private to the local container
runtime and must not listen on a network-accessible interface.

No platform is supported merely because its regular files can be bind-mounted;
the full signing flow must be validated on that platform.

## Proposed Architecture

```text
Git in container
  -> gpg in container
  -> container GPG-agent socket endpoint
  -> Boxdown mount or local relay
  -> host gpg-agent extra socket
  -> host private GPG key / host-side passphrase prompt
```

The container needs the public portion of the selected key. The host agent
performs the private-key operation and returns a signature; the private key is
not transferred to the container.

### Responsibilities

| Component | Responsibility |
| --- | --- |
| Host discovery | Determine whether Git requests OpenPGP signing; resolve the configured signing key and agent extra socket. |
| Host GPG agent | Retain private keys and handle any passphrase, hardware-token, or confirmation flow. |
| Boxdown integration | Validate capabilities, arrange the direct mount or supported relay, and generate container configuration. |
| Container image | Include `gnupg` and the small amount of tooling required by the chosen transport. |
| Container keyring | Contain only the selected public key material needed by `gpg` to identify the signing key. |
| GitHub or another forge | Independently verify a pushed signature against a user-registered public key. |

## Configuration and Precedence

GPG support must be activated only for an explicit OpenPGP configuration. It
must not reinterpret a user's existing SSH-signing configuration or replace a
custom signing program.

At minimum, the integration should inspect effective repository-local and
global Git configuration for:

- `commit.gpgsign`
- `gpg.format`
- `gpg.program`
- `user.signingkey`

The existing precedence rules remain authoritative:

- Explicit SSH signing continues through the existing SSH-agent integration.
- Explicit non-OpenPGP signing is preserved and is not overridden.
- An explicitly configured but unavailable GPG setup produces a diagnostic;
  Boxdown must not silently fall back to another key or signing format.
- A custom image that supplies its own GPG integration is not modified by this
  feature.

The feature should use an explicit opt-in setting, even when a compatible host
configuration is detected. Agent forwarding grants the container authority to
request signatures, so automatic exposure based solely on a copied Git config
would be surprising.

The exact setting name is an implementation decision, but it should make the
two facts clear: GPG-agent access is being enabled, and private keys remain on
the host.

## Host Discovery Requirements

Discovery is read-only and must not create keys, alter agent configuration, or
prompt for a passphrase.

It should:

1. Confirm that OpenPGP signing is the effective Git signing mode.
2. Resolve the configured signing key to a stable fingerprint or key ID.
3. Locate the agent's extra socket through `gpgconf --list-dir
   agent-extra-socket`, rather than assuming a home-directory or runtime path.
4. Confirm that the socket is usable by the invoking user.
5. Export or otherwise obtain only the selected public key material.
6. Report whether the current runtime supports a direct mount or requires a
   platform adapter.

The public-key export must be scoped to the selected signing identity. Boxdown
must not copy an entire personal keyring or trust database into the container.

## Container Setup Requirements

For a supported configuration, generated container setup must:

1. Install or provide a compatible `gpg` executable.
2. Create the container socket directory with ownership and permissions
   appropriate for the non-root development user.
3. Expose the host extra socket at the container's GnuPG-agent socket endpoint
   using a direct mount or an approved local relay.
4. Ensure container `gpg` uses that endpoint and does not replace it by
   autostarting a competing local agent.
5. Import the selected public key into a container-local keyring with
   restrictive permissions.
6. Configure Git to select the imported signing key without changing the
   user's requested signing format.

All generated paths and key identifiers must be safe to log. Never log secret
key material, passphrases, raw agent traffic, or complete private keyring
contents.

## Security Model

### What remains protected

- The secret key remains held by the host GPG agent or a hardware token.
- The container receives a signature result, not the private key.
- Any passphrase or hardware-token interaction is handled by the host-side GPG
  agent and its configured pinentry flow.

### What is delegated to the container

An agent socket is a signing capability. Code executing as the container user
can ask the forwarded agent to sign compatible requests while the forwarding
path is active. This is analogous to SSH-agent forwarding, though the
protocols and agent policies differ.

Mitigations for the initial implementation:

- Require explicit user opt-in.
- Use the GPG agent's extra socket, which is intended for remote clients,
  instead of the regular agent socket.
- Limit the mount or relay to the container's non-root development user where
  the runtime permits it.
- Avoid exposing any TCP listener beyond the local runtime boundary.
- Document that users may choose a dedicated signing key, hardware token, or
  agent confirmation policy when signing authority in a container is not
  acceptable.

## User Experience and Diagnostics

Setup and `boxdown doctor` should classify GPG readiness without blocking
normal container use. Diagnostics need a stable reason code and a short
remediation path.

| Condition | Expected behavior | Suggested remediation |
| --- | --- | --- |
| OpenPGP signing configured but feature not enabled | Preserve Git config and warn that Boxdown is not forwarding a GPG agent. | Enable the opt-in GPG integration or use a custom image integration. |
| `gpg` or `gpgconf` unavailable on host | Do not create a forwarding configuration. | Install/configure GnuPG on the host, then recreate. |
| Agent extra socket unavailable | Do not create a forwarding configuration. | Start/configure the host GPG agent and retry. |
| Runtime transport unsupported | Do not attempt an unsafe or network-exposed workaround. | Use a supported host/runtime combination or custom integration. |
| Public key cannot be resolved/exported | Do not copy a broad keyring or guess a key. | Configure `user.signingkey` to the intended signing key. |
| Container image lacks GnuPG | Report an actionable image capability error. | Use the supported image path or add GnuPG in a custom image. |
| Agent request is declined or needs a passphrase | Surface the GPG error from the signed-commit probe. | Complete the host-side prompt, adjust agent policy, then retry. |

A successful setup does not guarantee every future signature will succeed:
the agent can be stopped, a key can be locked or removed, or a hardware token
can be unavailable. A disposable signed-commit probe after container creation
should distinguish transport/setup errors from user interaction or agent
policy failures.

## GitHub Verification

Signing and forge verification are separate concerns. Boxdown's role ends
after creating a valid local OpenPGP signature. To receive a Verified status
on GitHub, the user must add the corresponding **public** GPG key to their
GitHub account and satisfy GitHub's email-identity requirements. The private
key is never uploaded to GitHub. See GitHub's [commit signature verification
documentation](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification).

## Acceptance Criteria

Phase 1 is complete only when all of the following are demonstrated on each
supported host/runtime combination:

- An opted-in container creates a commit signed by the intended OpenPGP key.
- `git log --show-signature` in the container identifies the expected key.
- The container contains no secret-key material before or after signing.
- Stopping the host agent causes a clear, non-blocking diagnostic and no
  fallback to a different key.
- Removing the forwarding configuration prevents signing without corrupting
  the user's host GPG configuration.
- Explicit SSH signing still follows the existing SSH flow unchanged.
- Explicit non-OpenPGP Git configuration remains untouched.
- The standard project test suite covers configuration precedence, discovery
  failures, generated container configuration, and log redaction.

## Test Matrix

The implementation should use automated fakes for discovery and transport
selection, plus an end-to-end test environment with a disposable test key.

| Area | Required cases |
| --- | --- |
| Git configuration | OpenPGP enabled; SSH configured; signing disabled; custom program; repository-local overrides. |
| Key selection | Valid configured key; missing key; ambiguous key; public-key export limited to the selected identity. |
| Agent state | Extra socket available; missing; inaccessible; agent stops after setup; agent declines a request. |
| Transport | Supported direct mount; unsupported runtime; approved relay when implemented; no external listener. |
| Container setup | GnuPG present; absent; socket ownership correct; local-agent autostart prevented. |
| Security | No secret key copied; logs redact sensitive paths/data; forwarding requires opt-in. |
| Regression | Existing SSH signing selection and diagnostics are unchanged. |

## Open Questions Before Implementation

1. Which host/container runtime pairs can directly mount a host Unix socket,
   and which require a relay?
2. What is the smallest, auditable relay implementation for runtimes that
   require one, and how will it be lifecycle-managed and cleaned up?
3. How should the opt-in be represented in Boxdown's configuration surface?
4. Should Phase 1 require a configured `user.signingkey`, or support agent
   discovery when it is unset?
5. How should the public key be supplied to the container: an ephemeral
   generated file, a dedicated read-only mount, or an import step during
   container creation?
6. Which GnuPG and Git versions establish the minimum supported baseline?

## References

- [GnuPG `gpg-agent` manual: extra socket](https://www.gnupg.org/documentation/manuals/gnupg26/gpg-agent.1.html)
- [GnuPG agent-forwarding guidance](https://wiki.gnupg.org/AgentForwarding)
- [Git configuration: `user.signingKey`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-usersigningKey)
- [GitHub: commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)
