# Workspace Toolchains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Node.js, Python, Go, and Rust workspace toolchains; require explicit user selection; and provision the selected, version-pinned runtimes inside the Boxdown Dev Container.

**Architecture:** A pure TypeScript toolchain domain parses root-level project markers and resolves a persisted workspace plan. CLI orchestration owns selection and persistence, generated config mounts the plan and status state, and an idempotent container bootstrap uses a release-pinned `mise` binary with repository configuration disabled. Status reads only Boxdown-owned plan and result files.

**Tech Stack:** Node.js 24, TypeScript, node:test, Dev Containers, Bash, Docker, mise v2026.7.13, uv, JSON/JSONC parsing.

## Global Constraints

- Support only Node.js, Python, Go, and Rust in this release.
- Read only known files at the workspace root; do not recursively inspect monorepos.
- Do not write Boxdown files into the target repository.
- Do not execute repository-defined mise configuration, tasks, hooks, shell fragments, or arbitrary project scripts outside the existing package-manager install lifecycle.
- Interactive `boxdown setup` shows an editable preselected toolchain list and requires explicit confirmation.
- A non-interactive command with no `--toolchain` reports detection but selects no toolchains.
- `--toolchain <runtime>@<version>` overrides a repository declaration and emits a note instead of failing.
- Use release-pinned defaults: Node.js 24.17.0, Python 3.14.6, Go 1.26.5, and Rust 1.97.1.
- Use uv 0.11.32 as an internal, release-pinned Python synchronization tool.
- Keep generated configuration, plans, tool state, and runtime installations outside the target repository.
- Preserve the existing non-fatal dependency-install behavior: warn and retry on a future start.
- Preserve legacy workspaces; adding the first toolchain plan requires `--recreate` because it introduces create-time mounts.
- Keep the CLI dependency-light; use Node.js built-ins and existing project helpers.
- Add a changeset because this publishes new CLI behavior and a larger release image.

---

## File structure

- `src/toolchains/types.ts` — shared runtime identifiers, evidence, plan, status, selector, and resolution types.
- `src/toolchains/defaults.ts` — exact release-pinned default versions and display metadata.
- `src/toolchains/detect.ts` — root-level marker readers, strict parsers, precedence, and compatibility resolution.
- `src/toolchains/plan.ts` — selector validation, plan construction, plan fingerprinting, and JSON persistence.
- `src/setup-toolchains.ts` — editable setup prompt and non-interactive resolution policy.
- `src/constants.ts` — host-independent container paths for mounted toolchain plan and result state.
- `src/paths.ts` — per-workspace toolchain plan and result directories.
- `src/config.ts` — optional plan/result mounts and non-secret provenance in the generated Dev Container config.
- `src/devcontainer.ts` — passes the stored plan into generated config and reads running-container lifecycle state when required.
- `src/main.ts` — parses `--toolchain`, resolves/persists selection before setup or start, and exposes the option in help text.
- `src/status.ts` — reports plan, last sync result, override note, and recreation requirement.
- `src/metadata.ts` — preserves optional lightweight toolchain-plan provenance without invalidating v1 metadata.
- `assets/image/tools.lock.json` and `assets/image/install-native-tools.sh` — install verified mise artifacts for AMD64 and ARM64.
- `assets/image/Dockerfile` and `assets/image/smoke-test.sh` — package and verify mise in the release image.
- `assets/devcontainer/utils/toolchains-bootstrap.sh` — provisions exact runtimes and writes a bounded result record.
- `assets/devcontainer/utils/deps-install.sh` — exposes the existing Node installer as the Node adapter’s sync function.
- `assets/devcontainer/hooks/post-create.sh` and `assets/devcontainer/hooks/post-start.sh` — invoke the idempotent bootstrap at create and start.
- `__tests__/toolchains.test.ts` — pure detection, plan, and persistence tests.
- `__tests__/app.test.ts` — CLI, generated-config, status, and legacy-workspace integration tests.
- `docs/features/toolchains.md`, `docs/features/README.md`, `docs/features/generated-config-and-state.md`, `docs/architecture.md`, `README.md` — user and architecture documentation.
- `.changeset/bright-toolchains-learn.md` — minor release record for the new CLI behavior and image capability.

## Interfaces

