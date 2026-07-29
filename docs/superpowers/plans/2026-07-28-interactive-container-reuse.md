# Interactive Container Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make direct interactive Boxdown commands reuse an already-running workspace devcontainer while preserving explicit setup and --recreate semantics.

**Architecture:** Keep reuse centralized in startDevcontainer(), which already skips the Dev Containers CLI when reuseRunning is true. Change only the runCli() callers for start and the shared coding-agent branch; setup remains explicit provisioning. Add narrow optional dependencies to the existing RunCliOptions test seam so command dispatch can be tested without Docker.

**Tech Stack:** TypeScript, Node.js test runner, tsx, ESLint, Markdownlint.

## Global Constraints

- setup remains a full provisioning command and must not pass reuseRunning.
- start, shell, and every coding-agent command reuse a running container.
- --recreate is authoritative: direct commands pass recreate: true and reuseRunning: true; startDevcontainer() retains its existing bypass of the reuse branch.
- A coding-agent command still ensures the requested CLI before opening it.
- Do not change image selection, lifecycle hooks, host-side key/signing/MCP preparation, or SSH proxy/tunnel behavior.

---

### Task 1: Add test seams and failing direct-entry regression coverage

**Files:**

- Modify: src/main.ts:56-66
- Modify: `__tests__/app.test.ts:1326-1373`

**Interfaces:**

- Consumes: RunCliOptions, startDevcontainer(), ensureContainerCodingAgentCli(), openCodingAgentCli(), printPortHint(), and openShell().
- Produces: optional test dependencies that capture start options and command ordering without starting Docker or an interactive process.

- [ ] **Step 1: Write a failing table-driven direct-entry test**

Add this test after the lifecycle-gate test. Import CodingAgentCli as a type from src/coding-agents.ts if it is not already imported.

~~~ts
test('reuses a running devcontainer for direct interactive commands', async () => {
  const cases: Array<{ argv: string[], agent?: CodingAgentCli }> = [
    { argv: ['start'] },
    { argv: ['shell'] },
    { argv: ['codex'], agent: 'codex' },
    { argv: ['claude'], agent: 'claude' },
    { argv: ['cc'], agent: 'claude' },
    { argv: ['opencode'], agent: 'opencode' },
    { argv: ['antigravity'], agent: 'antigravity' }
  ]

  for (const entry of cases) {
    const workspace = tempDir('direct-reuse-' + entry.argv[0] + '-workspace')
    const env = {
      CI: '1',
      BOXDOWN_CACHE_HOME: tempDir('direct-reuse-' + entry.argv[0] + '-cache'),
      BOXDOWN_DATA_HOME: tempDir('direct-reuse-' + entry.argv[0] + '-data')
    }
    const calls: string[] = []

    const code = await runCli([...entry.argv, '--workspace', workspace], {
      env,
      prepareContainerLifecycle: async () => { calls.push('lifecycle') },
      startDevcontainer: async (_context, startOptions) => {
        assert.strictEqual(startOptions.recreate, false)
        assert.strictEqual(startOptions.reuseRunning, true)
        calls.push('start')
        return 'running-container'
      },
      ...(entry.agent === undefined
        ? {
            printPortHint: async () => { calls.push('port') },
            openShell: async () => { calls.push('shell'); return 0 }
          }
        : {
            ensureContainerCodingAgentCli: async (_context, agent) => {
              assert.strictEqual(agent, entry.agent)
              calls.push('ensure:' + agent)
            },
            openCodingAgentCli: async (_context, agent) => {
              assert.strictEqual(agent, entry.agent)
              calls.push('open:' + agent)
              return 0
            }
          })
    })

    assert.strictEqual(code, 0)
    assert.deepStrictEqual(
      calls,
      entry.agent === undefined
        ? ['lifecycle', 'start', 'port', 'shell']
        : ['lifecycle', 'start', 'ensure:' + entry.agent, 'open:' + entry.agent]
    )
  }
})
~~~

- [ ] **Step 2: Run the test and confirm it fails**

Run:

~~~bash
node --import tsx --test --test-name-pattern='reuses a running devcontainer for direct interactive commands' __tests__/app.test.ts
~~~

Expected: FAIL. The current RunCliOptions does not expose these dependencies and the production branches do not pass reuseRunning.

