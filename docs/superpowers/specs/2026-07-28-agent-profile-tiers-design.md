# Agent Profile Tiers Design

## Summary

Boxdown will offer three explicit agent-profile tiers:

| Tier | CLI value | Host user profile made available in the container |
| --- | --- | --- |
| Bare | `none` | None |
| Portable identity | `auth` | Agent authentication plus the complete vendor-neutral `~/.agents` directory |
| Host profile | `full` | Authentication, `~/.agents`, and the complete Codex and Claude Code user-profile files |

`auth` is the default. It provides the smallest useful personal environment
without making Boxdown understand or continuously track each agent's
vendor-specific configuration schema.

Profile data is copied into the container at creation time. Boxdown never
bind-mounts a host agent profile read-write at its canonical container path.
Host sources are visible only through read-only staging mounts; a bootstrap
step copies the selected data into container-local writable paths before an
agent runs. Container-side login, settings, history, plugin, and cache writes
therefore cannot modify the host profile or race with another Boxdown workspace.

## Goals

- Give users a clear choice between an isolated agent installation, a minimal
  portable personal setup, and best-effort host-profile parity.
- Make `auth` the stable default without maintaining vendor-specific
  allowlists for hooks, commands, rules, MCP servers, plugins, or settings.
- Treat `~/.agents` as the vendor-neutral extension surface included with the
  default profile.
- Ensure all writable agent state is isolated per container and per workspace.
- Keep repository-scoped agent configuration available through the normal
  workspace mount in every tier.
- Make profile selection, limitations, and recreate requirements visible in
  status and documentation.

## Non-goals

- Parsing, filtering, translating, or validating arbitrary Codex or Claude Code
  user configuration.
- Converting Claude Code capabilities into Codex capabilities or the reverse.
- Keeping copied container profile state synchronized with the host after
  container creation.
- Exporting Claude credentials from the macOS Keychain.
- Making host-only commands, absolute paths, native dependencies, sockets, or
  plugin caches work in the Linux container.
- Hiding host profile contents from a container when the user explicitly
  selects a tier that copies those contents.
- Disabling repository-scoped `AGENTS.md`, `CLAUDE.md`, `.agents`, `.codex`,
  `.claude`, or `.mcp.json` files that are already part of the mounted checkout.

## Terminology and Scope Boundary

An agent profile controls only host user-scoped AI-agent data. It does not
control:

- the coding-agent CLIs installed in the Boxdown image;
- repository files visible through the workspace mount;
- Git, GitHub CLI, SSH, commit-signing, Snyk, or 1Password provisioning; or
- organization-managed settings supplied independently by an agent or platform.

Accordingly, `none` means "no host user-scoped agent profile." It does not mean
"ignore agent configuration committed to the repository."

The three public CLI values are intentionally short and stable:

- `none`
- `auth`
- `full`

Internal code may use more descriptive enum names, but user-facing output,
metadata, JSON, help, and documentation use these exact values.

## Tier Semantics

### `none`: bare user profile

Boxdown does not expose or copy any host user-scoped agent material:

- no Codex authentication;
- no Claude Code credential file;
- no `ANTHROPIC_API_KEY` forwarding for Claude Code;
- no host `~/.agents`;
- no host Codex or Claude Code configuration; and
- no user-scoped MCP projection.

The agent CLIs remain installed. They may be authenticated interactively inside
the container, and they still discover repository-scoped configuration from
the mounted checkout. Any login or configuration created in the container is
container-local and disappears when that container is removed.

### `auth`: portable identity

This is the default tier. Boxdown makes available:

- Codex file-backed authentication when discovered;
- Claude Code file-backed authentication on supported host platforms;
- the host `ANTHROPIC_API_KEY` when it is already available through Boxdown's
  runtime-secret mechanism; and
- the complete host `~/.agents` directory when present.

Boxdown does not include any other vendor-specific user configuration in this
tier. In particular, it does not forward:

- Codex `config.toml`, global `AGENTS.md`, hooks, rules, prompts, profiles,
  plugin cache, or other `$CODEX_HOME` state;
- Claude Code `settings.json`, global `CLAUDE.md`, rules, skills, commands,
  agents, hooks, plugins, history, memory, or other `~/.claude` state outside
  the supported credential source;
