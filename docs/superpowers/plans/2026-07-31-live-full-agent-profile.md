# Live Full Agent Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `full` expose the host's complete agent profile through live,
read-write canonical mounts instead of recursively copying it during container
creation.

**Architecture:** Keep `none` and `auth` on their current copy-on-create paths.
For `full`, the generated devcontainer config binds available host sources
directly to canonical agent paths and the bootstrap writes a `full:live` marker
without copying data. A parsed marker mode distinguishes the new live profile
from legacy copied `full` containers and makes them recreate safely.

**Tech Stack:** TypeScript, Node.js test runner, JSON devcontainer config,
shell lifecycle hook, Node.js ESM bootstrap utility, Markdown documentation.

## Global Constraints

- Keep the public CLI values exactly `none`, `auth`, and `full`; do not add a
  `live` CLI option.
- `auth` remains staged read-only then copied into container-local storage.
- `full` mounts selected host profile sources read-write at canonical paths.
- Existing user mounts remain authoritative for overlapping canonical paths.
- A legacy `full` marker must require `--recreate`; do not migrate a container
  in place.
- Do not log agent-profile paths, file names, or contents beyond the current
  canonical logical source labels.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/agent-profile.ts` | Agent-profile access mode, marker encoding, and marker parsing. |
| `src/config.ts` | Generates read-only staging mounts for `auth` and direct writable canonical mounts for `full`. |
| `src/devcontainer.ts` | Reads the structured profile marker and rejects legacy copied full containers. |
| `src/status.ts` | Reports the selected access behavior and uses marker mode to show recreate-required. |
| `assets/devcontainer/utils/agent-profile-bootstrap.mjs` | Keeps `auth` copying behavior; marks `full` as live without copying. |
| `src/setup-agent-profile.ts`, `src/main.ts` | Uses accurate live-mount prompt and help text. |
| `README.md`, `docs/features/*.md`, `assets/devcontainer/README.md` | Describes the public behavior and recreation migration. |
| `__tests__/agent-profile-bootstrap.test.ts`, `__tests__/app.test.ts` | Regression coverage for configuration, marker migration, status, prompt/help, and docs. |

## Task 1: Model full-profile live access and direct mount generation

**Files:**
- Modify: `src/agent-profile.ts`
- Modify: `src/config.ts:86-226`
- Modify: `__tests__/app.test.ts` (profile marker and generated-config tests)

**Interfaces:**
- Produces `AgentProfileContainerMode = 'copy' | 'live' | 'legacy'`.
- Produces `ContainerAgentProfile { profile: AgentProfile, mode: AgentProfileContainerMode }`.
- Produces `agentProfileMarker(profile: AgentProfile): string` and
  `parseAgentProfileMarker(value: string): ContainerAgentProfile | undefined`.
- Consumes `AgentProfileSource.canonicalDestination` to select either staging
  or direct mount targets.

- [ ] **Step 1: Write failing unit tests for live full mounts and markers**

  Add assertions that establish the desired public contract:

  ```ts
  assert.deepStrictEqual(parseAgentProfileMarker('full:live'), {
    profile: 'full', mode: 'live'
  })
  assert.deepStrictEqual(parseAgentProfileMarker('full'), {
    profile: 'full', mode: 'legacy'
  })
  assert.strictEqual(agentProfileMarker('full'), 'full:live')

  const config = buildGeneratedDevcontainerConfig(context, undefined, 'full')
  const fullMounts = config.mounts?.filter(mount =>
    typeof mount === 'string' && mount.includes('/home/node/.codex')
  ) ?? []
  assert.ok(fullMounts.some(mount =>
    mount.includes(`source=${context.hostCodexDir},target=/home/node/.codex`) &&
    !mount.endsWith(',readonly')
  ))
  assert.ok(!config.mounts?.some(mount =>
    typeof mount === 'string' && mount.includes('/opt/boxdown/agent-profile-source')
  ))
  ```

  Cover all four available full sources and retain the existing test that a
  custom canonical mount prevents Boxdown from adding its own source mount.

- [ ] **Step 2: Run the focused tests and verify they fail for the intended reason**

  Run:

  ```sh
  pnpm test -- __tests__/app.test.ts
  ```

  Expected: failures because `full:live` is not parsed and generated `full`
  mounts still target `/opt/boxdown/agent-profile-source/*` with `readonly`.

- [ ] **Step 3: Add marker and access-mode helpers**

  In `src/agent-profile.ts`, add these exact exports after `AgentProfile`:

  ```ts
  export type AgentProfileContainerMode = 'copy' | 'live' | 'legacy'

  export interface ContainerAgentProfile {
    profile: AgentProfile
    mode: AgentProfileContainerMode
  }

  export function agentProfileMarker (profile: AgentProfile): string {
    return profile === 'full' ? 'full:live' : profile
  }

  export function parseAgentProfileMarker (
    value: string
  ): ContainerAgentProfile | undefined {
    if (value === 'full:live') return { profile: 'full', mode: 'live' }
    if (value === 'full') return { profile: 'full', mode: 'legacy' }
    if (value === 'none' || value === 'auth') return { profile: value, mode: 'copy' }
    return undefined
  }

  export function agentProfileAccessText (profile: AgentProfile): string {
    return profile === 'full'
      ? 'live, read-write host mounts'
      : 'container-local copy'
  }
  ```

- [ ] **Step 4: Generate direct writable mounts for full**

  In `src/config.ts`, retain `AgentProfileSource.stagingTarget` for `auth`.
  In the `availableAgentProfileSources` loop, choose the destination and mount
  suffix from the selected profile:

  ```ts
  for (const source of availableAgentProfileSources) {
    if (!source.exists() || hasMountConflict(mounts, source.canonicalDestination)) continue

    const destination = agentProfile === 'full'
      ? source.canonicalDestination
      : source.stagingTarget
    const readOnly = agentProfile !== 'full' ? ',readonly' : ''
    boxdownMounts.push(
      `type=bind,source=${source.source},target=${destination}${readOnly}`
    )
  }
  ```

  Do not alter source discovery or conflict detection. The existing source list
  continues to drive `BOXDOWN_AGENT_PROFILE_SOURCES` for status reporting.

- [ ] **Step 5: Run focused tests and verify they pass**

  Run:

  ```sh
  pnpm test -- __tests__/app.test.ts
  ```

  Expected: direct full mounts are writable, auth mounts remain staged and
  read-only, and custom canonical mount ownership still wins.

- [ ] **Step 6: Commit the mount-generation model**

  ```sh
  git add src/agent-profile.ts src/config.ts __tests__/app.test.ts
  git commit -m "feat: mount full agent profiles live"
  ```

## Task 2: Stop copying full profiles and enforce legacy recreation

**Files:**
- Modify: `assets/devcontainer/utils/agent-profile-bootstrap.mjs`
- Modify: `src/devcontainer.ts:148-168,310-320`
- Modify: `src/status.ts:452-478,542-618,705-730`
- Modify: `__tests__/agent-profile-bootstrap.test.ts`
- Modify: `__tests__/app.test.ts`

**Interfaces:**
- Consumes `parseAgentProfileMarker()` from `src/agent-profile.ts`.
- `inspectContainerAgentProfile()` returns `ContainerAgentProfile | undefined`.
- `containerProfileState()` receives the full marker inspection, not just an
  `AgentProfile` string.
- `status.ts` recognizes a direct `full` mount whose source and target match
  Boxdown's selected host source and canonical destination as managed live
  access, not as a user custom mount.

- [ ] **Step 1: Write failing bootstrap and lifecycle tests**

  Replace the current full-copy assertion with a test that seeds canonical
  destinations, supplies full staged sources, and asserts no destination is
  changed:

  ```ts
  writeSourceFile(paths.source, 'codex/config.toml', 'host config\n')
  mkdirSync(join(paths.home, '.codex'), { recursive: true })
  writeFileSync(join(paths.home, '.codex', 'sentinel'), 'live mount\n')

  assertSucceeded(runBootstrap('full', paths))
  assert.strictEqual(readFileSync(join(paths.home, '.codex', 'sentinel'), 'utf8'), 'live mount\n')
  assert.strictEqual(lstatSync(join(paths.home, '.codex', 'config.toml'), { throwIfNoEntry: false }), undefined)
  assert.strictEqual(readFileSync(paths.marker, 'utf8'), 'full:live\n')
  ```

  Add lifecycle/status cases for a running marker of `full` that expect
  `recreate-required`, and a `full:live` marker that expects `active` when the
  generated config is also full.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run:

  ```sh
  pnpm test -- __tests__/agent-profile-bootstrap.test.ts __tests__/app.test.ts
  ```

  Expected: the bootstrap currently copies full sources and writes `full`; the
  runtime inspection currently discards `full:live` and accepts legacy `full`.

- [ ] **Step 3: Make the bootstrap marker-only for full**

  In `agent-profile-bootstrap.mjs`:

  1. Keep `auth` unchanged.
  2. Remove the `if (profile === 'full')` calls to `copyRequired`.
  3. Change marker writing to preserve the profile-specific marker:

  ```js
  async function writeMarker(profile) {
    const marker = profile === 'full' ? 'full:live' : profile
    // Keep the existing atomic temporary-file and rename sequence.
    await writeFile(temporary, `${marker}\n`, { mode: 0o600 })
  }
  ```

  Keep the safe copier helpers because `auth` still copies `~/.agents` and
  file-backed credentials.

- [ ] **Step 4: Parse the marker mode in lifecycle and status paths**

  Update `inspectContainerAgentProfile()` to return:

  ```ts
  return parseAgentProfileMarker(result.stdout.trim())
  ```

  Add a helper used by both start and status:

  ```ts
  function containerProfileMatches (
    inspected: ContainerAgentProfile | undefined,
    selected: AgentProfile
  ): boolean {
    const expectedMode = selected === 'full' ? 'live' : 'copy'
    return inspected?.profile === selected && inspected.mode === expectedMode
  }
  ```

  Use this helper in `assertContainerAgentProfile()` and in the status
  recreation calculation. Legacy `full` has `mode: 'legacy'`, so it fails the
  expected live-mode comparison and prints the existing recreate command.
  In `status.ts`, make `sourceIsCustom()` ignore a direct full mount only when
  its parsed source equals the corresponding context host source and its target
  equals the canonical destination. Keep every other overlapping mount custom;
  in particular, do not infer ownership from a matching destination alone.
  Add a status test that a generated full Codex mount reports `available` and
  does not add `/home/node/.codex` to `customDestinations`, while a different
  source targeting that path remains `custom`.
  Expose `agentProfileAccessText(selection.value)` in `StatusInfo.agentProfile`
  and print `Profile access: <text>` before `Container profile`.

- [ ] **Step 5: Run focused tests and verify GREEN**

  Run:

  ```sh
  pnpm test -- __tests__/agent-profile-bootstrap.test.ts __tests__/app.test.ts
  ```

  Expected: `auth` copy tests remain green, full bootstrap is marker-only,
  legacy full containers require recreation, and live full markers are active.

- [ ] **Step 6: Commit bootstrap and migration handling**

  ```sh
  git add assets/devcontainer/utils/agent-profile-bootstrap.mjs src/devcontainer.ts src/status.ts __tests__/agent-profile-bootstrap.test.ts __tests__/app.test.ts
  git commit -m "fix: make full profiles live host mounts"
  ```

## Task 3: Update selection, help, active documentation, and documentation tests

**Files:**
- Modify: `src/setup-agent-profile.ts`
- Modify: `src/main.ts:145-151`
- Modify: `README.md:120-180,205-210`
- Modify: `docs/features/setup.md`
- Modify: `docs/features/start-and-shell.md`
- Modify: `docs/features/lifecycle.md`
- Modify: `docs/features/generated-config-and-state.md`
- Modify: `assets/devcontainer/README.md`
- Modify: `assets/devcontainer/devcontainer.json`
- Modify: `__tests__/app.test.ts:875-1068`

**Interfaces:**
- Consumes `full` as the existing public CLI value.
- Consumes `Profile access: live, read-write host mounts` from Task 2's status
  formatter.

- [ ] **Step 1: Write failing copy/documentation assertions**

  Update prompt fixture and document assertions to the new contract:

  ```ts
  { value: 'full', label: 'Full agent profiles', description: 'Mount live read-write Codex, Claude, and ~/.agents host profiles.' }

  assert.match(USAGE, /full profile uses live, read-write host mounts/i)
  assert.match(readme, /\| `full` \| live, read-write host Codex\/Claude homes plus `~\/\.agents` \|/)
  assert.match(readme, /changes.*inside the container.*host profile.*immediately/is)
  assert.match(startDocs, /start --recreate.*agent-profile full/is)
  ```

  Remove assertions that active documentation says every profile is
  copy-on-create or that `full` uses read-only staging. Do not rewrite the
  dated historical design or plan documents; adjust the test to check only
  current user documentation.

- [ ] **Step 2: Run the focused documentation test and verify RED**

  Run:

  ```sh
  pnpm test -- __tests__/app.test.ts
  ```

  Expected: prompt, help, README, active feature docs, and devcontainer
  template still describe `full` as an isolated copied profile.

- [ ] **Step 3: Update all user-facing copy**

  Make these exact semantic changes:

  - `src/setup-agent-profile.ts`: change the full choice to `Mount live
    read-write Codex, Claude, and ~/.agents host profiles.` and change the
    prompt title from “copy into the container” to “use in the container”.
  - `src/main.ts`: say `auth` copies into container-local storage and `full`
    uses live, read-write host mounts whose changes persist immediately.
  - `README.md` and active feature docs: distinguish `auth` copy-on-create
    from `full` direct mounts; tell users to recreate after upgrading or
    changing full-profile mount configuration.
  - `assets/devcontainer/README.md` and template comments: state that only
    `auth` is staged read-only and copied. State that `full` is not staged and
    host writes are intentional.

  Retain the sensitivity warning and never recommend `full` for untrusted
  workspaces.

- [ ] **Step 4: Run targeted checks and verify GREEN**

  Run:

  ```sh
  pnpm test -- __tests__/app.test.ts
  pnpm lint
  ```

  Expected: all prompt, status, and documentation checks pass; Markdown and
  TypeScript linting report no errors.

- [ ] **Step 5: Commit public behavior documentation**

  ```sh
  git add src/setup-agent-profile.ts src/main.ts README.md docs/features assets/devcontainer __tests__/app.test.ts
  git commit -m "docs: describe live full agent profiles"
  ```

## Task 4: Verify the complete behavior and release-ready migration path

**Files:**
- Modify only if verification reveals an in-scope defect.

**Interfaces:**
- Consumes the `full:live` marker and direct full mounts from Tasks 1 and 2.
- Produces release evidence; no new public interface.

- [ ] **Step 1: Run the full automated suite**

  Run:

  ```sh
  pnpm test
  pnpm lint
  pnpm build
  ```

  Expected: all commands exit 0.

- [ ] **Step 2: Inspect the generated full configuration manually**

  Run the existing test-backed config generation or start a disposable
  workspace with:

  ```sh
  boxdown start --recreate --agent-profile full --verbose
  ```

  Verify the Docker/devcontainer trace has direct canonical agent mounts with
  no `readonly` suffix and no
  `/opt/boxdown/agent-profile-source/{agents,codex,claude,claude-config.json}`
  mounts. Verify `/opt/boxdown/state/agent-profile` contains `full:live`.

- [ ] **Step 3: Verify legacy behavior is guarded**

  With a fixture or test double whose marker is `full`, run the profile
  assertion/status path and verify it reports recreation required with:

  ```text
  boxdown start --recreate --agent-profile full
  ```

- [ ] **Step 4: Record the verification evidence**

  Report the exact commands and their exit status, plus the observed direct
  mount targets and `full:live` marker. If verification exposes a defect,
  return to the smallest task that owns that behavior, add a new failing test,
  and repeat that task's RED-GREEN cycle before making any additional commit.
