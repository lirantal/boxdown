# GitHub Auth Refresh Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `refresh-gh-token` reuse a matching running devcontainer before falling back to startup, and remove `refresh-gh-token-running` entirely.

**Architecture:** Keep agent-profile validation in `src/devcontainer.ts` and expose it for the CLI fast path. In `runCli()`, look up a running workspace container before initializing refresh progress: compatible running containers use the auth refresh directly; absent containers retain the existing lifecycle-and-start flow. Remove the retired command from parsing, help, documentation, and test matrices.

**Tech Stack:** TypeScript (Node.js), Node test runner, c8, ESLint, markdownlint.

## Global Constraints

- `refresh-gh-token` resolves agent profiles as explicit option, then workspace metadata, then default `auth`.
- A running container must match that resolved profile; otherwise fail with the existing `boxdown start --recreate --agent-profile <tier>` guidance.
- The running-container path must not run runtime preflight, write workspace metadata, prepare startup SSH/config state, or invoke `devcontainer up`.
- The auth-refresh operation retains its own generated-config step.
- No deprecated alias or compatibility parser path for `refresh-gh-token-running`.
- Do not add dependencies or change the devcontainer image.

---

### Task 1: Add a tested running-container fast path

**Files:**
- Modify: `src/devcontainer.ts:314-322`
- Modify: `src/main.ts:8, 58-75, 1577-1618`
- Test: `__tests__/app.test.ts:2400-2440`

**Interfaces:**
- Consumes: `findRunningContainerId(context, { logger })` and `inspectContainerAgentProfile(containerId, { logger })`.
- Produces: `assertContainerAgentProfile(containerId: string, agentProfile: AgentProfile, logger?: WorkspaceCommandLogger): Promise<void>` exported from `src/devcontainer.ts`.
- Produces: `RunCliOptions.assertContainerAgentProfile?: typeof assertContainerAgentProfile` for deterministic CLI dispatch tests.

- [ ] **Step 1: Write the failing fast-path and fallback dispatch tests**

  Replace the existing `running-only GitHub token refresh does not invoke the lifecycle gate` test with these three tests near the other `runCli()` lifecycle tests:

  ```ts
  test('refreshes GitHub auth in a matching running devcontainer without startup', async () => {
    const workspace = tempDir('running-refresh-workspace')
    const env = { CI: '1', BOXDOWN_DATA_HOME: tempDir('running-refresh-data'), BOXDOWN_CACHE_HOME: tempDir('running-refresh-cache') }
    const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
    const calls: string[] = []

    const code = await withProcessEnv(env, async () => runCli(['refresh-gh-token', '--workspace', workspace], {
      env,
      findRunningContainerId: async () => { calls.push('find'); return 'running-container' },
      assertContainerAgentProfile: async (id, profile) => {
        assert.strictEqual(id, 'running-container')
        assert.strictEqual(profile, 'auth')
        calls.push('profile')
      },
      prepareContainerLifecycle: async () => { calls.push('unexpected:lifecycle') },
      startDevcontainer: async () => { calls.push('unexpected:start'); return 'unexpected' },
      refreshContainerGhAuth: async (_context, refreshOptions) => {
        assert.strictEqual(refreshOptions.agentProfile, 'auth')
        assert.strictEqual(refreshOptions.progress?.hasStep('devcontainer-running'), true)
        assert.strictEqual(refreshOptions.progress?.hasStep('devcontainer-start'), false)
        calls.push('refresh')
      }
    }))

    assert.strictEqual(code, 0)
    assert.deepStrictEqual(calls, ['find', 'profile', 'refresh'])
    assert.strictEqual(existsSync(workspaceMetadataPath(context)), false)
  })

  test('rejects a profile mismatch in a running devcontainer before refresh or startup', async () => {
    const workspace = tempDir('running-refresh-mismatch-workspace')
    const env = { CI: '1', BOXDOWN_DATA_HOME: tempDir('running-refresh-mismatch-data'), BOXDOWN_CACHE_HOME: tempDir('running-refresh-mismatch-cache') }
    const calls: string[] = []
    const mismatch = new Error('Agent profile full is not active in this devcontainer.')

    await assert.rejects(withProcessEnv(env, async () => runCli(['refresh-gh-token', '--workspace', workspace, '--agent-profile', 'full'], {
      env,
      findRunningContainerId: async () => { calls.push('find'); return 'running-container' },
      assertContainerAgentProfile: async (_id, profile) => {
        assert.strictEqual(profile, 'full')
        calls.push('profile')
        throw mismatch
      },
      prepareContainerLifecycle: async () => { calls.push('unexpected:lifecycle') },
      startDevcontainer: async () => { calls.push('unexpected:start'); return 'unexpected' },
      refreshContainerGhAuth: async () => { calls.push('unexpected:refresh') }
    })), (error: unknown) => error === mismatch)

    assert.deepStrictEqual(calls, ['find', 'profile'])
  })

  test('starts then refreshes GitHub auth when no devcontainer is running', async () => {
    const workspace = tempDir('fallback-refresh-workspace')
    const env = { CI: '1', BOXDOWN_DATA_HOME: tempDir('fallback-refresh-data'), BOXDOWN_CACHE_HOME: tempDir('fallback-refresh-cache') }
    const calls: string[] = []

    const code = await withProcessEnv(env, async () => runCli(['refresh-gh-token', '--workspace', workspace, '--agent-profile', 'none'], {
      env,
      findRunningContainerId: async () => { calls.push('find'); return undefined },
      prepareContainerLifecycle: async (_context, _alias, _progress, _options, _logger, profile) => {
        assert.strictEqual(profile, 'none')
        calls.push('lifecycle')
      },
      startDevcontainer: async (_context, startOptions) => {
        assert.strictEqual(startOptions.agentProfile, 'none')
        calls.push('start')
        return 'started-container'
      },
      refreshContainerGhAuth: async (_context, refreshOptions) => {
        assert.strictEqual(refreshOptions.agentProfile, 'none')
        assert.strictEqual(refreshOptions.progress?.hasStep('devcontainer-start'), true)
        calls.push('refresh')
      }
    }))

    assert.strictEqual(code, 0)
    assert.deepStrictEqual(calls, ['find', 'lifecycle', 'start', 'refresh'])
  })
  ```