- [ ] **Step 3: Add only the needed optional dependencies**

Extend RunCliOptions with the following fields. They are test dependencies, not new CLI options.

~~~ts
startDevcontainer?: typeof startDevcontainer
printPortHint?: typeof printPortHint
openShell?: typeof openShell
ensureContainerCodingAgentCli?: typeof ensureContainerCodingAgentCli
openCodingAgentCli?: typeof openCodingAgentCli
~~~

At the start of the coding-agent command branch, resolve the injectable dependencies:

~~~ts
const start = options.startDevcontainer ?? startDevcontainer
const ensureAgent = options.ensureContainerCodingAgentCli ?? ensureContainerCodingAgentCli
const openAgent = options.openCodingAgentCli ?? openCodingAgentCli
~~~

At the start of the final start/shell branch, resolve:

~~~ts
const start = options.startDevcontainer ?? startDevcontainer
const printPort = options.printPortHint ?? printPortHint
const shell = options.openShell ?? openShell
~~~

Use these local variables in place of the corresponding direct imports. Do not alter setup, refresh-gh-token, ssh-proxy, or tunnel.

- [ ] **Step 4: Re-run the test and confirm the seam is active**

Run the Step 2 command again.

Expected: FAIL only on the reuseRunning assertion. It must not invoke a real Docker, Dev Containers CLI, shell, or coding-agent process.

### Task 2: Enable reuse and protect recreate semantics

**Files:**

- Modify: src/main.ts:1542-1583
- Modify: `__tests__/app.test.ts:1326-1373`
- Modify: `__tests__/app.test.ts:5355-5399`

**Interfaces:**

- Consumes: the test dependencies from Task 1 and ParsedCli.recreate.
- Produces: startDevcontainer() calls with reuseRunning: true for direct interactive commands; setup retains no reuse option.

- [ ] **Step 1: Add failing recreate and setup-policy tests**

Add a second table-driven runCli() test for ['start', '--recreate'] and ['cc', '--recreate']. Inject the same dependencies as Task 1 and assert:

~~~ts
assert.strictEqual(startOptions.recreate, true)
assert.strictEqual(startOptions.reuseRunning, true)
~~~

Strengthen the existing setup workflow test at `__tests__/app.test.ts:1495` so its injected start dependency verifies setup still has no reuse option:

~~~ts
assert.deepStrictEqual(options, { recreate: undefined })
assert.strictEqual('reuseRunning' in options, false)
~~~

Add a focused startDevcontainer() test beside the existing single-attempt test. Use withFakeDocker() with a running workspace container and call:

~~~ts
await startDevcontainer(context, {
  recreate: true,
  reuseRunning: true,
  progress: createProgress({ mode: 'none' }),
  runDevcontainerUp: async (_label, _command, args) => {
    capturedArgs = args
    return {
      code: 0,
      stdout: '{"containerId":"running-container"}\n',
      stderr: ''
    }
  }
})
~~~

Set the fake container ID to running-container, then assert capturedArgs includes up and --remove-existing-container. Assert the fake Docker call log has no running-container lookup using the {{.ID}} format. This proves the existing recreate guard bypasses reuse at the ownership boundary.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

~~~bash
node --import tsx --test --test-name-pattern='reuses a running devcontainer for direct interactive commands|preserves recreate|setup workflow starts devcontainer' __tests__/app.test.ts
~~~

Expected: the recreate-wiring test fails because direct command branches do not yet pass reuseRunning; the setup policy assertion remains green.

- [ ] **Step 3: Make the minimal production change**

In the coding-agent branch, replace the direct start call with:

~~~ts
await start(context, {
  recreate: parsed.recreate,
  reuseRunning: true,
  progress,
  logger
})
~~~

Call the injected ensureAgent() and openAgent() variables already introduced in Task 1.

In the final start/shell branch, replace the direct start call with:

~~~ts
return await start(context, {
  recreate: parsed.recreate,
  reuseRunning: true,
  progress,
  logger
})
~~~

Call printPort() and shell() in place of the direct imports.

Do not modify startDevcontainer(). Its existing condition already bypasses reuse whenever recreate is true, which preserves --remove-existing-container behavior.

- [ ] **Step 4: Run focused tests and verify the behavior**

Run the Step 2 command again.

