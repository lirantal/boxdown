# Agent Profile Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `none`, `auth`, and `full` agent-profile tiers, defaulting to isolated copies of authentication plus `~/.agents`, without allowing container writes to reach host agent profiles.

**Architecture:** Resolve one persisted profile selection before every container lifecycle, mount selected host sources read-only under `/opt/boxdown/agent-profile-source`, and copy them during `postCreateCommand` into writable container-local canonical homes. Keep selection in workspace metadata, generation intent in `BOXDOWN_AGENT_PROFILE`, and applied state in a container-local marker so status can distinguish selected, generated, and active profiles.

**Tech Stack:** TypeScript 5.5, Node.js 24, Node test runner, Dev Container JSON, Docker CLI, Bash lifecycle hooks, Markdown/Changesets.

## Global Constraints

- Preserve the behavior approved in
  `docs/superpowers/specs/2026-07-28-agent-profile-tiers-design.md`.
- Public profile values are exactly `none`, `auth`, and `full`; `auth` is the
  default.
- `auth` contains only supported file-backed authentication,
  `ANTHROPIC_API_KEY`, and the complete `~/.agents` tree.
- `full` copies opaque Codex and Claude user-profile roots. Boxdown must not
  parse or maintain allowlists for hooks, rules, commands, MCP servers,
  plugins, histories, or caches.
- Every host profile mount is read-only and targets a staging path. Never mount
  a Boxdown-selected source directly over `/home/node/.agents`,
  `/home/node/.codex`, `/home/node/.claude`, or
  `/home/node/.claude.json`.
- Canonical agent-profile destinations must remain writable only in the
  container layer. There is no reverse sync to the host.
- A user-provided mount at, above, or below a canonical destination makes that
  destination externally managed. Skip its Boxdown staging mount and copy.
- Preserve regular files, directories, and symlinks without following links.
  Warn and skip sockets, FIFOs, devices, and other special files.
- Missing optional sources and unreadable credential files are non-fatal.
  Failed `~/.agents` or full-directory copies are fatal and identify only the
  top-level source, never secret contents.
- `none` suppresses only `ANTHROPIC_API_KEY`; Snyk and 1Password secret
  forwarding remains unchanged.
- Repository-scoped files remain visible in all tiers through the existing
  workspace mount.
- Existing metadata without `agentProfile` resolves to `auth`; do not bump the
  metadata version for the optional field.
- Stop/start of the same container preserves copied state. Down, purge, and
  recreate discard it through their existing container-removal behavior.
- Do not enumerate arbitrary profile contents in status text, JSON, errors, or
  logs.
- Preserve unrelated worktree changes. In particular, do not edit or stage
  `docs/superpowers/plans/2026-07-28-interactive-container-reuse.md`.

---

### Task 1: Define, parse, resolve, and persist profile selection

**Files:**

- Create: `src/agent-profile.ts`
- Modify: `src/metadata.ts:6-105`
- Modify: `src/main.ts:24-153, 172-358, 1178-1190, 1282-1583`
- Modify: `__tests__/app.test.ts:288-670, 3544-3589, 3637-3650`

**Interfaces:**

- Consumes: raw `--agent-profile` values, optional
  `WorkspaceMetadata.agentProfile`, and the existing metadata writer.
- Produces:

  ```ts
  export const AGENT_PROFILES = ['none', 'auth', 'full'] as const
  export type AgentProfile = typeof AGENT_PROFILES[number]
  export const DEFAULT_AGENT_PROFILE: AgentProfile = 'auth'
  export type AgentProfileSelectionSource = 'explicit' | 'metadata' | 'default'

  export interface AgentProfileSelection {
    value: AgentProfile
    source: AgentProfileSelectionSource
  }

  export function isAgentProfile(value: string): value is AgentProfile
  export function resolveAgentProfile(
    explicit: AgentProfile | undefined,
    recorded: AgentProfile | undefined
  ): AgentProfileSelection
  ```

- Extends `ParsedCli` with `agentProfile?: AgentProfile`.
- Extends `WorkspaceMetadata` with `agentProfile?: AgentProfile`.
- Extends the metadata writer without breaking existing timestamp callers:

  ```ts
  export function writeWorkspaceMetadata(
    context: WorkspaceContext,
    sshAlias: string,
    now?: Date,
    agentProfile?: AgentProfile
  ): WorkspaceMetadata
  ```

- Changes `prepareContainerLifecycle(...)` to accept the already-resolved
  `AgentProfile` as an optional final argument and persist it after runtime
  preflight:

  ```ts
  export async function prepareContainerLifecycle(
    context: WorkspaceContext,
    alias: string,
    progress: ProgressReporter,
    options: RunCliOptions,
    logger?: WorkspaceCommandLogger,
    agentProfile?: AgentProfile
  ): Promise<void>
  ```

  The final argument defaults to `auth` for direct library callers.

- Profile flags are accepted only by commands that can create/recreate a
  container: `setup`, `start`, `ssh-proxy`, `tunnel`, `refresh-gh-token`, and
  `coding-agent`. `refresh-gh-token-running`, status, list, stop, down, purge,
  doctor, and SSH install/uninstall reject the flag.

- Resolution is performed once in `runCli()` after creating the workspace
  context:

  ```ts
  const recordedMetadata = readWorkspaceMetadata(context)
  const agentProfile = resolveAgentProfile(
    parsed.agentProfile,
    recordedMetadata?.agentProfile
  )
  ```