- [ ] **Step 2: Run the focused tests and verify they fail**

  Run:

  ```sh
  pnpm exec node --import tsx --test --test-name-pattern "GitHub auth.*(running|starts)|profile mismatch" __tests__/app.test.ts
  ```

  Expected: FAIL because `RunCliOptions` does not accept `assertContainerAgentProfile`, and the current `refresh-gh-token` branch always invokes lifecycle preparation and `startDevcontainer`.

- [ ] **Step 3: Export the existing profile assertion and inject it through `RunCliOptions`**

  In `src/devcontainer.ts`, export the existing helper without changing its message or validation behavior:

  ```ts
  export async function assertContainerAgentProfile (
    containerId: string,
    agentProfile: AgentProfile,
    logger?: WorkspaceCommandLogger
  ): Promise<void> {
    if (await inspectContainerAgentProfile(containerId, { logger }) !== agentProfile) {
      throw new Error(agentProfileMismatchMessage(agentProfile))
    }
  }
  ```

  In `src/main.ts`, add the helper to the existing devcontainer import and add
  the optional dependency to `RunCliOptions`:

  ```ts
  import { startDevcontainer, printPortHint, openShell, openCodingAgentCli, ensureContainerSshRuntime, runSshdProxy, refreshContainerGhAuth, refreshContainerCodingAgentClis, ensureContainerCodingAgentCli, findRunningContainerId, findWorkspaceContainer, inspectContainerAgentProfile, assertContainerAgentProfile, stopWorkspaceContainer, removeWorkspaceContainer, listWorkspaceContainers, openSshTunnel, type TunnelPortForward } from './devcontainer.ts'

  export interface RunCliOptions {
    promptInput?: PromptInput
    promptOutput?: PromptOutput
    env?: NodeJS.ProcessEnv
    runDoctorChecks?: typeof runDoctorChecks
    setupWorkspace?: typeof setupWorkspace
    waitForContainerRuntime?: typeof waitForContainerRuntime
    writeWorkspaceMetadata?: typeof writeWorkspaceMetadata
    prepareContainerLifecycle?: typeof prepareContainerLifecycle
    findRunningContainerId?: typeof findRunningContainerId
    startDevcontainer?: typeof startDevcontainer
    printPortHint?: typeof printPortHint
    openShell?: typeof openShell
    ensureContainerCodingAgentCli?: typeof ensureContainerCodingAgentCli
    openCodingAgentCli?: typeof openCodingAgentCli
    refreshContainerGhAuth?: typeof refreshContainerGhAuth
    assertContainerAgentProfile?: typeof assertContainerAgentProfile
  }
  ```

  Replace both old refresh command branches with one `refresh-gh-token` branch. Look up the running container inside `runLoggedLifecycle()` so the lookup uses the command logger. Select progress steps from that result, and only enter lifecycle preparation when the lookup returns `undefined`:

  ```ts
  if (parsed.command === 'refresh-gh-token') {
    const start = options.startDevcontainer ?? startDevcontainer
    const refreshGhAuth = options.refreshContainerGhAuth ?? refreshContainerGhAuth
    const assertProfile = options.assertContainerAgentProfile ?? assertContainerAgentProfile
    const findRunning = options.findRunningContainerId ?? findRunningContainerId

    return runLoggedLifecycle(context, 'refresh-gh-token', argv, async (logger) => {
      const runningContainerId = await findRunning(context, { logger })
      const progress = createCliProgress(parsed, 'stdout', { env: options.env })
      await withProgressSection(progress, 'Boxdown GitHub auth refresh', [
        `Workspace: ${context.workspaceFolder}`
      ], async () => {
        progress.setSteps(ghAuthProgressSteps(runningContainerId === undefined))

        if (runningContainerId !== undefined) {
          progress.startStep('devcontainer-running')
          try {
            await assertProfile(runningContainerId, agentProfile.value, logger)
            progress.completeStep('devcontainer-running')
          } catch (error) {
            progress.failStep('devcontainer-running')
            throw error
          }
        } else {
          await (options.prepareContainerLifecycle ?? prepareContainerLifecycle)(context, alias, progress, options, logger, agentProfile.value)
          await start(context, { agentProfile: agentProfile.value, progress, logger })
        }

        await refreshGhAuth(context, { agentProfile: agentProfile.value, progress, logger })
        showDetailedCommandLogPath(progress, context)
      })
      return 0
    })
  }
  ```