- host `~/.claude.json`; or
- user- or local-scoped MCP server definitions from either agent.

The entire `~/.agents` tree is copied without Boxdown interpreting its contents.
This preserves its role as the vendor-neutral capability layer and avoids
creating a Boxdown-owned list of supported skills, marketplaces, or future
standard components.

### `full`: best-effort host profile

This tier copies the following host sources when present:

- `$CODEX_HOME`, or `~/.codex` when `CODEX_HOME` is unset;
- `~/.agents`;
- `CLAUDE_CONFIG_DIR`, or `~/.claude` when `CLAUDE_CONFIG_DIR` is unset; and
- the resolved host Claude Code top-level `.claude.json` file when it is
  separate from the selected Claude configuration directory.

The sources are copied as opaque directory trees and files. Boxdown does not
filter histories, logs, caches, settings, hooks, rules, commands, MCP
definitions, plugins, trust state, memories, or other vendor-specific content.
That is the deliberate distinction between `full` and `auth`.

Full-profile parity is best effort:

- absolute host paths may not exist in the container;
- macOS binaries and native dependencies may not run on Linux;
- plugin sources outside the copied roots remain unavailable;
- host services, sockets, keychains, and desktop-app state are not reproduced;
  and
- copying `~/.claude` does not export macOS Keychain credentials.

Boxdown reports the copied sources but does not diagnose individual
vendor-specific failures inside them.

## Copy-on-Create Isolation Model

### Source mounts

Generated Dev Container configuration mounts only the selected host sources at
Boxdown-owned staging paths below:

```text
/opt/boxdown/agent-profile-source/
```

Every source mount is read-only. No selected host directory or file is mounted
directly over `/home/node/.codex`, `/home/node/.claude`,
`/home/node/.claude.json`, or `/home/node/.agents`.

The exact staging layout is an internal implementation detail, but each source
has a distinct target so a file mount cannot conflict with a directory mount.
The generated configuration continues to preserve explicit custom mounts. If a
custom mount targets a canonical agent-profile destination, Boxdown treats that
destination as externally managed and skips both its staging mount and bootstrap
copy. This prevents the bootstrap from writing through a user-supplied mount
into another host path. Status reports the affected destination as custom
rather than claiming that Boxdown applied the selected tier there.

### Container bootstrap

During initial container creation, before workspace dependency installation,
the post-create lifecycle invokes an agent-profile bootstrap owned by Boxdown.
The bootstrap:

1. Resolves the selected tier passed through non-secret container
   configuration.
2. Creates the canonical destination directories with ownership for the
   container's `node` user.
3. Copies only the tier's selected sources from the read-only staging mounts.
4. Makes the copied files writable by the container user where their original
   file type permits it.
5. Never writes through the staging mounts.

For `auth`, the bootstrap merges the selected credential files into otherwise
container-local agent directories and replaces the container's `~/.agents`
tree with the copied host tree. It does not introduce sibling Codex or Claude
configuration files.

For `full`, the bootstrap replaces the initial contents of the canonical user
profile destinations with the corresponding host copies. The image must not
store required Boxdown runtime assets inside those user-profile directories;
Boxdown-owned runtime scripts remain under `/opt/boxdown`.

The copy preserves regular files, directories, and symbolic links without
following symbolic links during traversal. It skips sockets, FIFOs, devices,
and other special files with a warning. Preserved links that reference
host-only paths may be broken in the container; Boxdown does not dereference
them or copy their external targets.

### Writable state and concurrency

After bootstrap, the canonical agent profile exists only in the container's
writable filesystem:

- the host source remains unchanged;
- each Boxdown workspace container has its own independent copy;
- multiple agents in the same container intentionally share that container's
  profile, matching ordinary user-level agent behavior; and
- agents in different Boxdown workspaces cannot race on or corrupt one
  another's copied profiles.

A source staging mount remains readable for the life of the container because
Docker mounts are create-time configuration. Agent CLIs are launched against
the canonical copied profile, not the staging path.

There is no reverse synchronization from container to host and no automatic
merge from host to an existing container.

## Lifecycle

Profile material is seeded when a container is created:

- `boxdown stop` preserves the container and its writable profile changes.
- Restarting the same container preserves those changes.
- `boxdown down` removes the container and therefore discards its copied
  profile.