- Container-starting flows pass `agentProfile.value` through lifecycle and
  start options. Metadata-only SSH install continues preserving an existing
  profile when no profile argument is supplied.

- Setup writes the selected profile only after its state-free preflight and
  target-selection cancellation checks succeed.

**Steps:**

- [ ] Add failing unit tests for the domain resolver.

  Import the new symbols and test all precedence branches:

  ```ts
  assert.deepStrictEqual(resolveAgentProfile('full', 'none'), {
    value: 'full',
    source: 'explicit'
  })
  assert.deepStrictEqual(resolveAgentProfile(undefined, 'none'), {
    value: 'none',
    source: 'metadata'
  })
  assert.deepStrictEqual(resolveAgentProfile(undefined, undefined), {
    value: 'auth',
    source: 'default'
  })
  ```

  Also assert `isAgentProfile()` accepts exactly the three public values.

- [ ] Add failing CLI parser and help tests.

  Cover all three values on setup/start/coding-agent commands, an explicit
  value before or after the command, missing values, `other`, duplicate profile
  flags, and unsupported commands. Duplicate flags must fail with
  `--agent-profile can only be provided once`.

  Update existing deep-equality fixtures only where the optional field is
  present; do not add `agentProfile: undefined`.

  Assert `USAGE` includes:

  ```text
  --agent-profile <tier>
  ```

  and describes `none`, `auth`, `full`, the `auth` default, copy-on-create
  isolation, and the full-profile exposure warning.

- [ ] Run the focused parser tests and confirm they fail.

  ```bash
  node --import tsx --test \
    --test-name-pattern='agent profile|CLI parsing|stable metadata' \
    __tests__/app.test.ts
  ```

  Expected: FAIL because the domain module, CLI field, validation, help, and
  metadata property do not exist.

- [ ] Implement `src/agent-profile.ts` as a pure, dependency-free domain
  module.

  `resolveAgentProfile()` must use nullish precedence, not truthiness. Keep the
  type guard backed by `AGENT_PROFILES.includes(...)`.

- [ ] Extend metadata validation and writing.

  `isWorkspaceMetadata()` accepts an absent profile or a value passing
  `isAgentProfile()`. `writeWorkspaceMetadata()` writes an explicit profile;
  when the argument is absent it preserves an existing field and otherwise
  leaves it absent. Preserve all existing image/migration fields.

- [ ] Implement parser validation and CLI help.

  Parse the value early but validate command support in the existing
  `parsed()`/`parsedCodingAgent()` helpers. Reject a second flag. Do not accept
  aliases such as `bare` or `portable`.

- [ ] Resolve and persist one selection per lifecycle.

  Update `RunCliOptions.writeWorkspaceMetadata` to `typeof
  writeWorkspaceMetadata`. Pass the selected profile into
  `prepareContainerLifecycle`, setup metadata writes, `setupWorkspace`, and
  every `startDevcontainer`/`refreshContainerGhAuth` call. Task 2 consumes the
  value during generated-config creation, and Task 5 validates its applied
  container marker.

  At this task boundary, add the new optional fields to downstream option
  types so TypeScript compiles. Task 2 makes config generation consume the
  value, and Task 5 makes container-marker validation consume it.

- [ ] Add metadata migration tests.

  Write a version-1 metadata document with no profile and prove both a missing
  record and that legacy record resolve to `auth/default`. Then call the writer
  with `full`, rewrite without a profile argument, and assert `full` is
  preserved along with `firstSeenAt` and Docker image fields.

- [ ] Add a command-flow test proving an invalid value creates no metadata and
  performs no Docker/runtime call.

- [ ] Run focused tests.

  ```bash
  node --import tsx --test \
    --test-name-pattern='agent profile|CLI parsing|stable metadata|container lifecycle' \
    __tests__/app.test.ts
  ```

  Expected: PASS.

- [ ] Commit.

  ```bash
  git add src/agent-profile.ts src/metadata.ts src/main.ts __tests__/app.test.ts
  git commit -m "feat: add agent profile selection"
  ```

---

### Task 2: Discover complete host roots and generate isolated staging mounts

**Files:**

- Modify: `src/constants.ts:1-30`
- Modify: `src/paths.ts:1-226`
- Modify: `src/config.ts:1-177`
- Modify: `src/devcontainer.ts:1-17, 19-27, 293-350, 696-725`
- Delete: `src/mcp-config.ts`
- Modify: `__tests__/app.test.ts:5520-5850`

**Interfaces:**

- Consumes: `AgentProfile`, host environment, source existence, base-config
  mounts, and optional `GitSigningPlan`.
- Produces these context fields:

  ```ts
  hostAgentsDir: string
  hostCodexDir: string
  hostCodexAuthPath: string
  hostClaudeDir: string
  claudeCredentialsSupport: ClaudeCredentialsSupport
  hostClaudeCredentialsPath?: string
  hostClaudeConfigPath: string
  ```

- Removes `workspaceMcpConfigDir`, `workspaceClaudeMcpConfigPath`, and
  `hostCodexConfigPath`.
- Exports `defaultHostCodexDir()` and adds `defaultHostClaudeDir()`.
- Adds constants for:

  ```text
  /opt/boxdown/agent-profile-source
  /opt/boxdown/agent-profile-source/agents
  /opt/boxdown/agent-profile-source/codex
  /opt/boxdown/agent-profile-source/codex-auth.json
  /opt/boxdown/agent-profile-source/claude
  /opt/boxdown/agent-profile-source/claude-credentials.json
  /opt/boxdown/agent-profile-source/claude-config.json
  /opt/boxdown/state/agent-profile
  ```

