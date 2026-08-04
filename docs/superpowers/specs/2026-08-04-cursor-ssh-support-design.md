# Cursor Remote SSH Support Design

## Summary

Boxdown will add `cursor` as an optional SSH install target. The target will
connect Cursor to the same Boxdown-managed OpenSSH `Host` alias already used by
Codex and Claude, then hand the user a normal Cursor Remote SSH folder URI for
the container workspace.

The integration is deliberately configure-only. Boxdown will update Cursor's
public user settings, validate that the selected settings file points Cursor at
the SSH config containing the managed alias, and print an explicit
`cursor --folder-uri` command. It will not
launch Cursor, install extensions, or edit Cursor's internal SQLite,
workspace-storage, or remote-history state.

Local discovery confirms that this matches Cursor's supported connection path:
the installed `anysphere.remote-ssh` extension reads OpenSSH hosts, accepts a
`remote.SSH.remotePlatform` map, and supports
`cursor --folder-uri vscode-remote://ssh-remote+<host>/<path>`. Existing Cursor
logs show a Boxdown-style alias being invoked through `ssh -T -D ... <alias>`
and the Cursor server being installed under `/home/node/.cursor-server`.

## Goals

- Make `--target cursor` available to `setup`, `ssh install`, and
  `ssh uninstall` alongside `codex` and `claude`.
- Reuse Boxdown's existing managed SSH alias and proxy transport without
  introducing a second container-discovery path.
- Configure Cursor's remote platform for the alias while preserving comments,
  trailing commas, formatting, and unrelated settings in `settings.json`.
- Fail safely when the selected Cursor settings file configures a different SSH
  config than the one Boxdown manages.
- Print a stable, shell-safe command that opens `/workspaces/<repo-name>` over
  Cursor Remote SSH.
- Make install and uninstall idempotent and preserve user-owned Cursor values.
- Keep shared-alias cleanup correct when more than one Boxdown workspace record
  refers to the same Cursor setting.
- Keep Cursor-only setup independent from Codex/Claude agent-profile selection.
- Document prerequisites, paths, overrides, cleanup, and recovery behavior.

## Non-goals

- Opening Cursor automatically or detecting whether its GUI is running.
- Installing, enabling, or updating the Cursor Remote SSH extension.
- Registering Cursor workspaces by editing `state.vscdb`,
  `workspaceStorage`, `remoteLocationHistory_v0`, recent-project state, or any
  other Cursor-owned internal database or cache.
- Driving Cursor's Dev Containers extension or recreating the direct
  `dev-container+<hex JSON>` authority found in older Cursor workspaces.
- Adding Cursor configuration to `boxdown status` in this change; current
  status behavior does not report Codex or Claude target registration either.
- Changing Boxdown's SSH transport, container workspace path, container user,
  SSH key lifecycle, or proxy command.
- Copying or mounting a Cursor user profile into the container.
- Persisting a Cursor choice as a default target for later setup runs.

## Discovery Evidence

### Existing Cursor installation

The inspected host has Cursor CLI `3.14.7` for arm64 and these relevant
extensions:

- `anysphere.remote-ssh@1.1.13`
- `anysphere.remote-containers@1.0.38`

Cursor's user settings are stored at:

```text
~/Library/Application Support/Cursor/User/settings.json
```

The current settings contain Linux platform hints for two previous SSH
aliases:

```json
"remote.SSH.remotePlatform": {
  "url-sheriff-devcontainer": "linux",
  "forward-research-metrics-devcontainer": "linux"
}
```

The Remote SSH extension defaults to `~/.ssh/config` unless
`remote.SSH.configFile` is set, follows OpenSSH `Include` directives, and lists
literal `Host` aliases. Its installed documentation shows folder URIs in this
shape:

```text
cursor --folder-uri vscode-remote://ssh-remote+<hostname>/<folder_path>
```

An earlier successful connection for
`forward-research-metrics-devcontainer` invoked the configured host alias via
OpenSSH, detected Linux/ARM64, installed the remote server, and established its
forwarding session. This demonstrates that Cursor does not need a Boxdown-
specific registry when the alias and remote platform hint are correct.

### The `snyk-vulnbench` entry