```ts
// src/toolchains/types.ts
export const TOOLCHAIN_IDS = ['node', 'python', 'go', 'rust'] as const
export type ToolchainId = typeof TOOLCHAIN_IDS[number]
export type ToolchainSelectionSource = 'interactive' | 'cli' | 'persisted'
export type ToolchainResolutionSource = 'override' | 'project' | 'boxdown-default'
export type ToolchainSyncState = 'pending' | 'succeeded' | 'failed' | 'not-created'

export interface ToolchainEvidence {
  path: string
  source: string
  value: string
  exact: boolean
}

export interface ResolvedToolchain {
  id: ToolchainId
  version: string
  selectionSource: ToolchainSelectionSource
  resolutionSource: ToolchainResolutionSource
  evidence: ToolchainEvidence[]
  compatibilityNote?: string
}

export interface ToolchainPlan {
  version: 1
  workspaceId: string
  fingerprint: string
  selected: ResolvedToolchain[]
  updatedAt: string
}

export interface ToolchainResult {
  version: 1
  fingerprint: string
  state: ToolchainSyncState
  updatedAt: string
  runtimes: Array<{ id: ToolchainId, state: ToolchainSyncState, message?: string }>
}
```

```ts
// src/toolchains/plan.ts
export function parseToolchainSelector(value: string):
  | { kind: 'auto' }
  | { kind: 'none' }
  | { kind: 'runtime', id: ToolchainId, version?: string }

export function resolveToolchainPlan(options: {
  workspaceId: string
  detections: DetectedToolchain[]
  selectors: readonly ToolchainSelector[]
  selectionSource: ToolchainSelectionSource
  now?: Date
}): ToolchainPlan

export function readToolchainPlan(context: WorkspaceContext): ToolchainPlan | undefined
export function writeToolchainPlan(context: WorkspaceContext, plan: ToolchainPlan): void
export function readToolchainResult(context: WorkspaceContext): ToolchainResult | undefined
```

## Task 1: Add pure runtime defaults, detection, and resolution

**Files:**

- Create: `src/toolchains/types.ts`
- Create: `src/toolchains/defaults.ts`
- Create: `src/toolchains/detect.ts`
- Create: `__tests__/toolchains.test.ts`

**Interfaces:**

- Produces: `detectToolchains(workspaceFolder)`, `DetectedToolchain`, `resolveDetectedVersion`, `TOOLCHAIN_DEFAULTS`, and every type in the Interfaces section.
- Consumes: only `node:fs`, `node:path`, and `src/jsonc.ts`; no CLI or Docker state.

- [ ] **Step 1: Write the failing defaults and Node precedence tests**

```ts
// __tests__/toolchains.test.ts
test('detects a Volta Node pin ahead of engines and lockfile evidence', () => {
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({
    volta: { node: '24.17.0' },
    engines: { node: '>=22' }
  }))
  writeFileSync(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')

  assert.deepStrictEqual(detectToolchains(workspace), [{
    id: 'node',
    exactVersion: '24.17.0',
    constraint: '>=22',
    evidence: [
      { path: 'package.json', source: 'volta.node', value: '24.17.0', exact: true },
      { path: 'package.json', source: 'engines.node', value: '>=22', exact: false },
      { path: 'pnpm-lock.yaml', source: 'lockfile', value: 'pnpm', exact: false }
    ]
  }])
})

test('keeps defaults release-pinned', () => {
  assert.deepStrictEqual(TOOLCHAIN_DEFAULTS, {
    node: { version: '24.17.0', label: 'Node.js' },
    python: { version: '3.14.6', label: 'Python' },
    go: { version: '1.26.5', label: 'Go' },
    rust: { version: '1.97.1', label: 'Rust' }
  })
})
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec tsx --test __tests__/toolchains.test.ts`

Expected: FAIL because `src/toolchains/detect.ts` and `src/toolchains/defaults.ts` do not exist.

- [ ] **Step 3: Define runtime types and exact default registry**

```ts
// src/toolchains/defaults.ts
import type { ToolchainId } from './types.ts'

export const TOOLCHAIN_DEFAULTS: Record<ToolchainId, { version: string, label: string }> = {
  node: { version: '24.17.0', label: 'Node.js' },
  python: { version: '3.14.6', label: 'Python' },
  go: { version: '1.26.5', label: 'Go' },
  rust: { version: '1.97.1', label: 'Rust' }
}
```

Define `DetectedToolchain` with `id`, optional `exactVersion`, optional
`constraint`, and ordered `evidence`. Reject a duplicate or empty evidence
value at the parser boundary.

- [ ] **Step 4: Implement one strict parser per supported project format**

```ts
export function detectToolchains (workspaceFolder: string): DetectedToolchain[] {
  return [
    detectNode(workspaceFolder),
    detectPython(workspaceFolder),
    detectGo(workspaceFolder),
    detectRust(workspaceFolder)
  ].filter((detection): detection is DetectedToolchain => detection !== undefined)
}
```