- Keeps the existing call shape while adding a third parameter:

  ```ts
  export function buildGeneratedDevcontainerConfig(
    context: WorkspaceContext,
    signing?: GitSigningPlan,
    agentProfile?: AgentProfile
  ): DevcontainerConfig

  export function writeGeneratedDevcontainerConfig(
    context: WorkspaceContext,
    signing?: GitSigningPlan,
    agentProfile?: AgentProfile
  ): DevcontainerConfig
  ```

  An absent third argument resolves to `DEFAULT_AGENT_PROFILE`.

- Produces safe generated-config readers shared by lifecycle and status:

  ```ts
  export function agentProfileFromDevcontainerConfig(
    config: unknown
  ): AgentProfile | undefined

  export function readGeneratedAgentProfile(
    context: WorkspaceContext
  ): AgentProfile | undefined
  ```

  Both accept only a validated
  `containerEnv.BOXDOWN_AGENT_PROFILE`; malformed or unreadable generated JSON
  returns `undefined`.

- Extends `StartOptions` and `ContainerCommandOptions` with
  `agentProfile?: AgentProfile`, and passes it to every generated-config write.

- Adds pure mount conflict helpers:

  ```ts
  function mountTarget(mount: string): string | undefined
  function mountConflictsWithDestination(
    mount: string,
    destination: string
  ): boolean
  ```

  A conflict exists when the custom target equals the canonical destination,
  contains it, or is contained by it. This prevents replacing a mounted parent
  or a directory containing a mounted child.

**Tier mount matrix:**

| Tier | Host source | Staging target | Canonical conflict target |
| --- | --- | --- | --- |
| `none` | none | none | n/a |
| `auth` | `hostAgentsDir` | `.../agents` | `/home/node/.agents` |
| `auth` | `hostCodexAuthPath` | `.../codex-auth.json` | `/home/node/.codex/auth.json` |
| `auth` | `hostClaudeCredentialsPath` | `.../claude-credentials.json` | `/home/node/.claude/.credentials.json` |
| `full` | `hostAgentsDir` | `.../agents` | `/home/node/.agents` |
| `full` | `hostCodexDir` | `.../codex` | `/home/node/.codex` |
| `full` | `hostClaudeDir` | `.../claude` | `/home/node/.claude` |
| `full` | separate `hostClaudeConfigPath` | `.../claude-config.json` | `/home/node/.claude.json` |

Every matrix mount ends with `,readonly`. In `full`, do not add a separate
Claude config-file mount when its path is equal to or located inside
`hostClaudeDir`; that content is already part of the opaque directory copy.

Generated config also:

- sets `containerEnv.BOXDOWN_AGENT_PROFILE`;
- sets `containerEnv.BOXDOWN_AGENT_PROFILE_SOURCES` to a sorted,
  comma-separated subset of `agents`, `codex-auth`, `claude-auth`,
  `codex-home`, `claude-home`, and `claude-config` discovered at generation
  time among sources selected by the tier; this records no contents and lets
  status avoid
  rescanning opaque trees;
- passes `BOXDOWN_AGENT_PROFILE` into `initializeCommand`;
- preserves unrelated Boxdown and base-config mounts;
- never contains credential contents;
- never adds a canonical profile mount; and
- no longer prepares or mounts a Claude MCP projection.

**Steps:**

- [ ] Replace the old MCP/direct-mount tests with failing matrix tests.

  Use temporary homes with all sources present. For each tier, assert exact
  source/target inclusion and exclusion, `readonly` on every staging mount,
  and absence of any Boxdown mount targeting a canonical profile path.
  Assert the sorted `BOXDOWN_AGENT_PROFILE_SOURCES` value for present,
  missing, and custom-owned sources; custom ownership changes copy behavior,
  while the availability list continues to report whether the host source was
  discovered.

  Explicitly assert `auth` excludes:

  ```text
  ~/.codex/config.toml
  ~/.codex/AGENTS.md
  ~/.claude/settings.json
  ~/.claude/CLAUDE.md
  ~/.claude/commands
  ~/.claude/hooks
  ~/.claude/plugins
  ~/.claude.json
  workspace runtime MCP projection
  ```

  The test should create these files but prove no generated mount mentions
  them.

- [ ] Add failing environment-root tests.

  With `CODEX_HOME=/custom/codex` and
  `CLAUDE_CONFIG_DIR=/custom/claude`, assert the context selects those complete
  roots, credential paths are derived from the selected roots on supported
  platforms, and the nested `.claude.json` is not staged separately in `full`.
  With neither variable, assert `~/.codex`, `~/.claude`, and separate
  `~/.claude.json`.

- [ ] Add failing custom-mount conflict tests.

  Create base configs with mount targets at:

  ```text
  /home/node/.agents
  /home/node/.codex
  /home/node/.codex/auth.json
  /home/node/.claude
  /home/node/.claude/.credentials.json
  /home/node/.claude.json
  /home/node
  /home/node/.codex/custom-child
  ```

  Assert the affected Boxdown staging source is absent while unrelated sources
  remain. Preserve every custom mount byte-for-byte in generated config.

- [ ] Run the focused generated-config tests and confirm they fail.

  ```bash
  node --import tsx --test \
    --test-name-pattern='agent profile mounts|custom profile mounts|host agent paths|Claude MCP' \
    __tests__/app.test.ts
  ```

  Expected: FAIL on old canonical mounts and MCP projection.