The Cursor workspace whose authority begins `7b227365747469` is not keyed by a
Docker container ID. Decoding the hexadecimal authority yields a Dev Containers
descriptor containing:

- `settingType: "config"`;
- host workspace path for `snyk-vulnbench`; and
- its `.devcontainer/devcontainer.json` path.

Its remote workspace path is `/workspaces/snyk-vulnbench`. This validates the
canonical path Boxdown should open, but the descriptor is internal to Cursor's
direct Dev Containers workflow and must not be copied or synthesized for the
SSH integration.

### Boxdown integration points

Boxdown already owns the required SSH transport in `src/ssh-config.ts`. The
managed block supplies the `node` user, workspace-specific identity, proxy
command, and host-key behavior. `src/ssh-install-targets.ts` is the public
target registry used by CLI parsing, interactive choices, setup progress, and
targeted uninstall. Cursor belongs in that registry rather than in a parallel
command.

Two current couplings need explicit treatment:

1. `src/setup-agent-profile.ts` treats any selected target as a reason to show
   the agent-profile prompt. Cursor does not consume a Codex or Claude profile,
   so target metadata must distinguish profile-relevant targets.
2. `src/purge.ts` hard-codes Codex and Claude cleanup instead of using the
   target registry. Purge must either add Cursor explicitly or, preferably,
   iterate the registry so future targets cannot be omitted.

## User Experience

### Install during setup

```sh
boxdown setup --target cursor
```

The normal setup lifecycle creates or reuses the container and installs the
managed SSH alias. The Cursor target then:

1. resolves and validates Cursor's settings file;
2. verifies the selected Cursor settings and Boxdown use the same SSH config
   path;
3. adds the alias's Linux platform hint if necessary;
4. records Boxdown's ownership decision outside the repository;
5. performs a best-effort prerequisite check; and
6. prints the command to open the remote workspace.

For a workspace named `snyk-vulnbench`, the final instruction is equivalent to:

```sh
cursor --folder-uri 'vscode-remote://ssh-remote+snyk-vulnbench-devcontainer/workspaces/snyk-vulnbench'
```

Boxdown does not execute the command. The user controls when a GUI process is
started and whether an existing Cursor window is reused.

Cursor alone does not make setup show the agent-profile selector. A selection
containing `cursor` and either `codex` or `claude` does show it, preserving the
current Codex/Claude behavior.

### Standalone install and uninstall

```sh
boxdown ssh install --target cursor
boxdown ssh uninstall --target cursor
```

Targeted uninstall preserves the OpenSSH alias and removes only Cursor state
for the selected alias that Boxdown can prove it owns. An unqualified
`boxdown ssh uninstall` removes the managed SSH alias and invokes complete
workspace cleanup for every registered target. Cursor's complete cleanup uses
every entry in that workspace's ownership record, including entries left by an
older alias or settings-path override.

Interactive target selection includes Cursor. Non-interactive invocations
without `--target` retain the existing behavior: install only the SSH alias and
print the explicit target forms.

## Cursor Settings

### Settings path

A focused `src/cursor-app-config.ts` module will resolve the user settings path
using these platform defaults:

| Platform | Default |
| --- | --- |
| macOS | `~/Library/Application Support/Cursor/User/settings.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/Cursor/User/settings.json` |
| Windows | `%APPDATA%\Cursor\User\settings.json` |

`BOXDOWN_CURSOR_SETTINGS` overrides the complete file path for tests and local
development, but an explicitly empty override is an error. Windows resolution
uses a non-empty `APPDATA`, or derives it from a non-empty `USERPROFILE`/`HOME`
fallback. macOS requires a non-empty `HOME`. Linux uses a non-empty
`XDG_CONFIG_HOME` directly or derives `.config` from a non-empty `HOME`.
Platform-selected `posix`/`win32` path operations keep an explicit platform
argument host-independent. Empty values are treated as absent, and missing
required home/config variables produce an actionable error rather than a path
rooted at the current directory or the executing account's home.

If the file does not exist or contains only whitespace, Boxdown creates its
parent directory as needed and starts from an empty object. Writes are atomic
and preserve the existing file's mode where possible. A new file uses user-only
permissions. When the configured settings path is an existing symbolic link,
Boxdown updates its resolved target atomically instead of replacing the link.

### JSONC editing