Implement `detectNode`, `detectPython`, `detectGo`, and `detectRust` with
root-only reads. Parse JSON with `parseJsonc`, TOML-like files with narrow line
parsers that accept only their documented keys, and version files after
trimming a single non-empty line. Do not treat a package lockfile as a runtime
version declaration. Preserve it only as Node package-manager evidence.

Use the precedence declared in the approved design: exact project marker first,
then compatible constraint. Return a diagnostic for malformed marker syntax
instead of throwing from detection.

For constraints, support only the explicit comparator forms required by the
known marker formats: exact `X.Y[.Z]`, comparison clauses (`>=`, `>`, `<=`,
`<`), Node-compatible caret and tilde ranges, and comma- or whitespace-joined
AND clauses. Normalize a Go `go` directive and Cargo `rust-version` as a
minimum-version clause. Reject wildcard ranges, OR clauses, arbitrary PEP 440
operators, prerelease ranges, and any unsupported syntax with a diagnostic;
those inputs remain visible but unchecked rather than being interpreted
approximately.

- [ ] **Step 5: Extend the focused tests to cover every adapter and constraints**

```ts
test('uses a compatible default only when the constraint accepts it', () => {
  const compatible = resolveDetectedVersion({
    id: 'python',
    constraint: '>=3.11',
    evidence: [{ path: 'pyproject.toml', source: 'requires-python', value: '>=3.11', exact: false }]
  })
  assert.strictEqual(compatible.kind, 'resolved')
  assert.strictEqual(compatible.version, '3.14.6')

  const incompatible = resolveDetectedVersion({
    id: 'python',
    constraint: '<3.12',
    evidence: [{ path: 'pyproject.toml', source: 'requires-python', value: '<3.12', exact: false }]
  })
  assert.deepStrictEqual(incompatible, {
    kind: 'incompatible-default',
    defaultVersion: '3.14.6',
    constraint: '<3.12'
  })
})

test('detects Go toolchain and Rust channel files as exact declarations', () => {
  writeFileSync(join(workspace, 'go.mod'), 'module example.com/app\n\ntoolchain go1.26.5\n')
  writeFileSync(join(workspace, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.97.1"\n')
  const detections = detectToolchains(workspace)
  assert.strictEqual(detections.find(item => item.id === 'go')?.exactVersion, '1.26.5')
  assert.strictEqual(detections.find(item => item.id === 'rust')?.exactVersion, '1.97.1')
})
```

Add cases for `.nvmrc`, `.node-version`, `.python-version`, `.go-version`,
`.tool-versions`, `package.rust-version`, unsupported `.tool-versions` names,
multiple runtimes, empty files, malformed JSON, malformed TOML key values, and
constraints excluding a default.

- [ ] **Step 6: Run unit tests and lint**

Run: `pnpm exec tsx --test __tests__/toolchains.test.ts && pnpm exec eslint src/toolchains __tests__/toolchains.test.ts`

Expected: PASS with no ESLint errors.

- [ ] **Step 7: Commit the pure domain**

```bash
git add src/toolchains __tests__/toolchains.test.ts
git commit -m "feat: detect workspace toolchains"
```

## Task 2: Add deterministic plans, Boxdown-owned persistence, and setup selection

**Files:**

- Create: `src/toolchains/plan.ts`
- Create: `src/setup-toolchains.ts`
- Modify: `src/paths.ts`
- Modify: `src/metadata.ts`
- Modify: `__tests__/toolchains.test.ts`
- Modify: `__tests__/app.test.ts`

**Interfaces:**

- Consumes: `DetectedToolchain`, defaults, prompt primitives from `src/interactive-prompts.ts`, and `WorkspaceContext`.
- Produces: selector parsing, plan persistence under `context.toolchainPlanPath`, and `resolveSetupToolchains()`.

- [ ] **Step 1: Write failing selector, persistence, and prompt tests**

```ts
test('an explicit version overrides a conflicting project declaration with a note', () => {
  const plan = resolveToolchainPlan({
    workspaceId: 'workspace-id',
    detections: [{ id: 'go', exactVersion: '1.26.5', evidence: [{ path: 'go.mod', source: 'toolchain', value: '1.26.5', exact: true }] }],
    selectors: [parseToolchainSelector('go@1.27.0')],
    selectionSource: 'cli',
    now: new Date('2026-08-02T00:00:00.000Z')
  })
  assert.deepStrictEqual(plan.selected[0], {
    id: 'go',
    version: '1.27.0',
    selectionSource: 'cli',
    resolutionSource: 'override',
    evidence: [{ path: 'go.mod', source: 'toolchain', value: '1.26.5', exact: true }],
    compatibilityNote: 'Explicit Go 1.27.0 override differs from go.mod toolchain 1.26.5.'
  })
})

test('none cannot be combined with another selector', () => {
  assert.throws(() => resolveToolchainPlan({
    workspaceId: 'workspace-id',
    detections: [],
    selectors: [parseToolchainSelector('none'), parseToolchainSelector('node')],
    selectionSource: 'cli'
  }), /--toolchain none cannot be combined/)
})
```