- `boxdown purge` likewise removes the copied profile and all other
  Boxdown-managed workspace state in its existing removal scope.
- `boxdown start --recreate` discards the previous container copy and seeds a
  fresh copy from the current host sources.

Changes to host authentication, `~/.agents`, `$CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, or `.claude.json` are not synchronized into an existing
container. Users run `boxdown start --recreate` when they want a fresh seed.

Changing the selected tier changes the required mount set. If a matching
container already exists, Boxdown reports that recreation is required rather
than claiming the new tier is active in the old container.

## Profile Selection and Persistence

Container-starting commands accept:

```text
--agent-profile none|auth|full
```

Profile resolution uses this precedence:

1. An explicit `--agent-profile` value.
2. The profile recorded in Boxdown workspace metadata.
3. The default value, `auth`.

An explicit value is recorded in workspace metadata so later `start`, shell,
SSH, tunnel, and coding-agent commands use the same tier. Existing workspace
metadata without an agent-profile field resolves to `auth`.

Commands that cannot create or recreate a container may display or consume the
recorded value but do not silently change it. CLI parsing rejects any value
outside the three documented values before writing metadata or starting
Docker.

Generated container configuration sets the non-secret
`BOXDOWN_AGENT_PROFILE` value. The bootstrap also writes a container-local
profile marker after a successful copy. Status compares the recorded selection,
generated configuration, and running-container marker to distinguish an active
profile from one that still requires recreation.

## Authentication Details

### Codex

The `auth` bootstrap copies the discovered host Codex `auth.json` into the
container-local Codex home. It does not copy `config.toml` or any other Codex
file. Codex may update its container-local credential state without changing
the host file.

The `full` tier receives `auth.json` as part of the complete Codex-home copy.

### Claude Code

On Linux/WSL and native Windows, the `auth` bootstrap copies the supported
file-backed Claude credential into the container-local Claude directory.
Claude Code may update that copy without changing the host file.

On macOS, Boxdown does not export credentials from Keychain. If
`ANTHROPIC_API_KEY` is available through the existing runtime-secret mechanism,
the `auth` and `full` tiers expose it to container sessions. Otherwise Claude
Code begins unauthenticated and the user logs in inside that container.

The `none` tier suppresses `ANTHROPIC_API_KEY` even when Boxdown forwards other
unrelated runtime secrets such as `SNYK_TOKEN` or
`OP_SERVICE_ACCOUNT_TOKEN`.

## MCP and Configuration Behavior

The new default deliberately removes the current implicit user-configuration
forwarding:

- Codex `config.toml` is no longer mounted in `auth`.
- Boxdown no longer generates a Claude `.claude.json` MCP projection for
  `auth`.
- The complete files are copied opaquely only in `full`.

Users who want portable MCP configuration without selecting `full` place it in
the repository using the agent's project-scoped configuration mechanism.
Those repository files are already present through the workspace mount.

Boxdown removes the vendor-specific Claude MCP projector after the tier system
replaces its only use. It does not replace it with another parser.

## Generated State and Secret Handling

Generated Dev Container JSON contains profile names and source/destination
paths but never credential contents.

Credential sources are mounted read-only at staging paths and copied only
inside the container. Boxdown does not copy credential contents into its
persistent workspace-data directory or command log.

Copied credentials reside in the container's writable layer. Anyone who can
inspect, export, commit, or enter that container can access them, just as the
agent running there can. Removing the container is the cleanup boundary for
those copies.

The full tier may expose sensitive histories, cached responses, plugin data,
environment-bearing settings, and other files because the user explicitly
requested the complete profile. Help and documentation warn about that
exposure before describing the compatibility benefits.

Neither status text nor status JSON enumerates arbitrary files within
`~/.agents`, `$CODEX_HOME`, or the Claude profile. This prevents accidental
disclosure of filenames or vendor state. Status reports only the selected tier,
whether each top-level source was present at generation time, and whether the
running container must be recreated to apply the selection.

## Failure Handling

Missing optional sources do not fail container creation:

- `none` has no required profile sources.
- `auth` may start without one or both agent credential sources or without
  `~/.agents`.
- `full` copies every discovered top-level source and reports absent sources.

An unreadable discovered credential file is a warning and leaves that agent
unauthenticated. A copy failure for `~/.agents` or a full-profile directory is
reported with the affected top-level source and fails the bootstrap, because a
partially copied capability tree would make the selected profile misleading.

Special files are skipped with warnings as described above. Broken symlinks,
missing external paths, incompatible binaries, and vendor-level configuration
errors do not fail Boxdown bootstrap.

No warning or error includes credential contents.

## Status and Documentation

`boxdown status` text includes:

```text
Agent profile: auth (default)
  Codex authentication: available
  Claude authentication: unavailable (macOS Keychain is not copied)
  ~/.agents: available
  Container profile: recreate required
