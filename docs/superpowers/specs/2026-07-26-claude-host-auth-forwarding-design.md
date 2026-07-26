# Claude Code Host Authentication Forwarding Design

## Summary

Boxdown will forward a supported host Claude Code credential file into the
container rather than persisting Claude credentials in Boxdown workspace state.
The mount survives container removal because its source remains host-owned. It
does not expose the host's broader Claude configuration, prompt history,
transcripts, plugins, or personal MCP configuration.

The initial implementation supports Linux, WSL, and native Windows, where
Claude Code documents file-backed credentials. macOS uses Keychain-backed
credentials and is deliberately not included in automatic forwarding.

## Goals

- Let a user who has authenticated Claude Code on the host reuse that login in
  a Boxdown container after `docker rm`, `boxdown down`, or recreation.
- Match Boxdown's Codex-auth model: a narrow, host-owned credential mount that
  Boxdown neither copies nor removes.
- Forward only the credential data Claude Code needs for authentication, not
  the full Claude configuration or application-data directory.
- State the platform limitation and missing-credential recovery path clearly in
  `boxdown status` and the documentation.

## Non-goals

- Mounting host `~/.claude`, `~/.claude.json`, or Claude Code application data.
- Persisting Claude auth under Boxdown's workspace data directory.
- Copying credentials from the host or exporting credentials from the macOS
  Keychain.
- Making Boxdown log a user into Claude Code automatically.
- Supporting a host credential file that Claude Code has not documented.

## Credential Discovery

The host credential source is resolved from the host process environment:

| Platform | Default source | `CLAUDE_CONFIG_DIR` source |
| --- | --- | --- |
| Linux / WSL | `~/.claude/.credentials.json` | `<CLAUDE_CONFIG_DIR>/.credentials.json` |
| Native Windows | `%USERPROFILE%/.claude.credentials.json` | `<CLAUDE_CONFIG_DIR>/.credentials.json` |
| macOS | Not mountable automatically | Not mountable automatically |

The resolver treats the credential as available only when the path is a regular
file. It does not create a blank file or directory. A missing source is an
expected state, not an error.

The platform decision follows Anthropic's Claude Code credential-management
documentation: Linux and Windows store a file-backed credential, while macOS
stores credentials in Keychain. Claude Code manages the file through `/login`
and `/logout`, so the mount must remain writable.

## Generated Configuration

On a supported platform with a discovered host credential file, generated
devcontainer configuration includes one writable bind mount:

```text
<host credential source> -> /home/node/.claude/.credentials.json
```

The published image creates `/home/node/.claude` with ownership for the `node`
user, so Docker can bind-mount the file without mounting the entire parent
directory.

Boxdown does not set `CLAUDE_CONFIG_DIR` inside the container. Claude Code uses
its standard Linux path there, while the single mounted file supplies the
credential. The rest of `/home/node/.claude` remains container-local and can
hold Claude Code's mutable configuration, caches, history, transcripts, and
session data.

If a custom devcontainer asset already mounts the credential target,
Boxdown preserves that custom mount and does not add a conflicting one.

## Lifecycle and Security

The credential source is host-owned. Therefore:

- `docker stop`, `docker rm`, `boxdown down`, and `boxdown purge` do not remove
  it.
- `boxdown purge` removes only Boxdown workspace state and integrations, never
  host Claude credentials.
- Container-side `/login`, `/logout`, and token refresh can update the mounted
  credential file. This is necessary because Claude Code owns that file's
  lifecycle.
- Boxdown never reads credential contents, logs them, copies them into its data
  directory, or mounts host Claude configuration/history directories.

If the host file is absent, Boxdown does not add the mount. Status explains
that the user should run Claude Code and complete `/login` on the host, then
run `boxdown start --recreate` or `boxdown setup --recreate` so Docker receives
the new mount. Existing containers must be recreated whenever the mount set
changes.

On macOS, status reports that Keychain-backed Claude authentication cannot be
forwarded automatically. It does not offer an unsafe workaround.

## User Visibility

`boxdown status` reports Claude authentication as one of:

- `mounted`: a supported, regular host credential file will be forwarded;
- `missing`: the supported host credential location does not contain a regular
  file, with host-login and recreate guidance;
- `unsupported`: macOS Keychain-backed credentials are not automatically
  forwardable.

Documentation explains the contrast with Codex: Codex's `auth.json` is mounted
read-only, while Claude's documented credential file is writable because Claude
Code updates it during login/logout and refresh.

## Testing

Tests are written before production changes and cover:

1. Host credential path resolution for Linux/WSL, Windows, and
   `CLAUDE_CONFIG_DIR`.
2. Generated config adding the exact writable file mount only when the source
   is a regular file.
3. No generated mount on macOS or for a missing/non-regular source.
4. Preservation of a custom mount that already targets the container
   credential file.
5. Status text and JSON reporting for mounted, missing, and unsupported
   credential states.
6. The published image creating the single-file mount's target parent
   directory.

## Follow-up

The macOS Keychain authentication path remains intentionally unresolved. A
future design must identify an acceptable user-consented solution that does not
scrape, export, or persist Keychain credentials in Boxdown state.