In `__tests__/app.test.ts`, use TTY prompt streams to assert that setup shows
the multi-select with detected options checked, and use a non-TTY stream to
assert that no implicit plan is written.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm exec tsx --test __tests__/toolchains.test.ts __tests__/app.test.ts`

Expected: FAIL because plan and setup-selection modules do not exist and
`WorkspaceContext` has no toolchain paths.

- [ ] **Step 3: Add path and persistence helpers with validated JSON shapes**

```ts
// src/paths.ts additions to WorkspaceContext
toolchainsDir: string
toolchainPlanPath: string
toolchainResultDir: string
toolchainResultPath: string
```

Construct these beneath `workspaceDataDir` as `toolchains/plan.json` and
`toolchains/result.json`. `readToolchainPlan` and `readToolchainResult` must
return `undefined` for a missing file, but throw an actionable error for a
present file whose `version`, `workspaceId`, selector shape, or runtime name is
invalid. `writeToolchainPlan` creates the plan parent and the separate result
directory before config generation so both bind-mount sources always exist.
Write files with a trailing newline.

Add optional `toolchainPlanUpdatedAt?: string` to `WorkspaceMetadata` and its
validator. Keep `WORKSPACE_METADATA_VERSION` at `1`; old metadata remains
valid because the field is optional.

- [ ] **Step 4: Implement selector and plan resolution**

```ts
export function parseToolchainSelector (value: string): ToolchainSelector {
  if (value === 'auto') return { kind: 'auto' }
  if (value === 'none') return { kind: 'none' }
  const match = /^(node|python|go|rust)(?:@([0-9][0-9A-Za-z.+-]*))?$/u.exec(value)
  if (match === null) throw new Error(`Unsupported toolchain selector: ${value}`)
  return { kind: 'runtime', id: match[1] as ToolchainId, ...(match[2] === undefined ? {} : { version: match[2] }) }
}
```

Hash a stable serialization of `workspaceId` plus selected runtime IDs,
versions, resolution sources, and evidence into `fingerprint`. Deduplicate
selectors by runtime, reject two different explicit versions for the same
runtime, and make `auto` select only detections with either an exact version or
a compatible default. An explicit selector always wins and attaches a
compatibility note rather than throwing.

- [ ] **Step 5: Implement interactive and non-interactive setup policy**

```ts
export async function resolveSetupToolchains (options: {
  context: WorkspaceContext
  selectors: readonly ToolchainSelector[]
  existingPlan?: ToolchainPlan
  input?: PromptInput
  output?: PromptOutput
  env?: NodeJS.ProcessEnv
}): Promise<{ plan?: ToolchainPlan, detected: DetectedToolchain[] }>
```

When selectors are present, resolve without prompting. When selectors are
absent and the terminal is interactive, call `promptMultiSelect` with the
detected runtimes preselected, a `No toolchains` skip option, and source-aware
descriptions. When selectors are absent and the terminal is non-interactive,
return `{ detected }` without a plan and print the detected summary from
`main.ts`. Reuse a persisted plan only for direct `start`; never use it to
silently bypass an interactive `setup` selection.

An explicit `none` selector and an interactive `No toolchains` choice persist
an empty plan (`selected: []`) instead of deleting the plan. This preserves the
user’s explicit decision, keeps an existing plan mount safe to reuse, and lets
status distinguish `disabled` from `not selected`. Only the non-interactive,
no-selector path leaves a workspace with no plan.

- [ ] **Step 6: Run focused tests and commit plan behavior**

Run: `pnpm exec tsx --test __tests__/toolchains.test.ts __tests__/app.test.ts && pnpm exec eslint src/toolchains src/setup-toolchains.ts src/paths.ts src/metadata.ts`

Expected: PASS with deterministic fingerprints and no writes in non-interactive
no-selector cases.

```bash
git add src/toolchains/plan.ts src/setup-toolchains.ts src/paths.ts src/metadata.ts __tests__/toolchains.test.ts __tests__/app.test.ts
git commit -m "feat: select workspace toolchains"
```

## Task 3: Wire selectors into CLI orchestration and generated configuration

**Files:**

- Modify: `src/main.ts`
- Modify: `src/constants.ts`
- Modify: `src/config.ts`
- Modify: `src/devcontainer.ts`
- Modify: `__tests__/app.test.ts`

**Interfaces:**

- Consumes: `parseToolchainSelector`, `resolveSetupToolchains`, persisted plans, and `writeToolchainPlan` from Task 2.
- Produces: `ParsedCli.toolchains`, mounted plan/result state, and toolchain-aware start/setup calls.

- [ ] **Step 1: Write failing CLI and generated-config tests**

```ts
test('parses repeatable toolchain selectors only for setup and start', () => {
  assert.deepStrictEqual(parseCliArgs(['setup', '--toolchain', 'node', '--toolchain', 'go@1.27.0']).toolchains, ['node', 'go@1.27.0'])
  assert.throws(() => parseCliArgs(['status', '--toolchain', 'node']), /--toolchain is only supported with setup and start/)
})