Cursor settings are JSON with comments and trailing commas. Parsing them and
serializing with `JSON.stringify` would destroy user formatting and comments.
Boxdown will therefore add `jsonc-parser@3.3.1` as an exact direct runtime
dependency and use its structured edit operations.

The editor will use `jsonc-parser`'s `parseTree`, `modify`, and `applyEdits`
operations. Before editing a multiline document it detects the existing
newline and indentation style and passes matching formatting options to
`modify`; it handles a leading byte-order mark without changing it. A compact
one-line existing JSONC object is the deliberate exception: the editor omits
`formattingOptions` because `jsonc-parser@3.3.1` otherwise replaces and
reformats the complete document. Omitting the options makes the library return
the smallest alias/delimiter edit and preserves every unrelated byte.
Whitespace-only input still starts from a normally formatted empty object. The
editor will:

- reject syntax errors with the Cursor settings path and parser location;
- require the root value to be an object;
- preserve the byte-order mark, newline style, indentation style, comment token
  sequence, key order, and every byte outside the smallest necessary property
  and delimiter edit spans;
- retain the surrounding object's existing trailing-comma style and format a
  new property consistently with its siblings;
- change only the path
  `remote.SSH.remotePlatform.<alias>`; and
- avoid rewriting the file when the desired value already exists.

The value rules are:

| Current value | Install behavior |
| --- | --- |
| Missing | Insert `"linux"` and consider ownership registration |
| `"linux"` | Leave unchanged and determine whether ownership is already Boxdown-managed |
| Any other value | Fail without overwriting it |
| Parent value is not an object | Fail without rewriting settings |

Boxdown never owns or removes the surrounding `remote.SSH.remotePlatform`
object, even if it created that object during installation. Cleanup deletes
only the exact alias property and lets the JSONC editor retain an empty parent
object if no other mappings remain. This keeps cleanup surgical and avoids
claiming ownership of user-level structure.

Before cleanup applies a deletion, it inspects the current JSONC token stream.
Any comment in the alias property's conservative trivia span—from the end of
the previous sibling value or opening brace through the start of the next
sibling key or closing brace—makes that mapping user-modified. Boxdown then
leaves the alias property in place and releases only its ownership entry. This
rule needs no historical comment fingerprint and intentionally favors a false
retention over deleting a user annotation. For an uncommented owned property,
delimiter whitespace immediately adjacent to it may change as required to keep
valid JSONC; unrelated formatting and the complete current comment-token
sequence remain byte-identical.

### SSH config compatibility

For the integration to work, the selected Cursor settings file must direct the
Remote SSH extension to the same file returned by Boxdown's
platform-aware `defaultSshConfigPath()`. This feature updates that shared
resolver to accept a platform argument, use `win32.join` on Windows, and fall
back to `USERPROFILE` when `HOME` is absent. SSH installation and Cursor
comparison must call the same resolver so they cannot disagree. Boxdown cannot
prove the precedence of every Cursor profile or custom `--user-data-dir` while
Cursor is offline; its guarantee is limited to the settings file it was asked
to manage. Before changing that file, the target reads
`remote.SSH.configFile`:

- when absent or the extension's default empty string, the selected settings
  use the platform's normal `~/.ssh/config`;
- when non-empty, it must be an absolute path, matching the installed
  extension's application-scoped schema; and
- normalized absolute paths are compared case-insensitively on Windows and
  case-sensitively elsewhere.

If the resolved paths differ, installation fails before changing Cursor
settings or ownership state. The error displays both paths and offers two
explicit remedies: point `remote.SSH.configFile` at Boxdown's path, or run
Boxdown with `BOXDOWN_SSH_CONFIG` set to Cursor's path. Boxdown does not
silently rewrite this user-wide Cursor preference because it may affect every
existing SSH connection.

Boxdown does not invent tilde or environment-variable interpolation inside an
explicit `remote.SSH.configFile`. A non-absolute configured string fails with
an instruction to use an explicit absolute path.

Uninstall uses its recorded settings path and does not require current SSH
config compatibility. This allows cleanup after either application has been
reconfigured.

## Ownership and Cleanup

### Per-workspace record

Each Cursor target install writes a small ownership record under the existing
workspace data directory:

```text
<dataRoot>/workspaces/<workspaceId>/cursor-integration.json
```

The versioned record contains only non-secret integration metadata. It keeps an
array because a workspace can be reinstalled with a different alias or settings
override before the earlier target is uninstalled:

```json
{
  "version": 1,
  "mappings": [
    {
      "alias": "snyk-vulnbench-devcontainer",
      "settingsPath": "/absolute/path/to/Cursor/User/settings.json",
      "remotePlatformOwned": true
    }
  ]
}
```

The record is written atomically with user-only permissions. It is not stored
in the target repository. Install upserts by normalized settings path and exact
alias without discarding other entries. Targeted Cursor uninstall removes all
entries for the selected alias, deleting the file when no entries remain;
normal workspace purge processes every relevant alias before deleting the
workspace data directory.

`remotePlatformOwned` means the alias property originated from Boxdown or was
already backed by another valid Boxdown ownership record for the same
normalized settings path and alias. A pre-existing user value of `"linux"`
with no such record remains user-owned and is recorded as `false`.

This distinction produces these install cases:

| Settings value | Matching Boxdown owner exists | New entry |
| --- | --- | --- |
| Missing | No | Insert value; `remotePlatformOwned: true` |
| `"linux"` | Yes | No settings edit; `remotePlatformOwned: true` |
| `"linux"` | No | No settings edit; `remotePlatformOwned: false` |

Entries are matched by normalized settings path and exact SSH alias. A valid
owner can be the current workspace's earlier entry or an entry in another
workspace record. Peer discovery scans
`<dataRoot>/workspaces/*/cursor-integration.json` directly and does not depend
on `metadata.json`, repository existence, or the tracked-workspace listing. A
valid peer remains visible even if its normal workspace metadata is absent.
Reusing an alias across workspaces therefore does not let one workspace remove
a mapping that another still needs.

The ownership universe is one resolved Boxdown data root. Users must retain the
same `BOXDOWN_DATA_HOME`/`XDG_DATA_HOME` choice across install and cleanup;
changing it deliberately creates an independent state universe that cannot
prove ownership of records under the earlier root.

### Serialization

Install and cleanup serialize ownership decisions with an atomic lock directory
at `<dataRoot>/cursor-integration.lock`. A command waits up to five seconds,
then fails without mutation if another writer still owns the lock. The lock
contains the owner PID and timestamp. A lock older than ten minutes is reclaimed
only when its recorded process is verifiably absent; malformed or unverifiable
locks fail conservatively and report their path. The lock is released in a
`finally` path.

Every operation reads settings and rescans ownership records after acquiring
the lock, immediately before deciding and writing. This prevents simultaneous
last-owner uninstalls from observing stale peer state and leaving an orphaned
mapping.

### Safe uninstall

On uninstall, Boxdown reads the current workspace record first and processes
each entry matching the selected alias.

- With no valid matching entry, Cursor cleanup is a no-op; Boxdown does not
  infer ownership from a matching value.
- With `remotePlatformOwned: false`, Boxdown removes only the record.
- With `remotePlatformOwned: true` and another valid owner for the same path
  and alias, Boxdown retains the setting and removes only the current record.
- With the last valid owner, Boxdown removes the alias property only when its
  current value is still exactly `"linux"`.
- If the user changed the value, Boxdown preserves it and removes its record.
- If any ownership-record file found by the direct scan cannot be read or
  validated, Boxdown conservatively retains the Cursor setting and reports why
  ownership could not be proven safe to release.

The settings edit must succeed before the current record is removed so a failed
cleanup can be retried. During install, Boxdown snapshots any existing current
record, persists the new ownership decision, and only then applies a required
settings edit. If the settings write fails, it atomically restores the previous
record state and reports the failure. A process interrupted between those two
writes can leave a conservative record but cannot leave an untracked Boxdown
settings insertion; a later install or uninstall safely reconciles it.

Purge performs one target-level cleanup lifecycle for each registered target
before deleting the workspace data directory. Codex and Claude process the
resolved alias set. Cursor ignores that alias set and processes every mapping
in its own `cursor-integration.json`, so installing alias A, later installing
alias B, and then purging cannot discard A's ownership record before A is
cleaned. Purge plan text names Cursor alongside Codex and Claude.

