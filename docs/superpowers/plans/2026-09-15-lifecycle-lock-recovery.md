# Lifecycle Lock Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Boxdown recover immediately from lifecycle locks owned by dead processes, show live lock contention, and prevent the workspace-container lookup from blocking forever.

**Architecture:** Keep the existing atomic directory lock and owner nonce. Move PID liveness ahead of the age gate so confirmed-dead owners are reclaimed immediately, add a one-shot wait callback for progress, and apply a 30-second timeout only to the filtered Docker lookup that triggered the incident.

**Tech Stack:** TypeScript, Node.js filesystem/process APIs, Node test runner, pnpm.

## Global Constraints

- Preserve serialization while a recorded owner PID is alive.
- Never reclaim a live lock based only on age.
- Keep malformed lock state as an explicit error.
- Do not add deadlines to `devcontainer up`, image builds, container stops, or container removal.
- Do not change the separate Cursor integration lock.

---

### Task 1: Recover dead lifecycle owners and report contention

**Files:**
- Modify: `src/workspace-lifecycle-lock.ts:7-200`
- Modify: `src/devcontainer.ts:645-647`
- Test: `__tests__/workspace-lifecycle-lock.test.ts`
- Test: `__tests__/app.test.ts`

**Interfaces:**
- Consumes: `WorkspaceContext`, `ProgressReporter.status(message: string)`.
- Produces: `WorkspaceLifecycleLockOptions.onWait?: () => void`; immediate dead-owner recovery; one wait notification per acquisition attempt.

- [ ] **Step 1: Write the failing dead-owner regression test**

Add imports for `mkdirSync` and `writeFileSync`, then create a valid young lock
whose injected liveness probe returns `false`. Assert the operation runs and the
polling sleep is never reached:

```ts
test('reclaims a lock immediately when its owner process is dead', async () => {
  const context = createWorkspaceContext({
    workspace: tempDir('dead-owner-workspace'),
    env: {
      BOXDOWN_CACHE_HOME: tempDir('dead-owner-cache'),
      BOXDOWN_DATA_HOME: tempDir('dead-owner-data')
    }
  })
  const lockPath = join(context.workspaceDataDir, 'lifecycle.lock')

  mkdirSync(lockPath, { recursive: true })
  writeFileSync(join(lockPath, 'owner.json'), `${JSON.stringify({
    pid: 424242,
    timestamp: '2026-09-15T15:50:33.577Z',
    nonce: 'orphaned-owner'
  })}\n`)

  const result = await withWorkspaceLifecycleLock(context, async () => 'recovered', {
    now: () => new Date('2026-09-15T15:50:34.000Z'),
    pidIsAlive: () => false,
    sleep: async () => {
      throw new Error('dead owner was not reclaimed immediately')
    }
  })

  assert.strictEqual(result, 'recovered')
})
```

- [ ] **Step 2: Run the dead-owner test to verify RED**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern "reclaims a lock immediately" __tests__/workspace-lifecycle-lock.test.ts
```

Expected: FAIL with `dead owner was not reclaimed immediately` because the
current implementation checks liveness only after ten minutes.

- [ ] **Step 3: Write the failing one-shot contention notification test**

Extend the existing concurrent-operation test with an `onWait` callback and
assert it runs exactly once even though the contender polls multiple times:

```ts
let waitNotifications = 0
let contentionPolls = 0

const second = withWorkspaceLifecycleLock(context, async () => {
  events.push('second-enter')
  return 'second'
}, {
  pidIsAlive: () => true,
  onWait: () => { waitNotifications += 1 },
  sleep: async () => {
    contentionPolls += 1
    observeContention()
    await new Promise<void>(resolve => setImmediate(resolve))
  }
})

await contentionObserved
await new Promise<void>(resolve => setImmediate(resolve))
assert.ok(contentionPolls >= 1)
assert.strictEqual(waitNotifications, 1)
```

- [ ] **Step 4: Run the contention test to verify RED**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern "serializes concurrent" __tests__/workspace-lifecycle-lock.test.ts
```

Expected: FAIL because `onWait` is currently ignored and the notification count
is zero.

- [ ] **Step 5: Implement immediate recovery and one-shot notification**

In `WorkspaceLifecycleLockOptions`, remove `staleLockMs` and add:

```ts
onWait?: () => void
```

Remove `DEFAULT_STALE_LOCK_MS`, initialize a notification guard before the
acquisition loop, and replace the age-gated liveness block with:

```ts
let waitNotified = false

// Inside the acquisition loop, after reading `observed`:
let alive: boolean
try {
  alive = pidIsAlive(observed.pid)
} catch {
  alive = true
}

if (!alive && reclaimLock(lockPath, observed)) continue

if (!waitNotified) {
  options.onWait?.()
  waitNotified = true
}
```

Keep the existing timeout and 50 ms poll after this block.

