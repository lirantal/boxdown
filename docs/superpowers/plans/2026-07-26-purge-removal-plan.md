# Purge Removal Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `boxdown purge` explain the concrete resources it will remove and retain before deletion, without adding a `--dry-run` flag.

**Architecture:** Add a read-only `PurgePlan` builder in `src/purge.ts` that resolves a workspace's Docker snapshot, managed aliases, and Boxdown-owned paths. `src/main.ts` builds plans before the existing confirmation boundary, renders them as styled prompt details in a TTY, and writes equivalent plain text before explicitly targeted non-interactive/CI purges. `purgeWorkspace` remains the authoritative deletion path and rechecks Docker state during execution.

**Tech Stack:** TypeScript, Node built-in test runner, existing Boxdown prompt helpers, Docker test shim, Markdown documentation.

## Global Constraints

- Do not add a `--dry-run`, a new purge command, or purge JSON output.
- Use user-facing names: Docker container, Docker image used by this workspace, SSH connection, Codex remote project, Claude remote connection, generated Boxdown configuration, Boxdown workspace data, and temporary runtime state.
- Never include runtime-secret, private-key, or log contents in preview output.
- Interactive purge stays confirmation-led; explicitly targeted non-interactive/CI purge stays non-blocking and prints plain text before mutation.
- Planning is read-only and must not create the per-workspace command log.
- A cancellation may perform Docker discovery, but must not issue Docker removal commands or delete host state.
- Run verification with Node 24 (`/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`), the CI runtime.

---

### Task 1: Define and test the read-only purge-plan model

**Files:**

- Modify: `src/purge.ts`
- Modify: `__tests__/app.test.ts`

**Interfaces:**

- Produces `PurgePlan` with `workspaceFolder`, `removals`, and `kept` string arrays.
- Produces `createPurgePlan(context, { alias? })`, which reads metadata/filesystem/Docker state only.
- Produces `formatPurgePlanDetails(plan)` for prompt details and `formatPurgePlanText(plan)` for non-interactive stdout.
- `src/main.ts` consumes these exports in Task 2.

- [x] **Step 1: Write the failing planner tests**

Add tests beside the existing purge tests in `__tests__/app.test.ts`. Set up a workspace with a generated config, runtime directory, metadata alias, and fake Docker container/image. Assert the rendered plan contains the exact workspace path, Docker container state, image name and ID, managed alias, all three exact Boxdown paths, and the repository-retention guarantee. Add an absent-resource case that says `No Boxdown Docker container currently exists` and never promises that absent paths will be removed.

```ts
const plan = await createPurgePlan(context, { alias: 'provided-devcontainer' })
const text = formatPurgePlanText(plan)

assert.match(text, /Docker container: purge-plan-container \(running\)/)
assert.match(text, /Docker image used by this workspace: boxdown-test:purge-plan-container \(sha256:purge-plan-image\)/)
assert.ok(text.includes(context.workspaceCacheDir))
assert.ok(text.includes(context.workspaceDataDir))
assert.ok(text.includes(context.workspaceRuntimeDir))
assert.ok(text.includes(`Your repository and files: ${context.workspaceFolder}`))
```

- [x] **Step 2: Run the planner tests to verify they fail**

Run:

```sh
task_node='/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin'
PATH="$task_node:$PATH" node --import tsx --test --test-name-pattern='purge plan' __tests__/app.test.ts
```

Expected: FAIL because `createPurgePlan` and the formatters do not exist.

- [x] **Step 3: Implement the minimal plan builder and formatters**

In `src/purge.ts`, add this public shape and keep all discovery read-only:

```ts
export interface PurgePlan {
  workspaceFolder: string
  removals: string[]
  kept: string[]
}

export async function createPurgePlan (
  context: WorkspaceContext,
  options: Pick<PurgeOptions, 'alias'> = {}
): Promise<PurgePlan> {
  const metadata = readWorkspaceMetadata(context)
  const aliases = uniqueAliases([options.alias, metadata?.sshAlias, defaultSshAlias(context.workspaceBasename)])
  const removals: string[] = []
  const kept = [
    `Your repository and files: ${context.workspaceFolder}`,
    'Your Git history and original host Git configuration',
    'Other Docker containers, images, volumes, and Boxdown workspaces'
  ]
  return { workspaceFolder: context.workspaceFolder, removals, kept }
}

export function formatPurgePlanDetails (plan: PurgePlan): string[] {
  return [
    `Workspace: ${plan.workspaceFolder}`,
    'This will remove:',
    ...plan.removals.map((item) => `• ${item}`),
    'This will keep:',
    ...plan.kept.map((item) => `• ${item}`)
  ]
}

export function formatPurgePlanText (plan: PurgePlan): string {
  return [
    `Purge plan: ${plan.workspaceFolder}`,
    'This will remove:',
    ...plan.removals.map((item) => `- ${item}`),
    'This will keep:',
    ...plan.kept.map((item) => `- ${item}`)
  ].join('\n')
}
```

