# GPG Signing Diagnosis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avoid presenting Boxdown's optional SSH-signing setup as a failed prerequisite when Git is explicitly configured for GPG or another non-SSH signing method.

**Architecture:** `src/git-signing.ts` will classify a non-SSH `gpg.format` or explicit `gpg.program` before querying the SSH agent and return a stable disabled-plan reason. `src/doctor.ts` will perform the same classification and report that Boxdown's SSH signing was skipped, rather than warning about an unavailable SSH agent. The lifecycle hook continues to preserve explicit user signing configuration; documentation defines the unsupported GPG-agent-forwarding boundary.

**Tech Stack:** TypeScript, Node's built-in test runner, Bash lifecycle hooks, Markdown.

## Global Constraints

- Do not copy GPG private keys, mount `~/.gnupg`, or implement GPG-agent forwarding.
- Preserve the existing SSH-signing behavior when no explicit non-SSH preference exists.
- Keep the existing stable logging of disabled signing plans, without logging secret configuration values.
- Tests must prove the original false-warning case before production code changes.

---

### Task 1: Classify an explicit non-SSH signing preference during lifecycle setup

**Files:**

- Modify: `__tests__/app.test.ts` in the git-signing test block near `reports every disabled signing reason concisely and logs structured detail`
- Modify: `src/git-signing.ts`

**Interfaces:**

- Produces: `GitSigningReason` includes `user-signing-preference`.
- Produces: `resolveGitSigningPlan(context, options)` returns `{ enabled: false, reason: 'user-signing-preference' }` before calling `ssh-add -L` when global Git has non-SSH `gpg.format` or an explicit `gpg.program`.
- Produces: `reportGitSigningPlan(plan)` emits an informational preservation message rather than an unsigned-commit warning for that reason.

- [ ] **Step 1: Write the failing lifecycle preflight test**

```ts
test('preserves an explicit GPG signing preference without probing the SSH agent', async () => {
  const calls: string[] = []

  const plan = await resolveGitSigningPlan(context, {
    runCommand: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`)
      if (command === 'git' && args.includes('gpg.format')) return { code: 0, stdout: 'openpgp\n', stderr: '' }
      if (command === 'ssh-add') return { code: 1, stdout: '', stderr: 'Could not open a connection to your authentication agent.\n' }
      return { code: 1, stdout: '', stderr: '' }
    }
  })

  assert.deepStrictEqual(plan, { enabled: false, reason: 'user-signing-preference' })
  assert.ok(!calls.some((call) => call.startsWith('ssh-add ')))
})
```

- [ ] **Step 2: Run the test to verify it fails because the current implementation probes `ssh-add` first**

Run:

```sh
node --import tsx --test --test-name-pattern='preserves an explicit GPG signing preference' __tests__/app.test.ts
```

Expected: FAIL because the returned reason is `agent-unavailable` and the captured calls include `ssh-add -L`.

- [ ] **Step 3: Write the failing reporting test**

```ts
reportGitSigningPlan({ enabled: false, reason: 'user-signing-preference' }, {
  logger,
  writeWarning: (message) => messages.push(message)
})

assert.deepStrictEqual(messages, [
  'boxdown: preserving your existing Git signing configuration; Boxdown SSH signing is skipped.\n'
])
```

- [ ] **Step 4: Implement the smallest classification and reporting change**

```ts
export type GitSigningReason =
  | 'user-signing-preference'
  // existing reasons