Expected: PASS. start, shell, codex, claude, cc, opencode, and antigravity receive reuseRunning: true; agents still ensure before open; setup has no reuse flag; recreate reaches the Dev Containers remove-and-recreate arguments.

- [ ] **Step 5: Commit the green test, seam, and behavioral change**

~~~bash
git add src/main.ts __tests__/app.test.ts
git commit -m "fix: reuse running containers for interactive commands"
~~~

### Task 3: Document the lifecycle distinction

**Files:**

- Modify: docs/features/start-and-shell.md:19-76
- Modify: docs/features/setup.md:24-45
- Modify: `__tests__/app.test.ts:803-816`

**Interfaces:**

- Consumes: the policy in docs/superpowers/specs/2026-07-28-interactive-container-reuse-design.md.
- Produces: correct user guidance distinguishing reusable interactive entry from explicit setup provisioning.

- [ ] **Step 1: Add failing documentation assertions**

Add an adjacent test named documents interactive container reuse lifecycle. Read both feature documents and assert:

~~~ts
const startDocs = readFileSync(join(process.cwd(), 'docs/features/start-and-shell.md'), 'utf8')
const setupDocs = readFileSync(join(process.cwd(), 'docs/features/setup.md'), 'utf8')

assert.match(startDocs, /reuse an already-running workspace devcontainer/i)
assert.match(startDocs, /--recreate.*bypasses reuse/i)
assert.match(setupDocs, /explicit provisioning/i)
~~~

- [ ] **Step 2: Run the documentation test and confirm it fails**

Run:

~~~bash
node --import tsx --test --test-name-pattern='documents interactive container reuse lifecycle' __tests__/app.test.ts
~~~

Expected: FAIL because the current start flow is written as an unconditional devcontainer up and setup is not called explicit provisioning.

- [ ] **Step 3: Update the start and setup guides**

In docs/features/start-and-shell.md:

- State that start, shell, and all coding-agent commands reuse an already-running workspace devcontainer.
- Replace the unconditional flow step 5 with: Reuse a running devcontainer; otherwise run devcontainer up with the workspace and generated config.
- State in Recreate that --recreate bypasses reuse and passes --remove-existing-container to the Dev Containers CLI.
- Clarify that coding-agent commands still check the selected CLI before launch, including after reuse.

In docs/features/setup.md:

- Add before Flow: setup is explicit provisioning and follows the full setup lifecycle even when the workspace container is already running.
- Preserve its existing flow and image-migration guidance.

- [ ] **Step 4: Run documentation verification**

Run:

~~~bash
node --import tsx --test --test-name-pattern='documents interactive container reuse lifecycle' __tests__/app.test.ts
pnpm run lint:markdown
~~~

Expected: both commands exit 0.

- [ ] **Step 5: Commit the documentation update**

~~~bash
git add docs/features/start-and-shell.md docs/features/setup.md __tests__/app.test.ts
git commit -m "docs: explain interactive container reuse"
~~~

### Task 4: Verify the complete change set

**Files:**

- Verify: src/main.ts
- Verify: `__tests__/app.test.ts`
- Verify: docs/features/start-and-shell.md
- Verify: docs/features/setup.md

**Interfaces:**

- Consumes: Tasks 1-3.
- Produces: evidence that direct-entry reuse, explicit setup, and recreation remain correct.

- [ ] **Step 1: Review scope and whitespace**

Run:

~~~bash
git diff HEAD~3..HEAD -- src/main.ts __tests__/app.test.ts docs/features/start-and-shell.md docs/features/setup.md
git diff --check
~~~

Expected: only the scoped dispatch, test, and documentation changes; no whitespace errors.

- [ ] **Step 2: Run full verification**

Run:

~~~bash
pnpm test
pnpm run lint
pnpm run build
~~~

Expected: every command exits 0.

- [ ] **Step 3: Confirm the handoff checklist**

~~~text
- start and shell pass reuseRunning: true.
- codex, claude, cc, opencode, and antigravity pass reuseRunning: true.
- Agent ensure runs before agent exec.
- setup does not pass reuseRunning.
- --recreate reaches --remove-existing-container.
- Documentation distinguishes reuse from provisioning and does not claim host preparation is skipped.
~~~

- [ ] **Step 4: Commit only a verification-required correction**

If verification requires a correction, add a focused commit. Otherwise, do not create an empty commit.