Use `findWorkspaceContainer` and `inspectContainerImage` for a live Docker snapshot. If lookup or inspect fails, emit an honest unavailable message and fall back to `metadata?.dockerImageId` only when available. For every workspace state directory, use `existsSync` and include its absolute path plus a concise high-level description; do not enumerate files. Include `Docker volumes attached only to that container` only when a live container was found. Change purge-execution messages in this file from `devcontainer` to `Docker container`.

- [x] **Step 4: Run the planner tests to verify they pass**

Run the command from Step 2.

Expected: PASS.

- [x] **Step 5: Commit the planner increment**

```sh
git add src/purge.ts __tests__/app.test.ts
git commit -m "feat: describe purge resources"
```

### Task 2: Render plans before purge confirmation and CI mutation

**Files:**

- Modify: `src/main.ts`
- Modify: `__tests__/app.test.ts`

**Interfaces:**

- Consumes `createPurgePlan`, `formatPurgePlanDetails`, and `formatPurgePlanText` from `src/purge.ts`.
- Extends `confirmPurgeTargets` to receive plans matching its resolved targets.
- Leaves deletion in `purgeWorkspace`.

- [x] **Step 1: Write the failing command-flow tests**

Add these tests:

1. Interactive `purge --workspace <path>` renders `This will remove:`, a concrete container/image, exact cache/data/runtime paths, and `This will keep:` before confirmation.
2. Cancelling that prompt allows lookup/inspect but no fake Docker call starts with `rm -f` or `image rm -f`; all state directories remain and the command log is absent.
3. CI-style targeted purge uses `runCliProcess`, prints `Purge plan:` and concrete resources before removal, contains no `\u001B`, and never prints `Purge Boxdown workspace?`.
4. The existing selected-batch test asserts both workspace paths appear in the single confirmation plan.

- [x] **Step 2: Run command-flow tests to verify they fail**

Run:

```sh
task_node='/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin'
PATH="$task_node:$PATH" node --import tsx --test --test-name-pattern='purge plan|cancels interactive purge|batch purge' __tests__/app.test.ts
```

Expected: FAIL because `runPurgeCommand` does not build or render plans before confirmation/mutation.

- [x] **Step 3: Integrate plans at the confirmation boundary**

In `src/main.ts`, build plans after `resolvePurgeTargets` succeeds and before `confirmPurgeTargets`:

```ts
const plans = await Promise.all(resolved.targets.map(async (target) => ({
  target,
  plan: await createPurgePlan(target.context, { alias: parsed.alias })
})))
```

Pass `plans` to `confirmPurgeTargets`. In interactive mode, make single-workspace and batch prompt details from `formatPurgePlanDetails(plan)`, prefixing every batch plan with a blank line and workspace header. In non-interactive mode, write each `formatPurgePlanText(plan)` to stdout with a blank separator and return `true` without a prompt. Determine interactivity with the existing `canPromptInteractively(input, output, env)` predicate. Do not create a lifecycle logger or invoke `purgeWorkspace` until after plans are printed and interactive confirmation succeeds.

- [x] **Step 4: Run command-flow tests to verify they pass**

Run the command from Step 2.

Expected: PASS. Interactive output is styled by existing prompt helpers; CI output is plain text and appears before Docker removal.

- [x] **Step 5: Commit the integration increment**

```sh
git add src/main.ts __tests__/app.test.ts
git commit -m "feat: preview purge resources before removal"
```

### Task 3: Document behavior and run full verification

**Files:**

- Modify: `docs/features/lifecycle.md`
- Modify: `docs/superpowers/plans/2026-07-26-purge-removal-plan.md`

**Interfaces:**

- Documents the CLI behavior supplied by Tasks 1 and 2.
- No production interface changes.

- [x] **Step 1: Add lifecycle documentation**

Replace the generic purge-confirmation description in `docs/features/lifecycle.md` with the approved contract: interactive purge shows a resource-level plan before confirmation; it lists the Docker container/image/attached anonymous volumes, managed SSH and app entries, exact Boxdown paths, and untouched resources. Explicitly targeted CI/non-interactive purges print the same plan in plain text before mutation and do not prompt. The plan is a snapshot and execution rechecks Docker state.

- [x] **Step 2: Run Markdown lint**

```sh
task_node='/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin'
PATH="$task_node:$PATH" pnpm run lint:markdown
```

Expected: PASS.

- [x] **Step 3: Run full verification**

```sh
task_node='/Users/lirantal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin'
PATH="$task_node:$PATH" pnpm test
PATH="$task_node:$PATH" pnpm run lint
PATH="$task_node:$PATH" pnpm run build
git diff --check
```

Expected: every command exits 0.

- [x] **Step 4: Mark executed plan steps complete and commit documentation**

```sh
git add docs/features/lifecycle.md docs/superpowers/plans/2026-07-26-purge-removal-plan.md
git commit -m "docs: explain purge removal plans"
```