```

JSON status includes the selected profile, whether it came from explicit
metadata or the default, top-level source availability, and whether the
running container is known to use that profile. It does not inspect or report
the arbitrary contents of a full profile.

Documentation covers:

- the exact three tiers and the `auth` default;
- the distinction between host user configuration and repository
  configuration;
- copy-on-create isolation and lack of reverse synchronization;
- the recreate requirement for refreshes and tier changes;
- macOS Keychain limitations;
- the full tier's sensitive-data, size, portability, and compatibility risks;
  and
- migration from the previous default MCP and Codex-config forwarding.

## Migration

This is an intentional behavior change:

- the previous default mounted host `~/.agents` read-only at its canonical
  location; `auth` now copies it into an isolated writable container location;
- the previous default mounted Codex `config.toml`; `auth` no longer does;
- the previous default generated a Claude MCP projection; `auth` no longer
  does; and
- the previous supported Claude credential mount could update the host
  credential; the copied credential can no longer do so.

Existing containers keep their existing Docker mounts until recreated.
Existing workspace metadata without a recorded profile selects `auth` for the
next generated configuration.

Release notes tell users relying on host-level MCP or Codex configuration to
move portable definitions into the repository or select `full`. Because the
default capability and authentication lifecycle changes, the release follows
the repository's normal breaking-change/versioning policy.

## Testing

Tests are written before implementation and cover:

1. CLI parsing for `none`, `auth`, and `full`, including invalid values.
2. Resolution precedence across an explicit flag, workspace metadata, and the
   `auth` default.
3. Exact generated source mounts for every tier, including `CODEX_HOME`,
   `CLAUDE_CONFIG_DIR`, missing sources, and custom-mount conflicts.
4. `none` exposing no host agent source and suppressing
   `ANTHROPIC_API_KEY` while retaining unrelated Boxdown secrets.
5. `auth` copying only supported credentials and the complete `~/.agents`
   tree.
6. `auth` excluding Codex config, Claude settings, global instruction files,
   vendor rules, hooks, commands, plugins, and MCP projection.
7. `full` copying complete Codex, Claude, `.claude.json`, and `~/.agents`
   sources without schema-aware filtering.
8. Source mounts remaining read-only and byte-for-byte unchanged after the
   bootstrap and simulated agent writes.
9. Two workspace bootstraps producing independent writable copies.
10. File ownership and usability by the container's `node` user.
11. Symlink preservation without dereferencing and warning/skip behavior for
    special files.
12. Stop/start preserving a container copy, while down/recreate seeds a fresh
    copy.
13. A custom canonical destination preventing Boxdown from staging or copying
    that destination, including proof that bootstrap cannot write through it.
14. Status text and JSON for source availability, selected tier, default
    resolution, active-container marker, custom destinations, and recreate
    requirements without arbitrary file enumeration.
15. Removal of the Claude MCP projector and obsolete direct host-profile
    mounts.
16. Documentation, help output, generated-config snapshots, image policy, Bash
    syntax, focused lifecycle tests, full tests, lint, build, and
    `git diff --check`.

## Decision Record

The selected design intentionally prefers three coarse profiles over
vendor-specific capability forwarding.

`auth` includes the whole `~/.agents` directory because it is the
vendor-neutral extension boundary and provides the desired minimum viable
personal environment. Everything vendor-specific beyond authentication belongs
either in the repository or in `full`.

`full` uses copy-on-create rather than a writable bind mount of host agent
homes. This costs startup time and container storage and does not provide live
synchronization, but it prevents host mutation, cross-workspace races, and
profile corruption. That isolation guarantee is more important than exact
write-through parity.