- [ ] **Step 4: Run the focused tests and verify they pass**

  Run:

  ```sh
  pnpm exec node --import tsx --test --test-name-pattern "GitHub auth.*(running|starts)|profile mismatch" __tests__/app.test.ts
  ```

  Expected: PASS. The fast-path call sequence is `find`, `profile`, `refresh`; the mismatch does not start or refresh; the fallback sequence is `find`, `lifecycle`, `start`, `refresh`.

- [ ] **Step 5: Commit the fast path**

  ```sh
  git add src/devcontainer.ts src/main.ts __tests__/app.test.ts
  git commit -m "feat: reuse running container for GitHub auth refresh"
  ```

### Task 2: Remove the retired command from the public CLI contract

**Files:**
- Modify: `src/main.ts:28-42, 88-135, 167-185, 480-490`
- Test: `__tests__/app.test.ts:812-825, 875-950, 4750-4790`

**Interfaces:**
- Consumes: the single `BoxdownCommand` value `'refresh-gh-token'` from Task 1.
- Produces: parser behavior in which `refresh-gh-token-running` throws `Unknown command: refresh-gh-token-running`.

- [ ] **Step 1: Write failing public-contract tests**

  Update parser and help tests so the retired command is no longer included in the `--agent-profile` rejection matrix. Add this explicit parser assertion:

  ```ts
  assert.throws(
    () => parseCliArgs(['refresh-gh-token-running']),
    /Unknown command: refresh-gh-token-running/
  )
  ```

  Update the help tests to assert only the remaining command text:

  ```ts
  assert.match(USAGE, /refresh-gh-token\s+Start or reuse the devcontainer/)
  assert.doesNotMatch(USAGE, /refresh-gh-token-running/)
  ```

  In the wrapped-description alignment test, derive the description column from the `refresh-gh-token` command line:

  ```ts
  const longestCommandLine = commandLines.find((line) => line.startsWith('  refresh-gh-token'))
  assert.ok(longestCommandLine !== undefined)
  const descriptionColumn = longestCommandLine.indexOf('Start')
  ```

  Remove the retired command’s expectations from `commandWritesWorkspaceMetadata()` and `commandRequiresContainerRuntime()` test tables.