- [ ] Implement constants and host-root discovery.

  Use platform-aware `join` behavior already present in `paths.ts`. Compute
  `hostCodexAuthPath` from `hostCodexDir`, `hostClaudeCredentialsPath` from
  `hostClaudeDir` on file-backed platforms, and leave the macOS Keychain
  limitation unchanged.

- [ ] Implement the tier mount matrix and conflict checks in `config.ts`.

  Use `statSync` only for top-level source classification; do not traverse a
  profile on the host. Treat missing/unreadable sources as absent. Keep mount
  target comparison path-boundary-aware so `/home/node/.codex-other` does not
  conflict with `/home/node/.codex`.

- [ ] Thread `agentProfile` through generated-config writers.

  Remove both `prepareMcpConfig()` calls and the `prepareClaudeMcpConfig`
  import. Pass `options.agentProfile` from `startDevcontainer()` and
  `refreshContainerGhAuth()`.

- [ ] Delete `src/mcp-config.ts`, its imports, and its runtime path fields.

  Preserve general runtime-directory cleanup; do not add special migration
  deletion because existing purge/runtime cleanup already removes the old
  projection.

- [ ] Run focused tests.

  ```bash
  node --import tsx --test \
    --test-name-pattern='agent profile mounts|custom profile mounts|host agent paths|generated devcontainer config' \
    __tests__/app.test.ts
  ```

  Expected: PASS.

- [ ] Run the type build to catch every removed field/import.

  ```bash
  pnpm run build
  ```

  Expected: PASS with no reference to `mcp-config.ts`,
  `workspaceMcpConfigDir`, `workspaceClaudeMcpConfigPath`, or
  `hostCodexConfigPath`.

- [ ] Commit.

  ```bash
  git add src/constants.ts src/paths.ts src/config.ts src/devcontainer.ts \
    src/mcp-config.ts __tests__/app.test.ts
  git commit -m "feat: stage isolated agent profile sources"
  ```

---

### Task 3: Copy staged sources into writable container-local profiles

**Files:**

- Create: `assets/devcontainer/utils/agent-profile-bootstrap.mjs`
- Create: `__tests__/agent-profile-bootstrap.test.ts`
- Modify: `assets/devcontainer/hooks/post-create.sh:7-69`
- Modify: `assets/image/Dockerfile:29-48`
- Modify: `assets/image/lifecycle-smoke-test.sh`
- Modify: `__tests__/app.test.ts:8233-8250`
- Modify: `__tests__/image-input-policy.test.ts:129-172`

**Interfaces:**

- Consumes these environment variables:

  ```text
  BOXDOWN_AGENT_PROFILE
  BOXDOWN_AGENT_PROFILE_SOURCE_DIR
  BOXDOWN_AGENT_PROFILE_HOME
  BOXDOWN_AGENT_PROFILE_MARKER_PATH
  ```

  Production defaults are respectively `auth`,
  `/opt/boxdown/agent-profile-source`, `/home/node`, and
  `/opt/boxdown/state/agent-profile`. The last three overrides exist only to
  make the exact production copier testable without touching a developer's
  home.

- Produces canonical destinations:

  ```text
  $HOME/.agents
  $HOME/.codex/auth.json              # auth
  $HOME/.claude/.credentials.json     # auth, when available
  $HOME/.codex                        # full
  $HOME/.claude                       # full
  $HOME/.claude.json                  # full, when separately staged
  ```

- Writes the selected profile plus a newline to the marker only after every
  required copy succeeds.

- Exits zero for missing optional sources and unreadable credential files.
  Exits non-zero for a failed `.agents` or full-tree copy.

**Copy algorithm:**

- Parse only the three valid profile values; invalid/missing generated values
  fail closed except that a truly absent variable defaults to `auth` for
  compatibility.
- Use `lstat`, `readdir`, `readlink`, `symlink`, and `copyFile`; never use
  `stat` during recursion and never follow a symlink.
- Copy into a temporary sibling under the destination home. Move an existing
  canonical destination to a unique backup sibling, rename the completed
  temporary copy into place, then remove the backup. If the second rename
  fails, restore the backup. Clean only those exact temporary/backup paths.
- Copy directories with source permissions plus user `rwx`; copy regular files
  with source permissions plus user `rw`; preserve executable bits.
- Skip non-file/non-directory/non-symlink entries with a warning containing the
  top-level logical source and relative path, not file contents.
- For `auth`, replace `.agents` atomically and copy credential files
  atomically into otherwise container-local vendor directories. Do not remove
  or create sibling vendor config.
- For `full`, atomically replace each staged top-level tree/file.
- If a staging source is absent because the host source was missing or a
  custom destination owns it, leave the canonical destination unchanged.
- Create the marker's parent if possible and atomically replace the marker.

**Steps:**

- [ ] Write failing black-box copier tests in the new test file.

  Spawn the `.mjs` file with temporary source/home/marker roots and cover:

  1. `none` copies nothing and writes `none`.
  2. `auth` copies only two credentials plus all `.agents` content.
  3. `auth` leaves sibling `config.toml`, `settings.json`, and `.claude.json`
     absent.
  4. `full` copies all four opaque top-level sources.
  5. Source trees are byte-for-byte unchanged after bootstrap and simulated
     writes to canonical copies.
  6. Two home roots seeded from one source are independently writable.
  7. A relative and an absolute symlink remain symlinks and external targets
     are not copied.
  8. A FIFO created with `mkfifo` is skipped with a warning.
  9. Missing sources are non-fatal.
  10. An unreadable credential is a non-fatal warning where the current user
      can reproduce unreadability.
  11. A failed directory copy leaves the previous canonical directory and no
      success marker.
  12. An absent staging source leaves a pre-existing custom-destination
      sentinel unchanged.