The target registry exposes this complete-workspace cleanup separately from
single-alias targeted uninstall. Unqualified `ssh uninstall` and `purge` use
complete cleanup; `ssh uninstall --target cursor` uses only the selected alias.

## Prerequisite Check and Output

The supported prerequisite is Cursor's `anysphere.remote-ssh` extension. The
target performs a best-effort check after configuration:

1. find the `cursor` CLI on `PATH`;
2. if found, run `cursor --list-extensions` without a shell and with a bounded
   five-second timeout;
3. compare extension identifiers case-insensitively; and
4. warn if `anysphere.remote-ssh` is absent or the check cannot run.

Neither a missing CLI nor a failed extension query rolls back valid settings.
Boxdown prints an install suggestion when the CLI exists:

```sh
cursor --install-extension anysphere.remote-ssh
```

It never executes that command. This check is injectable in tests and is
skipped by the config writer itself, keeping settings operations deterministic.

The canonical URI builder uses the validated SSH alias as the remote authority
and applies `encodeURIComponent` to each workspace path segment, so spaces,
quotes, percent signs, and shell metacharacters do not appear raw. Output always
shows the URI separately and formats an executable command for the host
platform:

- macOS and Linux use the existing POSIX `shellQuote()` helper; and
- Windows emits an explicitly labelled PowerShell command whose URI is enclosed
  in single quotes, with the formatter still escaping any single quote
  defensively.

Boxdown does not claim that the PowerShell command is directly pasteable into
`cmd.exe` or a batch file; Windows documentation labels the supported shell.
Output also includes:

- the Cursor settings path;
- whether the platform mapping was installed, already Boxdown-managed, or
  preserved as user-owned;
- any prerequisite warning; and
- the exact open command.

External writes do not necessarily trigger Cursor's in-process settings or SSH
target refresh immediately. Output instructs the user to refresh Remote
Explorer or restart Cursor if the new alias is not visible.

## Target Registry and Agent Profiles

`SshConfigInstallTarget` gains `cursor`. Each
`SshInstallTargetDefinition` gains profile relevance metadata, for example
`usesContainerAgentProfile`:

| Target | Uses container agent profile |
| --- | --- |
| `codex` | Yes |
| `claude` | Yes |
| `cursor` | No |

A registry helper determines whether the final selection contains at least one
profile-relevant target. `resolveSetupAgentProfile` uses that predicate instead
of `targets.length > 0`. Its remaining explicit, recorded, interactive,
non-interactive, and cancellation behavior is unchanged.

The Cursor target definition delegates to `src/cursor-app-config.ts` for pure
path, parse, edit, ownership, and URI operations. The target wrapper owns CLI
messages and the prerequisite probe, following the existing Codex/Claude split.

## Failure Semantics

- Invalid Cursor JSONC, an incompatible existing platform value, or a mismatched
  SSH config path fails the selected target and returns the command's existing
  non-zero error behavior.
- A target failure does not roll back the already valid Boxdown SSH alias or a
  successfully created/reused container. Re-running the target after correcting
  settings is safe and idempotent.
- No Cursor settings write occurs until validation of the entire input and SSH
  config compatibility succeeds.
- Cursor settings and ownership writes use temporary sibling files plus atomic
  rename; temporary files are not treated as installed state.
- Best-effort prerequisite detection emits warnings only.
- Cleanup is conservative: uncertainty preserves user settings.
- Error and warning output never includes settings contents, extension output,
  credentials, or Cursor database data.

## Documentation Changes

- `docs/features/setup.md` will list Cursor commands, clarify that Cursor alone
  does not open the agent-profile selector, and show the printed open command.
- `docs/features/ssh-config-and-proxy.md` will add a Cursor target section,
  supported settings paths, SSH config compatibility, prerequisite behavior,
  URI shape, and targeted/unqualified cleanup examples.
- `docs/features/generated-config-and-state.md` will document
  `BOXDOWN_CURSOR_SETTINGS` and the per-workspace ownership record.
- `README.md`, `docs/architecture.md`, and `docs/testing.md` will update their
  hard-coded Codex/Claude target descriptions and test inventory.
- CLI usage and examples will list `cursor` through the central registry.
- The documentation will explicitly state that Boxdown never edits Cursor's
  internal databases or historical Dev Containers authorities.