- [ ] **Step 2: Run the public-contract tests and verify they fail**

  Run:

  ```sh
  pnpm exec node --import tsx --test --test-name-pattern "help describes|help aligns|container runtime readiness|status does not record|parse" __tests__/app.test.ts
  ```

  Expected: FAIL because the parser and usage still expose `refresh-gh-token-running`.

- [ ] **Step 3: Delete the command’s parser, usage, and classification entries**

  In `src/main.ts`:

  - remove `'refresh-gh-token-running'` from `BoxdownCommand`;
  - remove its usage synopsis and two-line command description;
  - remove the positional parser branch that returns it;
  - remove its metadata classification entry; and
  - remove its runtime-readiness branch/entry, leaving `refresh-gh-token` classified as lifecycle-capable because its fallback starts a container.

  Do not add an alias, warning, or compatibility fallback. The normal unknown-command path must handle the removed name.

- [ ] **Step 4: Run the public-contract tests and verify they pass**

  Run:

  ```sh
  pnpm exec node --import tsx --test --test-name-pattern "help describes|help aligns|container runtime readiness|status does not record|parse" __tests__/app.test.ts
  ```

  Expected: PASS, including a direct unknown-command error for `refresh-gh-token-running`.

- [ ] **Step 5: Commit the CLI removal**

  ```sh
  git add src/main.ts __tests__/app.test.ts
  git commit -m "feat!: remove running-only GitHub auth refresh command"
  ```

### Task 3: Update documentation and verify the complete change

**Files:**
- Modify: `README.md:300-320`
- Modify: `docs/features/github-auth-refresh.md:3-41`
- Test: `__tests__/app.test.ts:890-930`

**Interfaces:**
- Consumes: the single-command CLI contract from Task 2.
- Produces: user documentation that describes running-container reuse before startup fallback.

- [ ] **Step 1: Write failing documentation assertions**

  In the existing documentation test area, load `docs/features/github-auth-refresh.md` and assert the public contract:

  ```ts
  const githubAuth = readFileSync(join(process.cwd(), 'docs/features/github-auth-refresh.md'), 'utf8')
  assert.match(githubAuth, /only GitHub CLI auth-refresh command/)
  assert.match(githubAuth, /running.*container.*refreshes.*in place/is)
  assert.match(githubAuth, /no.*running.*container.*starts/is)
  assert.doesNotMatch(githubAuth, /refresh-gh-token-running/)
  ```

  Extend the README documentation assertion to reject the retired command:

  ```ts
  assert.doesNotMatch(readme, /refresh-gh-token-running/)
  ```

- [ ] **Step 2: Run the documentation assertions and verify they fail**

  Run:

  ```sh
  pnpm exec node --import tsx --test --test-name-pattern "README documents|feature docs distinguish|GitHub Auth" __tests__/app.test.ts
  ```

  Expected: FAIL because README and the feature guide still list the retired command and describe two command variants.

- [ ] **Step 3: Rewrite the command documentation around one default**

  In `README.md`, remove `boxdown refresh-gh-token-running` from the command example.

  In `docs/features/github-auth-refresh.md`, keep only:

  ```sh
  boxdown refresh-gh-token
  boxdown refresh-gh-token --verbose
  ```

  Replace “Both commands” with “The command”, remove the `refresh-gh-token-running` section, and state the precise flow: Boxdown refreshes a matching running workspace devcontainer in place; when none is running, it starts the devcontainer and then refreshes auth. Keep the existing statements that this is explicit and that it does not open browser/device auth.

- [ ] **Step 4: Run documentation checks and the full verification suite**

  Run:

  ```sh
  pnpm exec node --import tsx --test __tests__/app.test.ts
  pnpm run lint
  pnpm run build
  ```

  Expected: all commands exit 0. The focused test run verifies public docs; the full test, lint, and build runs verify TypeScript and repository-wide regressions.

- [ ] **Step 5: Commit documentation and verification-ready implementation**

  ```sh
  git add README.md docs/features/github-auth-refresh.md __tests__/app.test.ts
  git commit -m "docs: simplify GitHub auth refresh workflow"
  ```