- [ ] **Step 6: Wire contention to lifecycle progress**

Update `startDevcontainer` to pass a callback only when progress exists:

```ts
export async function startDevcontainer (context: WorkspaceContext, options: StartOptions = {}): Promise<string> {
  return await withWorkspaceLifecycleLock(
    context,
    () => startDevcontainerUnlocked(context, options),
    options.progress === undefined
      ? {}
      : { onWait: () => options.progress?.status('Waiting for another Boxdown operation') }
  )
}
```

Add an `app.test.ts` source-wiring assertion beside the existing progress source
checks:

```ts
assert.match(devcontainerSource, /onWait: \(\) => options\.progress\?\.status\('Waiting for another Boxdown operation'\)/)
```

- [ ] **Step 7: Run focused tests to verify GREEN**

Run:

```bash
pnpm exec node --import tsx --test __tests__/workspace-lifecycle-lock.test.ts
pnpm exec node --import tsx --test --test-name-pattern "progress source|lifecycle lock" __tests__/app.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/workspace-lifecycle-lock.ts src/devcontainer.ts __tests__/workspace-lifecycle-lock.test.ts __tests__/app.test.ts
git commit -m "fix: recover orphaned lifecycle locks"
```

### Task 2: Bound the workspace-container Docker lookup

**Files:**
- Modify: `src/devcontainer.ts:104-123`
- Test: `__tests__/app.test.ts`

**Interfaces:**
- Consumes: `runBuffered(command, args, options)` and `CommandResult`.
- Produces: `findWorkspaceContainer(..., { runCommand?: typeof runBuffered })`; a 30-second timeout on its filtered `docker ps -a` call.

- [ ] **Step 1: Write the failing timeout-wiring test**

Import `findWorkspaceContainer` and add:

```ts
test('workspace container lookup bounds the Docker inspection command', async () => {
  const context = createWorkspaceContext({
    workspace: tempDir('bounded-container-lookup-workspace'),
    env: {
      BOXDOWN_CACHE_HOME: tempDir('bounded-container-lookup-cache'),
      BOXDOWN_DATA_HOME: tempDir('bounded-container-lookup-data')
    }
  })
  let capturedTimeoutMs: number | undefined

  await assert.rejects(findWorkspaceContainer(context, {
    runCommand: async (command, args, options) => {
      assert.strictEqual(command, 'docker')
      assert.deepStrictEqual(args.slice(0, 2), ['ps', '-a'])
      capturedTimeoutMs = options.timeoutMs
      return {
        code: 124,
        stdout: '',
        stderr: 'Command timed out after 30000 milliseconds.\n',
        timedOut: true
      }
    }
  }), /Could not inspect devcontainer/)

  assert.strictEqual(capturedTimeoutMs, 30_000)
})
```

- [ ] **Step 2: Run the lookup test to verify RED**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern "workspace container lookup bounds" __tests__/app.test.ts
```

Expected: FAIL because `findWorkspaceContainer` does not accept or call the
injected runner and passes no timeout.

- [ ] **Step 3: Implement the bounded lookup**

Add a focused constant and runner option:

```ts
const WORKSPACE_CONTAINER_LOOKUP_TIMEOUT_MS = 30_000

export async function findWorkspaceContainer (
  context: WorkspaceContext,
  options: {
    logger?: WorkspaceCommandLogger
    resourceName?: string
    runCommand?: typeof runBuffered
  } = {}
): Promise<ContainerSummary | undefined> {
  const runCommand = options.runCommand ?? runBuffered
  const result = await runCommand('docker', [
    'ps',
    '-a',
    '--filter',
    `label=devcontainer.local_folder=${context.workspaceFolder}`,
    '--format',
    '{{json .}}'
  ], {
    logger: options.logger,
    mirrorStdout: false,
    mirrorStderr: false,
    timeoutMs: WORKSPACE_CONTAINER_LOOKUP_TIMEOUT_MS
  })
```

Leave parsing and the existing nonzero-exit error unchanged.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern "workspace container lookup bounds|devcontainer up remains" __tests__/app.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/devcontainer.ts __tests__/app.test.ts
git commit -m "fix: bound workspace container lookup"
```

### Task 3: Full verification

**Files:**
- Verify only; modify files only if a check reveals a defect in this plan's changes.

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: verified source, tests, lint, and distribution build.

- [ ] **Step 1: Run the complete test suite**

```bash
pnpm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run lint**

```bash
pnpm lint
```

Expected: exit code 0 with no lint errors.

- [ ] **Step 3: Run the production build**

```bash
pnpm build
```

Expected: exit code 0 and regenerated build artifacts complete successfully.

- [ ] **Step 4: Inspect the final diff and repository state**

```bash
git diff HEAD~2 --check
git status --short
git log -3 --oneline
```

Expected: no whitespace errors; only the user's pre-existing untracked files
remain; the design and two implementation commits are present.