test('mounts persisted plan read-only and result state read-write', () => {
  writeToolchainPlan(context, nodePlan)
  const config = buildGeneratedDevcontainerConfig(context)
  assert.ok(config.mounts?.includes(`type=bind,source=${context.toolchainsDir},target=/opt/boxdown/state/toolchains,readonly`))
  assert.ok(config.mounts?.includes(`type=bind,source=${context.toolchainResultDir},target=/opt/boxdown/state/toolchain-results`))
})
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec tsx --test __tests__/app.test.ts`

Expected: FAIL because `ParsedCli` has no `toolchains` field and generated
config has no toolchain mounts.

- [ ] **Step 3: Parse and validate `--toolchain` before command dispatch**

Add `toolchains?: string[]` to `ParsedCli`, collect repeatable values in
`parseCliArgs`, and reject the option for every command except `setup` and
`start`. Add the option and selector meanings to `USAGE`. Parse values with
`parseToolchainSelector` immediately after syntax parsing, so invalid selectors
fail before Docker or workspace writes.

In `runCli`, resolve a setup plan after setup preflight and before writing
metadata or calling `setupWorkspace`; persist it before `startDevcontainer`
generates config. In direct `start`, reuse a valid stored plan, resolve and
persist explicit selectors, and leave an unconfigured workspace untouched when
no selectors are supplied.

- [ ] **Step 4: Add stable container paths and optional mounts**

```ts
// src/constants.ts
export const BOXDOWN_CONTAINER_TOOLCHAINS_DIR = `${BOXDOWN_CONTAINER_STATE_DIR}/toolchains`
export const BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH = `${BOXDOWN_CONTAINER_TOOLCHAINS_DIR}/plan/plan.json`
export const BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR = `${BOXDOWN_CONTAINER_STATE_DIR}/toolchain-results`
```

In `buildGeneratedDevcontainerConfig`, read the stored plan through a helper
before config creation. If the plan exists, append the plan mount read-only and
the separate result directory mount read-write. Do not add either mount for a
legacy workspace with no plan. Pass the plan through the existing pure config
builder as an optional final parameter so `startDevcontainer` and tests can
avoid hidden filesystem reads.

- [ ] **Step 5: Enforce legacy recreation and verify flow**

Extend `startDevcontainer`’s existing generated-intent comparison to detect a
stored plan on a container created without the plan mount. Throw an actionable
error containing `boxdown start --recreate`. Do not require recreation for a
plan edit once the plan/result mounts already exist.

Add tests for: first setup writes a plan before generated config, direct start
reuses a plan, no-selector non-interactive mode writes no plan, `none` omits
mounts, and a legacy running container requires recreation.

- [ ] **Step 6: Run integration tests and commit**

Run: `pnpm exec tsx --test __tests__/app.test.ts && pnpm exec eslint src/main.ts src/constants.ts src/config.ts src/devcontainer.ts`

Expected: PASS; all commands except `setup` and `start` reject `--toolchain`.

```bash
git add src/main.ts src/constants.ts src/config.ts src/devcontainer.ts __tests__/app.test.ts
git commit -m "feat: mount workspace toolchain plans"
```

## Task 4: Publish toolchain state through `boxdown status`

**Files:**

- Modify: `src/status.ts`
- Modify: `src/main.ts`
- Modify: `__tests__/app.test.ts`

**Interfaces:**

- Consumes: `readToolchainPlan`, `readToolchainResult`, `ToolchainPlan`, `ToolchainResult`, and the generated-config mount paths from Task 3.
- Produces: `StatusInfo.toolchains` with selected runtimes, last result, and recreation state.

- [ ] **Step 1: Write the failing status tests**

```ts
test('formats selected toolchains and a CLI override note', () => {
  writeToolchainPlan(context, goOverridePlan)
  writeFileSync(context.toolchainResultPath, JSON.stringify({
    version: 1,
    fingerprint: goOverridePlan.fingerprint,
    state: 'succeeded',
    updatedAt: '2026-08-02T00:00:00.000Z',
    runtimes: [{ id: 'go', state: 'succeeded' }]
  }))
  const status = createStatusInfo(context, 'demo-devcontainer', undefined, existsSync)
  assert.match(formatStatusText(status), /Toolchains: Go 1.27.0 \(CLI override\)/)
  assert.match(formatStatusText(status), /Explicit Go 1.27.0 override differs from go.mod toolchain 1.26.5/)
  assert.match(formatStatusText(status), /Last sync: succeeded/)
})
```

- [ ] **Step 2: Run the focused status test to verify it fails**

Run: `pnpm exec tsx --test __tests__/app.test.ts`

Expected: FAIL because `StatusInfo` has no `toolchains` field.

- [ ] **Step 3: Add plan-aware status data and formatting**

```ts
export interface ToolchainStatus {
  plan?: ToolchainPlan
  result?: ToolchainResult
  containerState: 'active' | 'disabled' | 'recreate-required' | 'not-selected'
}
```

Read the plan/result only through their Boxdown paths. `active` means a plan
exists, has selected runtimes, and its result fingerprint matches; `disabled`
means an explicit empty plan; `recreate-required` means a plan exists but the
current container/generated config lacks a required mount or an existing
container has no matching result; `not-selected` means no plan exists. Include
the toolchain object in JSON status, format each selected runtime with its
source, print compatibility notes indented below it, and print the exact
recreate command only for `recreate-required`.

- [ ] **Step 4: Run status tests and commit**

Run: `pnpm exec tsx --test __tests__/app.test.ts && pnpm exec eslint src/status.ts src/main.ts`

Expected: PASS for human and JSON status, legacy workspaces, stale result
fingerprints, failed result records, and override notes.

```bash
git add src/status.ts src/main.ts __tests__/app.test.ts
git commit -m "feat: report workspace toolchains"
```

## Task 5: Package a verified mise binary in the release image

**Files:**

- Modify: `assets/image/tools.lock.json`
- Modify: `assets/image/install-native-tools.sh`
- Modify: `assets/image/Dockerfile`
- Modify: `assets/image/smoke-test.sh`
- Modify: `__tests__/image-input-policy.test.ts`
- Modify: `assets/image/image-size-budget.json`

**Interfaces:**

- Consumes: the existing architecture-specific artifact lock and Docker build arguments.
- Produces: `/usr/local/bin/mise` for both `linux/amd64` and `linux/arm64`.

- [ ] **Step 1: Write the failing image-policy and smoke assertions**

```ts
test('locks verified mise artifacts for both release image architectures', () => {
  const lock = JSON.parse(readFileSync(nativeToolLockPath, 'utf8')) as Record<string, unknown>
  assert.match(String((lock.mise as { artifacts: { amd64: { url: string } } }).artifacts.amd64.url), /mise-v2026\.7\.13-linux-x64$/)
  assert.match(String((lock.mise as { artifacts: { arm64: { url: string } } }).artifacts.arm64.url), /mise-v2026\.7\.13-linux-arm64$/)
})
```

Add a smoke-test assertion `mise --version` and an image-policy assertion that
the Dockerfile executes the checked installer before dropping to `USER node`.

- [ ] **Step 2: Run the image-policy test to verify it fails**

Run: `pnpm exec tsx --test __tests__/image-input-policy.test.ts`

Expected: FAIL because the native tool lock has no `mise` entry and the smoke
script does not invoke `mise`.

- [ ] **Step 3: Extend the artifact lock and installer without weakening validation**

Add `mise.artifacts.amd64` and `mise.artifacts.arm64` entries for immutable
v2026.7.13 GitHub release binaries. Copy each SHA-256 from that release’s asset
manifest and verify it locally before committing. Extend the existing Node lock
parser with `const mise = artifact('mise', architecture)` and emit its URL and
checksum with the existing tab-delimited values.

```bash
download_and_verify "${mise_url}" "${mise_sha256}" "${temporary_directory}/mise"
install -m 0755 "${temporary_directory}/mise" /usr/local/bin/mise
/usr/local/bin/mise --version
```

Do not use `curl | sh`, a floating release URL, or an unverified archive. Keep
the existing onepassword/APM validation intact for both architectures.

- [ ] **Step 4: Build and smoke-test the image locally**

Run: `docker buildx build --platform linux/amd64 --load -f assets/image/Dockerfile -t boxdown-toolchains:test . && docker run --rm --user node boxdown-toolchains:test /opt/boxdown/image-tools/smoke-test.sh`

Expected: image build succeeds and smoke output includes the mise version.

- [ ] **Step 5: Update the explicit image budget and commit**

Measure the built AMD64 image with the repository’s existing image-size budget
format, raise only the relevant budget limit by the observed packaged mise size
plus a 10% allowance, and keep a justification comment/documented value in the
commit message.

```bash
git add assets/image/tools.lock.json assets/image/install-native-tools.sh assets/image/Dockerfile assets/image/smoke-test.sh assets/image/image-size-budget.json __tests__/image-input-policy.test.ts
git commit -m "feat: package mise in devcontainer image"
```

## Task 6: Implement idempotent container provisioning and dependency sync

**Files:**

- Create: `assets/devcontainer/utils/toolchains-bootstrap.sh`
- Modify: `assets/devcontainer/utils/deps-install.sh`
- Modify: `assets/devcontainer/hooks/post-create.sh`
- Modify: `assets/devcontainer/hooks/post-start.sh`
- Modify: `assets/image/lifecycle-smoke-test.sh`
- Modify: `__tests__/app.test.ts`

**Interfaces:**

- Consumes: `BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH`, `BOXDOWN_CONTAINER_TOOLCHAIN_RESULTS_DIR`, mise, and the JSON plan schema from Task 2.
- Produces: `<results-dir>/result.json` whose `fingerprint` and runtime states match the mounted plan.

- [ ] **Step 1: Write failing lifecycle command/result tests**

```ts
test('toolchain bootstrap disables mise config and writes a failed retryable result', () => {
  const bootstrap = readFileSync(join(assetsDevcontainerDir, 'utils', 'toolchains-bootstrap.sh'), 'utf8')
  assert.match(bootstrap, /MISE_NO_CONFIG=1/)
  assert.match(bootstrap, /mise --no-config install/)
  assert.match(bootstrap, /toolchain-results\/result\.json/)
  assert.match(bootstrap, /state.*failed/)
})
```

Add a fake-plan fixture to the image lifecycle smoke test. It must contain
Node.js 24.17.0, Python 3.14.6, Go 1.26.5, and Rust 1.97.1 and assert each
runtime command is available after the bootstrap.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec tsx --test __tests__/app.test.ts`