function hasExplicitNonSshSigningPreference(format: CommandResult, program: CommandResult): boolean {
  return (format.code === 0 && format.stdout.trim().length > 0 && format.stdout.trim() !== 'ssh') ||
    (program.code === 0 && program.stdout.trim().length > 0)
}
```

At the start of `resolveGitSigningPlan`, query global `gpg.format` and `gpg.program`; return the new reason when the helper reports an explicit non-SSH preference. In `reportGitSigningPlan`, log the stable reason but use the preservation message for this one reason; retain the existing warning text for every failed SSH-signing reason.

- [ ] **Step 5: Run the focused lifecycle tests**

Run:

```sh
node --import tsx --test --test-name-pattern='GPG signing preference|disabled signing reason|git signing preflight' __tests__/app.test.ts
```

Expected: PASS.

### Task 2: Make `boxdown doctor` explain that SSH signing was intentionally skipped

**Files:**

- Modify: `__tests__/app.test.ts` in `describe('doctor output')`
- Modify: `src/doctor.ts`

**Interfaces:**

- Produces: the `git-signing-agent` check `{ level: 'ok', message: 'Existing non-SSH Git signing configuration detected; Boxdown SSH signing is skipped' }` for a non-SSH format, even if `ssh-add -L` fails.
- Consumes: the same non-SSH preference definition used by lifecycle setup, without introducing GPG-agent forwarding.

- [ ] **Step 1: Write the failing doctor regression test**

```ts
test('doctor skips SSH signing checks for an explicit GPG signing preference', async () => {
  const checks = await runDoctorChecks(context, {
    includeOptional: false,
    includeDockerMountProbe: false,
    runCommand: async (command, args) => {
      if (command === 'git' && args.includes('gpg.format')) return { code: 0, stdout: 'openpgp\n', stderr: '' }
      if (command === 'ssh-add') return { code: 1, stdout: '', stderr: 'agent unavailable\n' }
      return { code: 0, stdout: '', stderr: '' }
    }
  })

  assert.deepStrictEqual(checks.find((check) => check.name === 'git-signing-agent'), {
    name: 'git-signing-agent',
    level: 'ok',
    message: 'Existing non-SSH Git signing configuration detected; Boxdown SSH signing is skipped'
  })
})
```

- [ ] **Step 2: Run the test to verify it fails with the current SSH-agent warning**

Run:

```sh
node --import tsx --test --test-name-pattern='doctor skips SSH signing checks' __tests__/app.test.ts
```

Expected: FAIL because the current check is `warn` and says the SSH agent is unavailable.

- [ ] **Step 3: Implement the smallest doctor classification change**

Query global `gpg.format` and `gpg.program` before evaluating `ssh-add`. When either represents an explicit non-SSH signing preference, append the exact `ok` check above and skip GitHub SSH-key diagnostics. Otherwise retain the existing identity selection and GitHub verification behavior.

- [ ] **Step 4: Run the focused doctor tests**

Run:

```sh
node --import tsx --test --test-name-pattern='doctor.*signing|GitHub matching' __tests__/app.test.ts
```

Expected: PASS.

### Task 3: Document the GPG and WSL support boundary

**Files:**

- Modify: `docs/features/commit-signing.md`

**Interfaces:**

- Documents: SSH-agent signing is the supported automatic path.
- Documents: non-SSH/GPG settings are preserved but Boxdown does not install GnuPG, mount `~/.gnupg`, or forward a GPG agent.
- Documents: users who want SSH signing in WSL need a reachable `SSH_AUTH_SOCK` and loaded identity; a GPG workflow needs a custom devcontainer configuration today.

- [ ] **Step 1: Add the supported-path and GPG-boundary documentation**

Add a `## GPG and WSL` section after `## User configuration precedence` that states the exact support boundary and includes:

```bash
ssh-add -l
printf '%s\n' "$SSH_AUTH_SOCK"
```

State that an existing non-SSH configuration is preserved and results in an informational skip, not an SSH-agent warning.

- [ ] **Step 2: Run Markdown lint for the changed documentation**

Run:

```sh
pnpm exec markdownlint -c .github/.markdownlint.yml docs/features/commit-signing.md
```

Expected: exit 0.

### Task 4: Run full verification

**Files:**

- Verify only

- [ ] **Step 1: Run the entire test suite under a Node 24 runtime**

Run:

```sh
pnpm test
```

Expected: exit 0 with all tests passing.

- [ ] **Step 2: Run lint and build under Node 24**

Run:

```sh
pnpm lint
pnpm build
git diff --check
```

Expected: each command exits 0.

- [ ] **Step 3: Review the final diff against the goal**

Confirm the diff contains no GPG private-key handling, no new mounts, and no behavior change for SSH-signing users.