- [ ] Run the new test and confirm it fails.

  ```bash
  node --import tsx --test __tests__/agent-profile-bootstrap.test.ts
  ```

  Expected: FAIL because the bootstrap does not exist.

- [ ] Implement the Node bootstrap.

  Keep it dependency-free and do not shell out. Prefix warnings with
  `agent-profile-bootstrap:`. Ensure thrown errors identify `~/.agents`,
  `$CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or `.claude.json` only at the top level.

- [ ] Invoke the copier before workspace dependency installation.

  Add this as the first `post-create.sh` step:

  ```bash
  run_step "Copying isolated agent profile" configure_agent_profile
  ```

  and implement:

  ```bash
  configure_agent_profile() {
    node "${DEVCONTAINER_DIR}/utils/agent-profile-bootstrap.mjs"
  }
  ```

  Running before Git/SSH setup is acceptable and makes the marker available
  for every later lifecycle step. The hard requirement is that it precedes
  dependency installation and any coding-agent launch.

- [ ] Make the marker directory writable after the image's `node` UID is
  remapped.

  Extend the Dockerfile's directory-creation layer. The state parent must not
  rely on the build-time `node` UID because `updateRemoteUserUID` can change it
  when the container is created:

  ```dockerfile
  RUN install -d -m 1777 -o root -g root /opt/boxdown/state \
      && install -d -m 0700 -o node -g node \
          /home/node/.claude /home/node/.codex
  ```

  Do not store runtime scripts or required image assets under an agent home.

- [ ] Extend image/lifecycle policy tests.

  Assert the Dockerfile creates `/opt/boxdown/state` as a root-owned sticky
  directory; post-create invokes the new bootstrap; and the lifecycle smoke
  test remaps the `node` UID, runs the bootstrap as that non-root user against
  the actual `/opt/boxdown/state/agent-profile` path, then proves copied files
  are writable and the marker remains owner-only mode `0600`.

- [ ] Run focused tests.

  ```bash
  node --import tsx --test __tests__/agent-profile-bootstrap.test.ts
  node --import tsx --test \
    --test-name-pattern='post-create|agent profile|non-root lifecycle' \
    __tests__/app.test.ts __tests__/image-input-policy.test.ts
  bash -n assets/devcontainer/hooks/post-create.sh
  bash -n assets/image/lifecycle-smoke-test.sh
  ```

  Expected: PASS.

- [ ] Commit.

  ```bash
  git add assets/devcontainer/utils/agent-profile-bootstrap.mjs \
    assets/devcontainer/hooks/post-create.sh assets/image/Dockerfile \
    assets/image/lifecycle-smoke-test.sh \
    __tests__/agent-profile-bootstrap.test.ts __tests__/app.test.ts \
    __tests__/image-input-policy.test.ts
  git commit -m "feat: bootstrap writable agent profiles"
  ```

---

### Task 4: Enforce secret-tier policy without affecting unrelated secrets

**Files:**

- Modify: `assets/devcontainer/hooks/initialize.sh:7-107`
- Modify: `__tests__/app.test.ts:6200-6367`

**Interfaces:**

- Consumes `BOXDOWN_AGENT_PROFILE`, passed literally by generated
  `initializeCommand`.
- Produces:
  - `none`: removes any stale runtime `ANTHROPIC_API_KEY` file.
  - `auth`/`full`: preserves the current host-environment refresh behavior.
  - every tier: unchanged `SNYK_TOKEN` and `OP_SERVICE_ACCOUNT_TOKEN`
    behavior.

**Steps:**

- [ ] Add a failing table-driven initialize-hook test.

  Seed all three secret files, invoke `initialize.sh` once for each profile in
  an isolated secret directory, and assert:

  ```ts
  none -> no ANTHROPIC_API_KEY; SNYK and OP remain governed normally
  auth -> ANTHROPIC_API_KEY copied when present
  full -> ANTHROPIC_API_KEY copied when present
  ```

  Also run `none` with the host variable absent after a previous `auth` run to
  prove stale credentials are deleted.

- [ ] Run the focused test and confirm it fails.

  ```bash
  node --import tsx --test \
    --test-name-pattern='runtime secret|ANTHROPIC_API_KEY|agent profile' \
    __tests__/app.test.ts
  ```

  Expected: FAIL because `none` still forwards the host value.

- [ ] Implement the narrow policy in `refresh_runtime_secret_environment()`.

  Use:

  ```bash
  if [[ "${BOXDOWN_AGENT_PROFILE:-auth}" == "none" ]]; then
    rm -f "${SECRET_ENV_DIR}/ANTHROPIC_API_KEY"
  else
    refresh_host_environment_secret "ANTHROPIC_API_KEY"
  fi
  ```

  Leave both subsequent secret refreshes unchanged.

- [ ] Run focused verification.

  ```bash
  node --import tsx --test \
    --test-name-pattern='runtime secret|ANTHROPIC_API_KEY|agent profile' \
    __tests__/app.test.ts
  bash -n assets/devcontainer/hooks/initialize.sh
  ```

  Expected: PASS.

- [ ] Commit.

  ```bash
  git add assets/devcontainer/hooks/initialize.sh __tests__/app.test.ts
  git commit -m "feat: scope Claude API auth by profile"
  ```

---

### Task 5: Propagate the profile through every container lifecycle and detect stale containers

**Files:**

- Modify: `src/devcontainer.ts:19-27, 92-195, 293-428, 696-725`
- Modify: `src/main.ts:983-1002, 1178-1190, 1318-1583`
- Modify: `__tests__/app.test.ts` near existing setup, runtime lifecycle, fake
  Docker, coding-agent, tunnel, SSH proxy, and GitHub auth tests

**Interfaces:**

- Produces:

  ```ts
  export async function inspectContainerAgentProfile(
    containerId: string,
    options?: { logger?: WorkspaceCommandLogger }
  ): Promise<AgentProfile | undefined>
  ```

  It runs:

  ```text
  docker exec <container-id> cat /opt/boxdown/state/agent-profile
  ```

  It returns a validated profile or `undefined` for a missing/unreadable marker
  and never returns arbitrary marker text.

- `startDevcontainer()` writes configuration with the selected tier, starts or
  reuses the container, then validates the marker. Before replacing generated
  config, it also inspects an existing container and the prior generated
  profile. A known mismatch, or no valid profile evidence for a pre-existing
  container, fails before `devcontainer up` unless `recreate` is true. A marker
  different from the selection after start, or no valid marker on a
  pre-existing/reused container, fails with:

  ```text
  Agent profile <selected> is not active in this devcontainer.
  Run `boxdown start --recreate --agent-profile <selected>`.
  ```

- A newly created container is expected to have a valid marker after successful
  `devcontainer up`; a missing marker is a lifecycle failure, not a silent
  success.

- `refreshContainerGhAuth()` receives the resolved selection so it cannot
  rewrite a `full` generated config as default `auth`.

**Steps:**

- [ ] Extend the fake Docker helper to model marker reads.

  Allow each fake container to specify `agentProfileMarker?: string`. Record
  `docker exec ... cat` calls and return a non-zero status for absent markers.

- [ ] Add failing marker parser/probe tests.

  Cover `none`, `auth`, `full`, whitespace, invalid content, absent marker, and
  a Docker error. Invalid content must return `undefined`, not leak into output.

- [ ] Add failing propagation tests.

  Table-drive setup, start, Codex, Claude, OpenCode, Antigravity, SSH proxy,
  tunnel, and `refresh-gh-token`. Inject lifecycle seams where possible and
  assert the same resolved value reaches:

  1. metadata persistence;
  2. `StartOptions.agentProfile`; and
  3. GitHub-auth generated config refresh.

  Cover explicit > metadata > default in real command dispatch, not only the
  pure resolver.

- [ ] Add failing stale-container tests.

  Prove:

  - selected `full` + running marker `auth` fails with recreate guidance;
  - selected `auth` + missing legacy marker fails with recreate guidance;
  - matching markers allow normal reuse;
  - `--recreate` seeds a fresh marker through the fake `devcontainer up` path;
  - stop/start with a matching marker does not invoke the bootstrap directly;
    Docker preserves the container layer;
  - down/recreate behavior relies on existing container removal and a later
    post-create seed, with no host-profile deletion.

- [ ] Run focused lifecycle tests and confirm they fail.

  ```bash
  node --import tsx --test \
    --test-name-pattern='agent profile.*lifecycle|profile marker|recreate.*profile|propagates agent profile' \
    __tests__/app.test.ts
  ```

  Expected: FAIL because marker probing and full propagation do not exist.

- [ ] Implement marker inspection with `runBuffered()`.

  Mirror neither stdout nor stderr. Treat non-zero exit, empty output, and
  invalid values as `undefined`.

- [ ] Centralize post-start marker validation.

  Before overwriting generated config, use the running marker when available
  and otherwise the prior generated profile to reject a stale existing
  container. Call post-start validation for both the `reuseRunning`
  early-return path and the normal `devcontainer up` result before
  recording/returning success. Do not run or mutate the bootstrap from the
  host.

- [ ] Complete lifecycle propagation.

  Ensure direct callers default to `auth`, while `runCli()` always passes the
  resolved value. Keep setup's preflight-before-metadata ordering and
  non-container commands' no-write contract.

- [ ] Run focused tests.

  ```bash
  node --import tsx --test \
    --test-name-pattern='agent profile.*lifecycle|profile marker|recreate.*profile|propagates agent profile|container lifecycle' \
    __tests__/app.test.ts
  ```

  Expected: PASS.

- [ ] Commit.

  ```bash
  git add src/devcontainer.ts src/main.ts __tests__/app.test.ts
  git commit -m "feat: enforce active container profiles"
  ```

---

### Task 6: Replace credential-only status with tier-aware profile status

**Files:**

- Modify: `src/status.ts:1-390`
- Modify: `src/main.ts:7-20, 1359-1369`
- Modify: `__tests__/app.test.ts:3703-3920`

**Interfaces:**

- Removes the top-level `claude.credentials` status section.
- Produces:

  ```ts
  export type AgentProfileSourceState =
    | 'available'
    | 'missing'
    | 'unsupported'
    | 'custom'
    | 'not-selected'

  export type ContainerProfileState =
    | 'active'
    | 'recreate-required'
    | 'not-created'
    | 'unknown'

  export interface AgentProfileStatus {
    selected: AgentProfile
    selectionSource: AgentProfileSelectionSource
    generated?: AgentProfile
    container?: AgentProfile
    containerState: ContainerProfileState
    sources: {
      codexAuthentication: AgentProfileSourceState
      claudeAuthentication: AgentProfileSourceState
      agents: AgentProfileSourceState
      codexHome: AgentProfileSourceState
      claudeHome: AgentProfileSourceState
      claudeConfig: AgentProfileSourceState
    }
    customDestinations: string[]
  }
  ```

- `createStatusInfo()` receives:

  ```ts
  agentProfileSelection?: AgentProfileSelection
  containerAgentProfile?: AgentProfile
  isDirectory?: (path: string) => boolean
  ```

  It defaults selection using metadata read by the caller, never by traversing
  a profile.

- Parse `containerEnv.BOXDOWN_AGENT_PROFILE` from the generated JSON only when
  it is a valid public value.
- Parse canonical custom mount targets from generated JSON. Since Boxdown's own
  profile mounts now target staging paths, any canonical target is
  user-provided.
- When generated config matches the selected profile, derive top-level source
  availability from `BOXDOWN_AGENT_PROFILE_SOURCES` plus staging/custom mount
  targets so status reports generation-time truth even if a host source was
  later added or removed. When no matching generated config exists, use
  current top-level host probes and mark the container state separately as
  not-created or recreate-required.
- `containerState` rules:

  | Condition | State |
  | --- | --- |
  | no container | `not-created` |
  | selected = generated = valid running marker | `active` |
  | selected differs from generated or valid marker | `recreate-required` |
  | container exists but stopped/no readable marker and no known mismatch | `unknown` |

- `statusIsHealthy()` continues to describe infrastructure health; an explicit
  `recreate-required` profile makes status unhealthy, while missing optional
  auth sources do not.

**Steps:**

- [ ] Add failing status-shape and formatting tests.

  Cover `none`, default `auth`, recorded `full`, missing sources, macOS
  Keychain, custom canonical destinations, matching active marker, mismatched
  marker, stale generated config, stopped/unknown container, and no container.
  Generate once with a source present and then delete it, and once with a
  source absent and then create it, to prove matching generated status is based
  on the recorded staging mount rather than current tree contents.

  Assert text contains the approved shape:

  ```text
  Agent profile: auth (default)
    Codex authentication: available
    Claude authentication: unavailable (macOS Keychain is not copied)
    ~/.agents: available
    Container profile: recreate required
  ```

  For JSON, assert the exact `agentProfile` object and prove it does not contain
  nested filenames such as plugin, hook, history, or MCP entries created under
  the source roots.

- [ ] Add a failing `runCli(['status'])` test.

  Inject or fake a running container marker and assert the command passes the
  validated marker plus metadata/default selection into `createStatusInfo`.
  Status must remain read-only and must not write metadata or generated config.

- [ ] Run focused status tests and confirm they fail.

  ```bash
  node --import tsx --test \
    --test-name-pattern='status.*agent profile|formats status|status does not record' \
    __tests__/app.test.ts
  ```

  Expected: FAIL on the current Claude-credential-only model.

- [ ] Implement top-level source inspection.

  Use `statSync().isFile()`/`.isDirectory()` only on the six known top-level
  paths. `none` reports every source as `not-selected`. `auth` reports the two
  credential sources and `.agents`; its vendor homes/config are
  `not-selected`. `full` reports complete roots and `.agents`; credential
  availability is inferred from top-level credential support/path without
  enumerating the copied tree.

- [ ] Implement generated-config and custom-destination inspection.

  Parse defensively. An absent, unreadable, or invalid generated file yields no
  generated profile and no crash. Sort/dedupe custom destinations for stable
  text and JSON.

- [ ] Replace text formatting.

  Render `available`, `missing`, `unsupported`, `custom`, and `not-selected`
  plainly. Mention macOS Keychain only when relevant. Render profile source as
  `(default)` or `(workspace metadata)`. Add recreate guidance only for
  `recreate-required`.

- [ ] Wire status marker inspection in `runCli()`.

  Call `inspectContainerAgentProfile()` only for a running container. Resolve
  status selection from `readWorkspaceMetadata(context)?.agentProfile`; do not
  honor an unsupported explicit status flag.

- [ ] Run focused tests.

  ```bash
  node --import tsx --test \
    --test-name-pattern='status.*agent profile|formats status|status does not record' \
    __tests__/app.test.ts
  ```

  Expected: PASS.

- [ ] Commit.

  ```bash
  git add src/status.ts src/main.ts __tests__/app.test.ts
  git commit -m "feat: report agent profile status"
  ```

---

### Task 7: Document migration, risks, and the stable user contract

**Files:**

- Modify: `README.md:60-105, 280-330`
- Modify: `docs/features/setup.md`
- Modify: `docs/features/start-and-shell.md`
- Modify: `docs/features/generated-config-and-state.md`
- Modify: `docs/features/lifecycle.md`
- Modify: `docs/architecture.md`
- Modify: `assets/devcontainer/README.md`
- Modify: `docs/todo.md` if it still claims MCP projection is pending/current
- Create: `.changeset/calm-agents-copy.md`
- Modify: `__tests__/app.test.ts` near help/documentation assertions

**Interfaces:**

- Consumes the finished public behavior.
- Produces one authoritative documentation table:

  | CLI | Contents |
  | --- | --- |
  | `none` | no host user-scoped agent profile or Claude API key |
  | `auth` | file-backed auth, Claude API key, complete `~/.agents` |
  | `full` | opaque complete Codex/Claude homes plus `~/.agents` |

- Produces a major changeset because the default config/auth lifecycle is an
  intentional breaking change.

**Steps:**

- [ ] Add failing documentation assertions.

  Read the public docs and assert they mention:

  - all three values and `auth` default;
  - `--agent-profile none|auth|full`;
  - read-only staging plus container-local writable copies;
  - no reverse synchronization;
  - stop/start preservation and down/recreate reset;
  - repository-scoped config remains visible;
  - macOS Keychain is not copied;
  - full-profile sensitivity, size, portability, broken-path, and native
    dependency risks;
  - custom canonical mounts are externally managed;
  - previous Codex config, Claude MCP projection, and writable Claude
    credential mount behavior changed; and
  - users relying on user-scoped MCP should move portable config into the repo
    or choose `full`.

- [ ] Run the documentation test and confirm it fails.

  ```bash
  node --import tsx --test \
    --test-name-pattern='documents agent profile tiers|usage text' \
    __tests__/app.test.ts
  ```

  Expected: FAIL because public docs describe the previous forwarding model.

- [ ] Update README and feature docs.

  Keep the design spec as the detailed rationale, but make README sufficient
  for selection and security decisions. Explicitly say "copy on container
  creation", not "sync" or "mount into the agent home".

- [ ] Update architecture and lifecycle docs.

  Document the three truth points:

  ```text
  metadata selection -> generated staging intent -> container applied marker
  ```

  Explain why a mismatch requires recreation and why host changes do not update
  a stopped/running existing container.

- [ ] Update asset documentation.

  Describe the bootstrap order, staging tree, marker, non-root ownership, and
  source-file failure policy. Remove direct canonical mount and Claude MCP
  projection claims.

- [ ] Add a major Changeset entry.

  Use:

  ```md
  ---
  "boxdown": major
  ---

  Add isolated `none`, `auth`, and `full` agent profiles. The new `auth`
  default copies file-backed authentication and `~/.agents` into each
  container; user-scoped Codex config and Claude MCP projection now require
  `full` or repository-scoped configuration.
  ```

- [ ] Run focused documentation checks.

  ```bash
  node --import tsx --test \
    --test-name-pattern='documents agent profile tiers|usage text' \
    __tests__/app.test.ts
  pnpm run lint:markdown
  ```

  Expected: PASS.

- [ ] Commit.

  ```bash
  git add README.md docs/features/setup.md docs/features/start-and-shell.md \
    docs/features/generated-config-and-state.md docs/features/lifecycle.md \
    docs/architecture.md assets/devcontainer/README.md docs/todo.md \
    .changeset/calm-agents-copy.md __tests__/app.test.ts
  git commit -m "docs: explain isolated agent profiles"
  ```

---

### Task 8: Run full regression and security verification

**Files:**

- Modify only files required to fix regressions introduced by Tasks 1-7.

**Steps:**

- [ ] Prove obsolete behavior and symbols are gone.

  ```bash
  rg -n \
    'prepareClaudeMcpConfig|workspaceMcpConfigDir|workspaceClaudeMcpConfigPath|hostCodexConfigPath|mcp-config' \
    src __tests__ README.md docs assets
  ```

  Expected: no runtime/code references. Historical design/plan documents may
  retain the names as history; review those matches manually rather than
  editing prior records.

- [ ] Prove no selected host profile is mounted at a canonical destination.

  ```bash
  rg -n \
    'source=.*host(Agents|Codex|Claude).*target=/home/node/\.(agents|codex|claude)' \
    src __tests__
  ```

  Expected: no implementation match. Test fixtures may contain deliberate
  custom-mount cases only.

- [ ] Run bootstrap and shell verification.

  ```bash
  node --import tsx --test __tests__/agent-profile-bootstrap.test.ts
  bash -n assets/devcontainer/hooks/initialize.sh
  bash -n assets/devcontainer/hooks/post-create.sh
  bash -n assets/image/lifecycle-smoke-test.sh
  ```

  Expected: PASS.

- [ ] Run all tests.

  ```bash
  pnpm test
  ```

  Expected: PASS with no failed tests.

- [ ] Run lint and build.

  ```bash
  pnpm run lint
  pnpm run build
  ```

  Expected: PASS.

- [ ] Check generated/public package contents without publishing.

  ```bash
  pnpm pack --dry-run
  ```

  Expected: the bootstrap asset, source modules, docs, and changeset-supported
  package metadata are present; no host credentials or generated workspace
  state are included.

- [ ] Check whitespace and review the complete diff.

  ```bash
  git diff --check
  git status --short
  git diff --stat
  git diff
  ```

  Expected: no whitespace errors; only the planned files plus the user's
  unrelated untracked interactive-reuse plan.

- [ ] Perform a final security review against the design spec.

  Check each item explicitly:

  - every profile source mount ends in `readonly`;
  - no canonical Boxdown profile mount exists;
  - custom destination conflicts skip bootstrap input;
  - `none` removes stale `ANTHROPIC_API_KEY`;
  - credential contents never enter generated JSON, metadata, status, or logs;
  - symlinks are not dereferenced;
  - special files are skipped;
  - copied trees are writable and independent;
  - a marker is written only after successful copy;
  - stale containers require recreation; and
  - status reports only top-level availability.

- [ ] Commit any narrowly scoped regression corrections, then leave the branch
  ready for review.

  Stage each corrected planned file by its explicit path and commit:

  ```bash
  git commit -m "test: verify isolated agent profiles"
  ```

  Skip this commit when verification required no corrections.