Expected: FAIL because the bootstrap script and hook invocations do not exist.

- [ ] **Step 3: Implement a bounded JSON plan reader and exact runtime installation**

```bash
plan_records="$({
  node - "${BOXDOWN_CONTAINER_TOOLCHAIN_PLAN_PATH}" <<'NODE'
const { readFileSync } = require('node:fs')
const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'))
if (plan.version !== 1 || !Array.isArray(plan.selected) || typeof plan.fingerprint !== 'string') process.exit(2)
for (const item of plan.selected) {
  if (!['node', 'python', 'go', 'rust'].includes(item.id) || !/^[0-9][0-9A-Za-z.+-]*$/.test(item.version)) process.exit(2)
  process.stdout.write(`${item.id}\t${item.version}\n`)
}
NODE
} )"
```

For each validated record, invoke `MISE_NO_CONFIG=1 mise --no-config install
"${id}@${version}"`. Set mise data, cache, config, and state directories below
the container user’s local Boxdown directory. Never run `mise use`, `mise run`,
`mise trust`, or a command that loads project config.

Create executable wrappers in `${HOME}/.local/bin` for the selected runtime
commands (`node`, `npm`, `npx`, `corepack`, `python`, `python3`, `pip`, `go`,
`cargo`, `rustc`, and `rustup`). Each wrapper must call the single exact
version through `MISE_NO_CONFIG=1 mise --no-config exec <runtime>@<version> --
<command> "$@"`. The current interactive and agent command launchers already
put `${HOME}/.local/bin` first on `PATH`; add the same path export to the
container SSH login shell setup. This gives interactive shells, SSH commands,
and agent commands the selected runtime without loading repository mise files.
Use the installed Node 24 only after validating that `node --version` equals
the requested Node version; otherwise install it through mise.