## Testing Strategy

Tests will be written before implementation and grouped by responsibility.

### Cursor configuration unit tests

`__tests__/cursor-app-config.test.ts` will cover:

- macOS, Linux/XDG, and Windows settings path resolution;
- `BOXDOWN_CURSOR_SETTINGS` precedence and missing-environment errors;
- canonical URI generation and percent-encoding;
- POSIX command quoting and explicitly PowerShell-safe Windows command output;
- SSH config default, empty-default, explicit compatible, explicit mismatched,
  non-absolute, and unsupported interpolation cases;
- Windows SSH config resolution using `USERPROFILE` without `HOME`;
- creation from a missing or whitespace-only settings file;
- insertion into empty and populated JSONC;
- preservation of comments adjacent to inserted aliases, conservative
  retention of an owned alias with any attached comment, trailing-comma style,
  CRLF/LF, indentation, key order, byte-order mark, and unrelated settings;
- no-op behavior for an existing Linux value;
- rejection of invalid JSONC, non-object roots/parents, and conflicting alias
  values without a write;
- no settings mutation when ownership-record persistence fails;
- restoration of prior ownership state when a settings atomic write fails after
  ownership persistence;
- retention of ownership state when a cleanup settings write fails, allowing a
  retry;
- ownership propagation to a second workspace record;
- peer discovery from a valid ownership record whose `metadata.json` is absent;
- conservative retention when any scanned peer ownership record is malformed or
  unreadable;
- retention and cleanup of multiple alias/settings entries in one workspace
  record;
- global integration-lock contention, stale-lock rules, and recheck-after-lock
  behavior;
- preservation for pre-existing user-owned Linux values;
- shared-owner uninstall ordering;
- last-owner removal only while the value remains Linux;
- preservation after a user edit, unreadable peer record, missing settings
  file, or absent current record; and
- file modes and idempotent repeated operations.
- preservation of an existing settings-file symbolic link.

Tests use temporary settings, SSH config, and data roots. They do not read or
write the developer's real Cursor installation.

### Registry, CLI, profile, and purge tests

Existing suites will add cases for:

- parsing and de-duplicating `--target cursor`;
- including Cursor in supported-target text and interactive choices;
- install/uninstall dispatch and progress labels;
- targeted Cursor uninstall preserving the SSH alias;
- unqualified uninstall and workspace purge invoking every registry target's
  complete-workspace cleanup;
- install with alias A, install with alias B, then purge removing both mappings
  when each is last-owned;
- Cursor-only setup skipping the profile prompt;
- mixed Cursor/Codex or Cursor/Claude setup retaining the prompt;
- prerequisite check warnings versus fatal configuration failures;
- printed URI commands and no GUI-launch side effect; and
- purge plan wording and ownership cleanup before workspace data deletion.

Documentation-policy assertions will cover the three feature documents and the
public command examples.

### Verification

The final branch must pass:

```sh
pnpm test
pnpm run lint
pnpm run build
```

The first isolated-worktree baseline passed 511 of 512 tests on this host. The
sole failure was the existing toolchain lifecycle fixture treating the Node
executable's host path under `~/Library/Application Support/...` as an unquoted
shell token. Verification must run Node from a path without spaces and obtain a
clean full-suite result; Cursor work must not broaden scope to change that
unrelated fixture.

## Recommended Implementation Shape

The change should remain one feature with these focused responsibilities:

- `src/cursor-app-config.ts`: settings paths, JSONC edits, SSH config path
  validation, ownership records, install/uninstall results, and URI building.
- `src/ssh-install-targets.ts`: target metadata, Cursor wrapper output,
  prerequisite warning, and registry helpers.
- `src/setup-agent-profile.ts`: profile relevance instead of raw target count.
- `src/purge.ts`: registry-driven external integration cleanup.
- `src/ssh-config.ts`: platform-aware resolution shared by SSH installation and
  Cursor compatibility checks.
- focused tests in `__tests__/cursor-app-config.test.ts` plus existing CLI,
  setup-profile, purge, and documentation test suites.

This architecture uses Cursor's public configuration and CLI surfaces, leaves
the target repository untouched, and preserves a clear safety boundary around
Cursor-owned state.
