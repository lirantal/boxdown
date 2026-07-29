# GPG Signing Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn users before GPG-configured commits fail in the default Boxdown image, in lifecycle output and in `boxdown doctor`, without changing Git configuration.

**Architecture:** `src/git-signing.ts` owns a canonical classifier that separates inherited GPG/OpenPGP signing from other user-controlled non-SSH settings. Lifecycle planning maps it to the stable `gpg-signing-unavailable` reason and warning; `src/doctor.ts` maps it to a non-blocking `warn`. The Bash bootstrap continues preserving copied Git configuration unchanged.

**Tech Stack:** TypeScript, Node.js 24 built-in test runner with `tsx`, Bash lifecycle hooks, Markdownlint, ESLint.

## Global Constraints

- Do not install GnuPG, pinentry, or GPG tooling in `assets/image/Dockerfile`.
- Do not copy `~/.gnupg`, private keys, or mount/forward a GPG-agent socket.
- Do not rewrite, disable, or otherwise mutate copied Git signing settings.
- Preserve automatic SSH signing and SSH diagnostics for non-GPG configurations.
- Preserve generic `user-signing-preference` handling for non-GPG non-SSH formats such as `x509`.
- Warnings are non-blocking; `boxdown doctor` exits successfully when this is its only warning.
- Never write secret configuration values to output or the workspace log.
- Require Node `>=24.0.0` and pnpm `>=11.0.0`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/git-signing.ts` | GPG preference classification, disabled-plan reason, lifecycle warning/log mapping. |
| `src/doctor.ts` | Shared-classification mapping to `git-signing-agent` warning and SSH/GitHub probe suppression. |
| `__tests__/app.test.ts` | Lifecycle and doctor regression coverage. |
| `docs/features/commit-signing.md` | Default-image limitation, custom-image boundary, supported SSH alternative. |

---

### Task 1: Classify inherited GPG preferences and warn during lifecycle setup

**Files:**

- Modify: `src/git-signing.ts:8-87,247-270`
- Modify: `__tests__/app.test.ts:6167-6272`

**Interfaces:**

- Produces: `GitSigningReason` includes `'gpg-signing-unavailable'`.
- Produces: `classifyGitSigningPreference(format, program?, signingKey?, commitSign?)` returns `'gpg-signing-unavailable'`, `'user-signing-preference'`, or `undefined`.
- Produces: `resolveGitSigningPlan()` returns `{ enabled: false, reason: 'gpg-signing-unavailable' }` before `ssh-add -L` for GPG/OpenPGP settings.
- Produces: `reportGitSigningPlan()` writes the exact warning and logs `reason=gpg-signing-unavailable`.

- [ ] **Step 1: Write failing lifecycle classification tests**

In `describe('git signing selection')`, change the existing tests at `__tests__/app.test.ts:6167`, `:6197`, and `:6224` to expect:

```ts
assert.deepStrictEqual(plan, {
  enabled: false,
  reason: 'gpg-signing-unavailable'
})
assert.ok(!calls.some((call) => call.startsWith('ssh-add ')))
```

Keep their three input shapes: default OpenPGP with both a signing key and truthy `commit.gpgsign`, repository-local `gpg.format=openpgp`, and truthy `commit.gpgsign` without a format. In the default-OpenPGP fake runner, return both:

```ts
if (command === 'git' && args.includes('user.signingkey')) {
  return { code: 0, stdout: '0123456789ABCDEF\n', stderr: '' }
}
if (command === 'git' && args.includes('commit.gpgsign')) {
  return { code: 0, stdout: 'true\n', stderr: '' }
}
```

Add these tests beside them:

```ts
test('classifies an explicit GPG program without probing the SSH agent', async () => {
  const calls: string[] = []
  const plan = await resolveGitSigningPlan(context, {
    runCommand: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`)
      if (command === 'git' && args.includes('gpg.program')) {
        return { code: 0, stdout: 'gpg2\n', stderr: '' }
      }
      if (command === 'ssh-add') throw new Error('SSH agent must not be queried')
      return { code: 1, stdout: '', stderr: '' }
    }
  })
  assert.deepStrictEqual(plan, { enabled: false, reason: 'gpg-signing-unavailable' })
  assert.ok(!calls.some((call) => call.startsWith('ssh-add ')))
})

test('keeps a non-GPG X.509 preference generic', async () => {
  const plan = await resolveGitSigningPlan(context, {
    runCommand: async (command, args) => {
      if (command === 'git' && args.includes('gpg.format')) {
        return { code: 0, stdout: 'x509\n', stderr: '' }
      }
      if (command === 'ssh-add') throw new Error('SSH agent must not be queried')
      return { code: 1, stdout: '', stderr: '' }
    }
  })
  assert.deepStrictEqual(plan, { enabled: false, reason: 'user-signing-preference' })
})
```

- [ ] **Step 2: Run tests to verify the GPG assertions fail**

Run:

```sh
node --import tsx --test --test-name-pattern='GPG signing preference|GPG program|X.509 preference' __tests__/app.test.ts
```

Expected: the four GPG assertions fail because current code returns `user-signing-preference`; the X.509 assertion passes once present.

- [ ] **Step 3: Add the canonical classifier and wire it into lifecycle planning**

In `src/git-signing.ts`, add `'gpg-signing-unavailable'` to `GitSigningReason` and to `GIT_SIGNING_REASON_MESSAGES` with this exact text:

```ts
'gpg-signing-unavailable': 'GPG commit signing is configured, but the default Boxdown image does not provide GnuPG or GPG-agent forwarding; commits in this container may fail to sign',
```

Replace `hasExplicitNonSshSigningPreference` with:

```ts
export function classifyGitSigningPreference (
  format: Pick<CommandResult, 'code' | 'stdout'>,
  program?: Pick<CommandResult, 'code' | 'stdout'>,
  signingKey?: Pick<CommandResult, 'code' | 'stdout'>,
  commitSign?: Pick<CommandResult, 'code' | 'stdout'>
): Extract<GitSigningReason, 'gpg-signing-unavailable' | 'user-signing-preference'> | undefined {
  const formatValue = format.code === 0 ? format.stdout.trim() : ''
  const programIsConfigured = program?.code === 0 && program.stdout.trim().length > 0

  if (formatValue.length > 0 && formatValue !== 'ssh') {
    return formatValue === 'openpgp' ? 'gpg-signing-unavailable' : 'user-signing-preference'
  }
  if (programIsConfigured) return 'gpg-signing-unavailable'
  if (formatValue === 'ssh') return undefined
  const signingKeyIsConfigured = signingKey?.code === 0 && signingKey.stdout.trim().length > 0
  const commitSigningIsEnabled = commitSign?.code === 0 && isGitBooleanTrue(commitSign.stdout)
  if (signingKeyIsConfigured && commitSigningIsEnabled) return 'gpg-signing-unavailable'
  if (signingKeyIsConfigured) return 'user-signing-preference'
  if (commitSigningIsEnabled) return 'gpg-signing-unavailable'
  return undefined
}
```

In `resolveGitSigningPlan`, retain staged reads and the SSH-only branch. After each read call the classifier and return its reason when defined:

```ts
const format = await readGitSigningConfigValue(context.workspaceFolder, runCommand, 'gpg.format')
let preference = classifyGitSigningPreference(format)
if (preference !== undefined) return { enabled: false, reason: preference }

const program = await readGitSigningConfigValue(context.workspaceFolder, runCommand, 'gpg.program')
preference = classifyGitSigningPreference(format, program)
if (preference !== undefined) return { enabled: false, reason: preference }
```

If the format is not `ssh` and format/program did not already return a reason, read both `user.signingkey` and `commit.gpgsign` before calling the classifier again. This is required to distinguish an enabled default OpenPGP configuration from a signing key whose default signing is off. Do not read those default-GPG settings when `gpg.format=ssh`.

In `reportGitSigningPlan`, branch before generic disabled-signing output:

```ts
if (reason === 'gpg-signing-unavailable') {
  writeWarning(`boxdown: ${GIT_SIGNING_REASON_MESSAGES[reason]}.\n`)
} else if (reason === 'user-signing-preference') {
  writeWarning('boxdown: preserving your existing Git signing configuration; Boxdown SSH signing is skipped.\n')
} else {
  writeWarning(`boxdown: commit signing disabled: ${GIT_SIGNING_REASON_MESSAGES[reason]}; commits will remain unsigned.\n`)
}
```

- [ ] **Step 4: Write the failing lifecycle-reporting regression test**

Place beside `reports an explicit signing preference without claiming commits are unsigned`:

```ts
test('reports unavailable GPG signing without changing the preference', () => {
  const messages: string[] = []
  const logger = createWorkspaceCommandLogger(context)
  reportGitSigningPlan({ enabled: false, reason: 'gpg-signing-unavailable' }, {
    logger,
    writeWarning: (message) => messages.push(message)
  })
  assert.deepStrictEqual(messages, [
    'boxdown: GPG commit signing is configured, but the default Boxdown image does not provide GnuPG or GPG-agent forwarding; commits in this container may fail to sign.\n'
  ])
  assert.match(readFileSync(context.workspaceLogPath, 'utf8'), /reason=gpg-signing-unavailable/)
})
```

- [ ] **Step 5: Run focused lifecycle tests and commit**

Run:

```sh
node --import tsx --test --test-name-pattern='GPG signing preference|GPG program|X.509 preference|unavailable GPG signing|explicit signing preference' __tests__/app.test.ts
```

Expected: PASS. The generic explicit-preference test retains its old preservation message.

```sh
git add src/git-signing.ts __tests__/app.test.ts
git commit -m \"feat: warn about unavailable GPG signing\"
```

### Task 2: Surface the GPG warning from `boxdown doctor`

**Files:**

- Modify: `src/doctor.ts:12,99-187`
- Modify: `__tests__/app.test.ts:4148-4244`

**Interfaces:**

- Consumes: `classifyGitSigningPreference` from `src/git-signing.ts`.
- Produces: `runDoctorChecks()` emits a `git-signing-agent` `warn` with the exact GPG message.
- Produces: doctor does not call `ssh-add` or `gh` for GPG/OpenPGP preferences.

- [ ] **Step 1: Write failing doctor assertions for every GPG shape**

Change the three doctor tests at `__tests__/app.test.ts:4148`, `:4180`, and `:4211` to expect:

```ts
assert.deepStrictEqual(checks.find((check) => check.name === 'git-signing-agent'), {
  name: 'git-signing-agent',
  level: 'warn',
  message: 'GPG commit signing is configured, but the default Boxdown image does not provide GnuPG or GPG-agent forwarding; commits in this container may fail to sign'
})
assert.ok(!calls.some((call) => call.startsWith('ssh-add ')))
assert.ok(!calls.some((call) => call.startsWith('gh ')))
```

Add an equivalent `gpg.program = gpg2` test. Add an X.509 test that expects the current generic result:

```ts
assert.deepStrictEqual(checks.find((check) => check.name === 'git-signing-agent'), {
  name: 'git-signing-agent',
  level: 'ok',
  message: 'Existing non-SSH Git signing configuration detected; Boxdown SSH signing is skipped'
})
```

- [ ] **Step 2: Run doctor tests to verify GPG expectations fail**

```sh
node --import tsx --test --test-name-pattern='GPG signing preference|GPG program|X.509 preference' __tests__/app.test.ts
```

Expected: GPG doctor cases fail because current code emits an `ok` SSH-skip check.

- [ ] **Step 3: Use the shared classifier in doctor**

Replace the `hasExplicitNonSshSigningPreference` import with `classifyGitSigningPreference`. Preserve doctor’s staged Git reads and classify after each read using Task 1’s sequence. When the reason is `'gpg-signing-unavailable'`, append:

```ts
checks.push({
  name: 'git-signing-agent',
  level: 'warn',
  message: 'GPG commit signing is configured, but the default Boxdown image does not provide GnuPG or GPG-agent forwarding; commits in this container may fail to sign'
})
```

Skip SSH-agent discovery, GitHub authentication-key selection, and GitHub SSH signing-key checks in that branch. For `'user-signing-preference'`, retain the existing `ok` message and preserve all SSH code paths.

- [ ] **Step 4: Prove the warning does not fail `boxdown doctor`**

In the existing CLI doctor-command tests, inject:

```ts
runDoctorChecks: async () => [{
  name: 'git-signing-agent',
  level: 'warn',
  message: 'GPG commit signing is configured, but the default Boxdown image does not provide GnuPG or GPG-agent forwarding; commits in this container may fail to sign'
}]
```

Assert the parsed `doctor` command returns `0`.

- [ ] **Step 5: Run focused doctor tests and commit**

```sh
node --import tsx --test --test-name-pattern='doctor.*GPG|GPG.*doctor|X.509 preference|doctor command' __tests__/app.test.ts
```

Expected: PASS; GPG cases warn, SSH/GitHub calls are absent, and doctor exits zero.

```sh
git add src/doctor.ts __tests__/app.test.ts
git commit -m \"fix: diagnose unavailable GPG signing\"
```

### Task 3: Document the default-image limitation and supported alternatives

**Files:**

- Modify: `docs/features/commit-signing.md:70-112`
- Test: Markdownlint through pnpm

**Interfaces:**

- Documents: inherited GPG/OpenPGP settings are preserved but warned about because the default image lacks GnuPG and GPG-agent forwarding.
- Documents: a custom devcontainer image can provide its own secure GPG integration, which Boxdown does not validate.
- Documents: SSH-agent signing remains the supported default and keeps its WSL checks.

- [ ] **Step 1: Update the GPG and WSL documentation**

Replace the claim that GPG/OpenPGP only reports an SSH skip with the following text:

```md
When Git is configured for GPG/OpenPGP signing, Boxdown preserves that
configuration but warns during lifecycle setup and in `boxdown doctor`: the
default image does not include GnuPG or GPG-agent forwarding, so commits in the
container may fail to sign. The warning is non-blocking and does not change Git
configuration.

A custom devcontainer image may provide its own GPG and GPG-agent integration.
Boxdown does not mount `~/.gnupg`, copy private keys, forward a GPG agent, or
validate custom GPG integrations.
```

Retain the `ssh-add -l` and `SSH_AUTH_SOCK` WSL commands. Do not add GPG-agent forwarding instructions.

- [ ] **Step 2: Lint and inspect the documentation**

```sh
pnpm exec markdownlint -c .github/.markdownlint.yml docs/features/commit-signing.md
sed -n '70,125p' docs/features/commit-signing.md
```

Expected: Markdownlint exits `0`, and the section includes the warning, custom-image boundary, and supported SSH alternative.

- [ ] **Step 3: Commit documentation**

```sh
git add docs/features/commit-signing.md
git commit -m \"docs: explain default image GPG limitation\"
```

### Task 4: Run full verification and review scope

**Files:**

- Verify only: `src/git-signing.ts`, `src/doctor.ts`, `__tests__/app.test.ts`, `docs/features/commit-signing.md`

**Interfaces:**

- Verifies: lifecycle and doctor agree on the warning-only GPG result.
- Verifies: SSH signing, generic non-GPG preferences, docs, lint, build, and whitespace checks are unchanged.

- [ ] **Step 1: Run all tests**

```sh
pnpm test
```

Expected: exit `0`.

- [ ] **Step 2: Run lint, build, and whitespace checks**

```sh
pnpm lint
pnpm build
git diff --check HEAD~3..HEAD
```

Expected: each command exits `0`. If there are fewer than three implementation commits, use the range beginning at the commit immediately before Task 1.

- [ ] **Step 3: Review observable output and commit history**

```sh
node --import tsx --test --test-name-pattern='GPG signing preference|GPG program|unavailable GPG signing|doctor.*GPG' __tests__/app.test.ts
git log --oneline -3
```

Expected: focused tests pass and the three commits describe lifecycle classification, doctor diagnostics, and documentation.

- [ ] **Step 4: Confirm the final diff remains within scope**

Confirm before handoff:

```text
No assets/image/Dockerfile change
No ~/.gnupg mount
No GPG-agent socket mount
No private-key handling
No Git configuration rewrite
No SSH signing regression
```

Do not add a fourth commit unless this review finds a defect; test that defect before changing production code.

### Task 5: Preserve explicit SSH signing when a legacy GPG program is configured

**Files:**

- Modify: `src/git-signing.ts:32-60`
- Modify: `__tests__/app.test.ts` in the lifecycle signing and doctor-output test blocks

**Interfaces:**

- Produces: `classifyGitSigningPreference()` returns `undefined` when `gpg.format=ssh`, even if `gpg.program` is non-empty.
- Produces: `resolveGitSigningPlan()` and `runDoctorChecks()` continue through their SSH-agent and GitHub diagnostics for that combination.

- [ ] **Step 1: Write failing lifecycle and doctor regressions**

Add one `resolveGitSigningPlan()` test and one `runDoctorChecks()` test with the following fake configuration:

```ts
if (command === 'git' && args.includes('gpg.format')) {
  return { code: 0, stdout: 'ssh\n', stderr: '' }
}
if (command === 'git' && args.includes('gpg.program')) {
  return { code: 0, stdout: 'gpg2\n', stderr: '' }
}
if (command === 'ssh-add') {
  return { code: 1, stdout: '', stderr: 'agent unavailable\n' }
}
```

The lifecycle assertion must expect `{ enabled: false, reason: 'agent-unavailable' }`, not `gpg-signing-unavailable`. The doctor assertion must expect the existing `warn` message `SSH agent is unavailable; Boxdown commits will remain unsigned`, and both tests must assert that `ssh-add` was called.

- [ ] **Step 2: Run the two tests and verify RED**

```sh
node --import tsx --test --test-name-pattern='SSH format.*GPG program|legacy GPG program.*SSH' __tests__/app.test.ts
```

Expected: FAIL because current classification returns `gpg-signing-unavailable` and never queries `ssh-add`.

- [ ] **Step 3: Make explicit SSH format authoritative**

In `classifyGitSigningPreference()`, return `undefined` immediately after recognizing `formatValue === 'ssh'`, before inspecting `programIsConfigured`:

```ts
if (formatValue === 'ssh') return undefined
if (programIsConfigured) return 'gpg-signing-unavailable'
```

Keep the existing non-SSH format branch above this check and every default-OpenPGP rule below it. Do not change warning text, Git configuration, mounts, image contents, or doctor exit-code handling.

- [ ] **Step 4: Run GREEN, full verification, and commit**

```sh
node --import tsx --test --test-name-pattern='SSH format.*GPG program|legacy GPG program.*SSH|GPG signing preference|GPG program|X.509 preference' __tests__/app.test.ts
pnpm test
pnpm lint
pnpm build
git diff --check
```

Expected: every command exits `0`.

```sh
git add src/git-signing.ts __tests__/app.test.ts
git commit -m "fix: prefer explicit SSH signing format"
```