Write `result.json` atomically: create a temporary file in the mounted results
directory, write schema version, fingerprint, timestamp, aggregate state, and
per-runtime state, then rename it. A runtime failure must keep processing the
other selected runtimes, set aggregate `failed`, write an escaped one-line
message, print a warning to stderr, and return zero from the bootstrap.

- [ ] **Step 4: Implement safe adapter synchronizations**

```bash
case "${id}" in
  node) bash "${DEVCONTAINER_DIR}/utils/deps-install.sh" ;;
  python) run_python_sync ;;
  go) (cd "${BOXDOWN_CONTAINER_WORKSPACE_FOLDER}" && go mod download) ;;
  rust) (cd "${BOXDOWN_CONTAINER_WORKSPACE_FOLDER}" && cargo fetch) ;;
esac
```

Keep `deps-install.sh`’s current package-manager precedence and non-fatal
behavior, but expose `main` only when the script is executed directly so the
Node adapter can call it once. `run_python_sync` must install and invoke the
release-pinned `uv@0.11.32` through `MISE_NO_CONFIG=1 mise --no-config exec`:
run `uv sync` only when both `pyproject.toml` and `uv.lock` exist; otherwise select the first root-level `requirements.txt`,
`requirements-dev.txt`, or `requirements/*.txt` and run `uv pip install -r`.
Boxdown does not dispatch package scripts itself; the Node package-manager
installation preserves its current lifecycle-script behavior. Do not run Cargo
builds, `go get`, task runners, or arbitrary commands.

- [ ] **Step 5: Call the bootstrap from create and start hooks**

Add `run_step "Preparing workspace toolchains" configure_toolchains` to
`post-create.sh` before the existing dependency-install step. In
`post-start.sh`, call the bootstrap only when its result is missing, its
fingerprint differs from the mounted plan, or its aggregate state is `failed`.
Both hook call sites warn on bootstrap failure rather than failing the
container lifecycle.

- [ ] **Step 6: Run lifecycle verification and commit**

Run: `pnpm exec tsx --test __tests__/app.test.ts && docker buildx build --platform linux/amd64 --load -f assets/image/Dockerfile -t boxdown-toolchains:test . && docker run --rm --user root --mount type=bind,source="$PWD/assets/devcontainer",target=/opt/boxdown/devcontainer,readonly boxdown-toolchains:test /opt/boxdown/image-tools/lifecycle-smoke-test.sh --remap-node`

Expected: tests pass; the smoke test completes as remapped `node` and writes a
successful result for all four selected runtimes.

```bash
git add assets/devcontainer/utils/toolchains-bootstrap.sh assets/devcontainer/utils/deps-install.sh assets/devcontainer/hooks/post-create.sh assets/devcontainer/hooks/post-start.sh assets/image/lifecycle-smoke-test.sh __tests__/app.test.ts
git commit -m "feat: provision selected workspace toolchains"
```

## Task 7: Document the feature, add release metadata, and run the full suite

**Files:**

- Create: `docs/features/toolchains.md`
- Modify: `docs/features/README.md`
- Modify: `docs/features/generated-config-and-state.md`
- Modify: `docs/architecture.md`
- Modify: `README.md`
- Create: `.changeset/bright-toolchains-learn.md`
- Modify: `__tests__/toolchains.test.ts`

**Interfaces:**

- Consumes: `TOOLCHAIN_DEFAULTS`, CLI selector grammar, plan paths, and status text from Tasks 1–6.
- Produces: copy-pasteable user documentation and a changeset.

- [ ] **Step 1: Write a failing documentation-default synchronization test**

```ts
test('documents every exact Boxdown toolchain default', () => {
  const docs = readFileSync(join(process.cwd(), 'docs/features/toolchains.md'), 'utf8')
  for (const [id, entry] of Object.entries(TOOLCHAIN_DEFAULTS)) {
    assert.match(docs, new RegExp(`\\| ${id} \\| ${entry.version} \\|`, 'u'))
  }
})
```

- [ ] **Step 2: Run the documentation test to verify it fails**

Run: `pnpm exec tsx --test __tests__/toolchains.test.ts`

Expected: FAIL because the Toolchains feature page does not exist.

- [ ] **Step 3: Write user-facing documentation and architecture updates**

The feature page must include the exact defaults table, marker precedence,
interactive editable-selection behavior, every selector form, direct-start
behavior, non-interactive no-selection behavior, override notes, status
interpretation, no-repository-write guarantee, failure/retry behavior, and the
legacy `--recreate` migration. Link it from both feature indexes and add a
short setup/start example to the README.

Update generated-state documentation with `toolchains/plan.json` and
`toolchains/result.json`, including the plan read-only/result writable mount
split. Update architecture documentation with the pure resolver, external
state boundary, and mise isolation policy.

Create a changeset with a `minor` bump for `boxdown` and a concise summary:
`Detect, confirm, and provision Node.js, Python, Go, and Rust workspace toolchains.`

- [ ] **Step 4: Run full verification**

Run: `pnpm run lint && pnpm run build && pnpm run test && npm pack --dry-run --json`

Expected: all commands exit 0; the package includes the new Dev Container
scripts and documentation but contains no generated workspace plan or result.

- [ ] **Step 5: Review exact changed files and commit**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only the documentation, changeset, and test
files from this task are unstaged.

```bash
git add README.md docs/features/toolchains.md docs/features/README.md docs/features/generated-config-and-state.md docs/architecture.md __tests__/toolchains.test.ts .changeset
git commit -m "docs: explain workspace toolchains"
```
