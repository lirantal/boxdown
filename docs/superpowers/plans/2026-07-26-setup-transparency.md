# Setup Transparency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make interactive `boxdown --verbose` explain the real lifecycle as a structured trace while preserving raw output in CI and non-TTY environments.

**Architecture:** Split progress rendering from child-output mirroring. The existing `verbose` progress mode remains the raw-text mode for CI/non-TTY compatibility; add a `detailed` mode for interactive `--verbose`, which consumes existing lifecycle progress markers and emits append-only human-readable events. Keep the normal interactive checklist, add one concise ownership cue for setup, and document Boxdown's resource boundaries in the README.

**Tech Stack:** TypeScript, Node.js built-in test runner with `c8`, Bash lifecycle markers, Markdownlint.

## Global Constraints

- Do not add an explanation, preview, dry-run, or raw-output CLI flag.
- JSON output must remain fully silent apart from its JSON payload.
- CI and non-TTY command output must keep raw stdout/stderr streaming and current stream routing.
- `ssh-proxy` must continue writing all progress and raw child output to stderr.
- Managed child output remains redacted and persisted in the workspace command log in every output mode.
- Do not log interactive shell, coding-agent, or tunnel session bytes.
- Do not modify the target repository as part of progress/reporting work.

---

## File Structure

- `src/progress.ts` owns progress-mode resolution, rendering, command-output mirroring, lifecycle-marker consumption, and failure guidance.
- `src/main.ts` owns CLI usage text and supplies the setup-only ownership cue through the existing progress-section helper.
- `README.md` is the discoverable source of truth for resource ownership and verbosity behaviour.
- `__tests__/app.test.ts` exercises CLI help, progress-mode resolution, detailed trace rendering, raw stream compatibility, and setup output.

### Task 1: Restore the isolated-worktree dependencies and establish a baseline

**Files:**

- Modify: no tracked files
- Verify: `pnpm-lock.yaml`, `package.json`, and `__tests__/**/*.test.ts`

**Interfaces:**

- Consumes: the repository's pinned `pnpm-lock.yaml`.
- Produces: a local `node_modules` directory and a known-good baseline before source edits.

- [ ] **Step 1: Restore the lockfile-pinned dependencies**

  Run:

  ```sh
  pnpm install --frozen-lockfile
  ```

  Expected: exits 0 and creates `node_modules` without changing `package.json` or `pnpm-lock.yaml`.

- [ ] **Step 2: Run the baseline suite**

  Run:

  ```sh
  pnpm test
  ```

  Expected: PASS with zero failing tests. If it fails before any source change, stop and diagnose the baseline failure before continuing this plan.

### Task 2: Add detailed interactive progress mode

**Files:**

- Modify: `src/progress.ts:4-340`
- Test: `__tests__/app.test.ts:3980-4230`

**Interfaces:**

- Consumes: `ResolveProgressModeOptions`, `ProgressReporterOptions`, and existing `ProgressStepDefinition` calls from `src/main.ts` and `src/devcontainer.ts`.
- Produces: `ProgressMode = 'interactive' | 'detailed' | 'verbose' | 'none'`; `ProgressReporter.rawOutput: boolean`; `ProgressReporter.detailed: boolean`.
- Compatibility contract: `verbose` continues to mean raw text mode. `detailed` means structured interactive trace and never mirrors child stdout/stderr.

- [ ] **Step 1: Write failing mode-resolution and environment tests**

  In `__tests__/app.test.ts`, replace the existing `resolves progress modes from terminal and output context` expectations with:

  ```ts
  test('resolves progress modes from terminal and output context', () => {
    assert.strictEqual(resolveProgressMode({ isTTY: true, env: { CI: 'false' } }), 'interactive')
    assert.strictEqual(resolveProgressMode({ target: 'stderr', isTTY: true, env: { CI: 'false' } }), 'interactive')
    assert.strictEqual(resolveProgressMode({ isTTY: true, verbose: true, env: { CI: 'false' } }), 'detailed')
    assert.strictEqual(resolveProgressMode({ isTTY: true, env: { CI: 'true' } }), 'verbose')
    assert.strictEqual(resolveProgressMode({ isTTY: false, env: { CI: 'false' } }), 'verbose')
    assert.strictEqual(resolveProgressMode({ json: true, isTTY: true, verbose: true, env: { CI: 'false' } }), 'none')
  })

  test('detailed progress enables lifecycle markers without raw command mode', () => {
    const progress = createProgress({ mode: 'detailed' })
    assert.strictEqual(progress.detailed, true)
    assert.strictEqual(progress.rawOutput, false)
    assert.deepStrictEqual(progress.commandEnv(), {
      BOXDOWN_VERBOSE: '0',
      BOXDOWN_PROGRESS: '1'
    })
  })

  test('raw progress preserves raw command mode', () => {
    const progress = createProgress({ mode: 'verbose' })
    assert.strictEqual(progress.detailed, false)
    assert.strictEqual(progress.rawOutput, true)
    assert.deepStrictEqual(progress.commandEnv(), {
      BOXDOWN_VERBOSE: '1',
      BOXDOWN_PROGRESS: '0'
    })
  })
  ```

- [ ] **Step 2: Run the focused tests and verify they fail**

  Run:

  ```sh
  pnpm exec node --import tsx --test --test-name-pattern='resolves progress modes|detailed progress enables|raw progress preserves' __tests__/app.test.ts
  ```

  Expected: FAIL because `detailed` is not a `ProgressMode` and the reporter has no `detailed` or `rawOutput` properties.

- [ ] **Step 3: Split mode semantics in `src/progress.ts`**

  Replace the top-level mode declaration with:

  ```ts
  export type ProgressMode = 'interactive' | 'detailed' | 'verbose' | 'none'
  ```

  Update `resolveProgressMode` so JSON wins first, CI/non-TTY returns `'verbose'`, and an explicit verbose flag only returns `'detailed'` when the selected target is a TTY:

  ```ts
  export function resolveProgressMode (options: ResolveProgressModeOptions = {}): ProgressMode {
    if (options.json === true) return 'none'

    const target = options.target ?? 'stdout'
    const isTTY = options.isTTY ?? targetIsTTY(target)

    if (isCiEnvironment(options.env ?? process.env) || !isTTY) return 'verbose'
    if (options.verbose === true) return 'detailed'
    return 'interactive'
  }
  ```

  Add immutable reporter properties and initialise them from the mode:

  ```ts
  readonly rawOutput: boolean
  readonly detailed: boolean

  this.rawOutput = this.mode === 'verbose'
  this.detailed = this.mode === 'detailed'
  this.verbose = this.rawOutput
  ```

  Preserve the existing `verbose` property as an alias for raw-output mode so internal callers that already use it do not accidentally receive a structured mode as raw output.

  Update `commandEnv()` to make detailed mode emit lifecycle markers while retaining raw mode for scripts:

  ```ts
  BOXDOWN_VERBOSE: this.rawOutput ? '1' : '0',
  BOXDOWN_PROGRESS: this.mode === 'interactive' || this.mode === 'detailed' ? '1' : '0'
  ```

- [ ] **Step 4: Implement append-only detailed rendering**

  Add a private mode predicate in `ProgressReporter` and use it for the structured methods:

  ```ts
  #isStructured (): boolean {
    return this.mode === 'interactive' || this.mode === 'detailed'
  }
  ```

  Keep the existing animated redraw logic exclusively for `interactive`. In `detailed` mode:

  - `section(title)` writes the plain title once.
  - `detail(message)` writes two leading spaces followed by `${message}`.
  - `item(message)`, `status(message)`, and `marker(message)` write one normalized plain line.
  - `startStep(id)` writes the step label once when it changes from `pending` to `running`.
  - `completeStep(id)` does not repeat that label.
  - `failStep(id)` writes `Failed: ${label}` and `skipStep(id)` writes `Skipped: ${label}`.
  - `setSteps()` stores state but does not render a checklist; `startSpinner()` writes its normalized label once without creating a timer.
  - `warn(message)` writes `Warning: ${message}`.

  Keep raw `verbose` mode's current plain `status` and `warn` output. Keep `none` silent. Do not render ANSI cursor controls or spinner timers in detailed mode.

- [ ] **Step 5: Run the focused tests and verify they pass**

  Run:

  ```sh
  pnpm exec node --import tsx --test --test-name-pattern='resolves progress modes|detailed progress enables|raw progress preserves|none progress mode' __tests__/app.test.ts
  ```

  Expected: PASS.

- [ ] **Step 6: Commit the progress-mode change**

  ```sh
  git add src/progress.ts __tests__/app.test.ts
  git commit -m "feat: add detailed interactive progress mode"
  ```

### Task 3: Route commands and lifecycle markers through detailed mode

**Files:**

- Modify: `src/progress.ts:500-640`
- Test: `__tests__/app.test.ts:4440-4490`

**Interfaces:**

- Consumes: `ProgressReporter.rawOutput`, `ProgressReporter.detailed`, and `runBuffered()` mirror options.
- Produces: `runProgressCommand()` that streams child output only when `rawOutput` is true and forwards `BOXDOWN_PROGRESS:` markers in both interactive structured modes.
- Compatibility contract: raw mode preserves `verboseStdout`/`verboseStderr` routing; detailed and normal interactive modes keep child output out of the terminal while preserving it in `WorkspaceCommandLogger`.

- [ ] **Step 1: Write failing command-stream tests**

  Replace the current verbose-marker test with two focused tests:

  ```ts
  test('detailed progress renders lifecycle markers without mirroring child output', async () => {
    const lines: string[] = []
    const progress = createProgress({
      mode: 'detailed',
      write: (_target, message) => lines.push(message)
    })

    const result = await runProgressCommand('detailed demo', 'bash', [
      '-c',
      'printf "BOXDOWN_PROGRESS: Configuring global Git\\n"; printf "hidden raw stdout\\n"; printf "hidden raw stderr\\n" >&2'
    ], { progress })

    assert.strictEqual(result.code, 0)
    assert.ok(lines.includes('Configuring global Git'))
    assert.ok(!lines.some((line) => line.includes('hidden raw')))
  })

  test('raw progress still mirrors stdout and stderr to its requested targets', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const progress = createProgress({ mode: 'verbose' })
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write
    try {
      await runProgressCommand('raw demo', 'bash', ['-c', 'printf "raw stdout\\n"; printf "raw stderr\\n" >&2'], { progress })
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
    }
    assert.deepStrictEqual(stdout, ['raw stdout\\n'])
    assert.deepStrictEqual(stderr, ['raw stderr\\n'])
  })
  ```

- [ ] **Step 2: Run the focused tests and verify they fail**

  Run:

  ```sh
  pnpm exec node --import tsx --test --test-name-pattern='detailed progress renders lifecycle markers|raw progress still mirrors' __tests__/app.test.ts
  ```

  Expected: FAIL because `runProgressCommand()` treats detailed progress as raw verbose output.

- [ ] **Step 3: Decouple mirroring from structured progress in `runProgressCommand()`**

  Replace the local `verbose` calculation and mirror configuration with:

  ```ts
  const progress = options.progress
  const rawOutput = progress?.rawOutput ?? true
  const markerSink = progress !== undefined && !rawOutput ? createMarkerSink(progress) : undefined
  const checklistStepId = progress !== undefined && options.stepId !== undefined && progress.hasStep(options.stepId)
    ? options.stepId
    : undefined

  if (progress !== undefined && !rawOutput && checklistStepId !== undefined) {
    progress.startStep(checklistStepId)
  } else if (progress !== undefined && !rawOutput && options.spinnerLabel !== undefined) {
    progress.startSpinner(options.spinnerLabel)
  }
  ```

  Then use `rawOutput` for `mirrorStdout` and `mirrorStderr`:

  ```ts
  mirrorStdout: rawOutput ? (options.verboseStdout ?? 'stdout') : false,
  mirrorStderr: rawOutput ? (options.verboseStderr ?? 'stderr') : false,
  ```

  Keep the existing logger and marker-sink flush behaviour. This ensures that detail markers emitted by `initialize.sh`, `post-create.sh`, `post-start.sh`, and the utility scripts become detailed trace events without exposing unrelated child output.

- [ ] **Step 4: Update failure recovery guidance**

  In `formatCommandFailure()`, replace the raw-output-only instruction:

  ```ts
  'Rerun with --verbose to see full command output.'
  ```

  with:

  ```ts
  'Inspect the command log for full redacted command output.'
  ```

  When `options.logPath` is absent, retain a second sentence:

  ```ts
  'Rerun in a non-interactive terminal with --verbose to stream raw command output.'
  ```

  This keeps failure advice truthful after interactive `--verbose` becomes structured rather than raw.

- [ ] **Step 5: Run focused tests and the full progress test group**

  Run:

  ```sh
  pnpm exec node --import tsx --test --test-name-pattern='progress|failure-tail|detailed progress renders lifecycle markers|raw progress still mirrors' __tests__/app.test.ts
  ```

  Expected: PASS, including the existing `ssh-proxy` stderr-routing tests.

- [ ] **Step 6: Commit the command-routing change**

  ```sh
  git add src/progress.ts __tests__/app.test.ts
  git commit -m "feat: render verbose lifecycle traces interactively"
  ```

### Task 4: Add setup ownership cue and correct CLI help

**Files:**

- Modify: `src/main.ts:67-146,1240-1395`
- Test: `__tests__/app.test.ts:680-745` and the existing setup CLI tests near `__tests__/app.test.ts:1200-1450`

**Interfaces:**

- Consumes: `withProgressSection(progress, title, details, run)` and the already-resolved `ProgressReporter`.
- Produces: setup-only normal/detailed orientation copy and accurate `USAGE` command synopses.
- Compatibility contract: no ownership cue is added to JSON output, and commands whose `--verbose` flag has no observable progress effect do not advertise it in their synopsis.

- [ ] **Step 1: Write failing help and setup-output tests**

  Extend `help describes available commands` with these assertions:

  ```ts
  assert.match(USAGE, /boxdown setup \[--workspace <path>\] \[--alias <name>\] \[--recreate\] \[--target <name>\]\.\.\. \[--verbose\]/)
  assert.match(USAGE, /boxdown start \[--workspace <path>\] \[--recreate\] \[--verbose\]/)
  assert.match(USAGE, /boxdown tunnel \[--port <port>\] \[--port <local:remote>\] \[--workspace <path>\] \[--alias <name>\] \[--verbose\]/)
  assert.match(USAGE, /--verbose\s+Show a detailed lifecycle trace in an interactive terminal\.[\s\S]*Streams raw Docker, devcontainer, and hook output in CI or non-interactive output\./)
  ```

  Add a `runCli(['setup'], ...)` test using the existing `setupWorkspace` test double and captured stdout. Assert that human interactive output contains both:

  ```ts
  'Boxdown keeps generated state outside this repository.'
  'Run `boxdown status` to inspect managed paths and the command log.'
  ```

  Assert the existing JSON boundary remains intact instead of attempting an
  unsupported `setup --json` invocation:

  ```ts
  assert.throws(() => parseCliArgs(['setup', '--json']), /--json is only supported with status and list/)
  ```

- [ ] **Step 2: Run the focused tests and verify they fail**

  Run:

  ```sh
  pnpm exec node --import tsx --test --test-name-pattern='help describes available commands|generated state outside this repository' __tests__/app.test.ts
  ```

  Expected: FAIL because neither the usage syntax nor setup output includes the new copy.

- [ ] **Step 3: Make help syntax and option semantics explicit**

  In the `USAGE` template, append `[--verbose]` to the synopses for:

  ```text
  setup, start, codex, claude, opencode, antigravity,
  ssh-proxy, tunnel, refresh-gh-token, refresh-gh-token-running
  ```

  Do not add it to `list`, `status`, `stop`, `down`, `purge`, `doctor`, or SSH-install/uninstall synopses because they do not create a progress reporter.

  Replace the option copy with this three-line text, keeping existing alignment:

  ```text
  --verbose           Show a detailed lifecycle trace in an interactive terminal.
                      Streams raw Docker, devcontainer, and hook output in CI
                      or non-interactive output. Managed output is appended to
                      the per-workspace command log either way.
  ```

- [ ] **Step 4: Add the interactive setup orientation**

  Define this constant next to the progress-step factories:

  ```ts
  const SETUP_OWNERSHIP_DETAILS = [
    'Boxdown keeps generated state outside this repository.',
    'Run `boxdown status` to inspect managed paths and the command log.'
  ] as const
  ```

  In the `setup` branch of `runCli()`, extend the `withProgressSection()` detail array only when `progress.mode !== 'none'`:

  ```ts
  await withProgressSection(progress, 'Boxdown setup', [
    `Workspace: ${context.workspaceFolder}`,
    `SSH alias: ${alias}`,
    ...(progress.mode === 'none' ? [] : SETUP_OWNERSHIP_DETAILS)
  ], async () => {
  ```

  The `detail()` renderer already remains silent in raw and none modes; retain the conditional so JSON cannot accidentally acquire a future text preamble. Detailed mode displays the same two lines as part of its trace, while normal interactive mode keeps them inside the existing setup section.

- [ ] **Step 5: Run focused CLI tests**

  Run:

  ```sh
  pnpm exec node --import tsx --test --test-name-pattern='help describes available commands|generated state outside this repository|parses global verbose option' __tests__/app.test.ts
  ```

  Expected: PASS.

- [ ] **Step 6: Commit the CLI copy change**

  ```sh
  git add src/main.ts __tests__/app.test.ts
  git commit -m "feat: explain setup lifecycle ownership"
  ```

### Task 5: Document what Boxdown manages

**Files:**

- Modify: `README.md:45-60,235-280`
- Test: `__tests__/app.test.ts:680-745`

**Interfaces:**

- Consumes: the generated-state locations and resource semantics documented in `docs/features/generated-config-and-state.md` and `docs/features/lifecycle.md`.
- Produces: a README section named `What Boxdown manages` and accurate user-facing verbose documentation.

- [ ] **Step 1: Write a source-level README regression test**

  Add a test beside the help assertions:

  ```ts
  test('README documents Boxdown resource ownership and verbosity modes', () => {
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
    assert.match(readme, /## What Boxdown manages/)
    assert.match(readme, /outside the target repository/)
    assert.match(readme, /interactive `--verbose`.*detailed lifecycle trace/is)
    assert.match(readme, /CI and non-interactive.*raw command output/is)
    assert.match(readme, /`stop`.*`down`.*`purge`/is)
  })
  ```

- [ ] **Step 2: Run the README regression test and verify it fails**

  Run:

  ```sh
  pnpm exec node --import tsx --test --test-name-pattern='README documents Boxdown resource ownership' __tests__/app.test.ts
  ```

  Expected: FAIL because the README has no `What Boxdown manages` section.

- [ ] **Step 3: Add the README ownership section and update verbosity copy**

  Replace the introduction's raw-streaming sentence with wording that states:

  - normal startup uses concise progress;
  - interactive `--verbose` shows a detailed lifecycle trace;
  - CI/non-interactive output streams raw managed command output;
  - `boxdown status` reports the per-workspace command-log path.

  Add `## What Boxdown manages` immediately before `### Portless SSH`. Use these exact subsections and content boundaries:

  ```markdown
  ### Outside your repository

  Boxdown stores generated devcontainer configuration under its cache root and
  per-workspace metadata, SSH keys, runtime state, and redacted command log
  under its data roots. It does not copy a `.devcontainer` directory into the
  target repository.

  ### Container inputs

  Boxdown mounts its packaged assets, public SSH key, host Git-config snapshot,
  and runtime-secret directory for the container lifecycle. It only adds
  optional host agent configuration mounts when documented prerequisites exist;
  `boxdown status` reports the exact generated paths for a workspace.

  ### Host integrations

  `boxdown setup` manages a workspace SSH alias. It writes Codex or Claude app
  integration records only when you select or explicitly request those targets.

  ### Cleanup boundary

  `boxdown stop` keeps the container and all Boxdown state. `boxdown down`
  removes the container but keeps Boxdown state. `boxdown purge` removes the
  workspace's Boxdown-managed container, recorded image, generated state,
  command log, and managed SSH/app integrations; it never removes repository
  files.
  ```

  Use links to the existing lifecycle and generated-state feature documents for deeper detail rather than duplicating implementation-specific paths throughout the README.

- [ ] **Step 4: Run README tests and Markdown lint**

  Run:

  ```sh
  pnpm exec node --import tsx --test --test-name-pattern='README documents Boxdown resource ownership|help describes available commands' __tests__/app.test.ts
  pnpm run lint:markdown
  ```

  Expected: PASS.

- [ ] **Step 5: Commit the documentation change**

  ```sh
  git add README.md __tests__/app.test.ts
  git commit -m "docs: explain Boxdown managed resources"
  ```

### Task 6: Run complete verification

**Files:**

- Verify only: `src/progress.ts`, `src/main.ts`, `README.md`, `__tests__/app.test.ts`

**Interfaces:**

- Consumes: all completed implementation tasks.
- Produces: verified setup-transparency behaviour with no changes to JSON, CI/non-TTY streaming, or proxy output routing.

- [ ] **Step 1: Run the complete automated test suite**

  Run:

  ```sh
  pnpm test
  ```

  Expected: PASS with zero failing tests.

- [ ] **Step 2: Run lint, build, and whitespace checks**

  Run:

  ```sh
  pnpm run lint
  pnpm run build
  git diff --check
  ```

  Expected: each command exits 0.

- [ ] **Step 3: Inspect the final diff against the design**

  Run:

  ```sh
  git diff dd61093..HEAD -- src/progress.ts src/main.ts README.md __tests__/app.test.ts
  ```

  Verify manually that interactive `--verbose` has no child-output mirroring, non-TTY/CI retains it, failure advice points to the log, JSON remains silent, and the README includes the complete ownership boundary.

- [ ] **Step 4: Commit any verification-only corrections**

  If verification required corrections, commit only those corrections:

  ```sh
  git add src/progress.ts src/main.ts README.md __tests__/app.test.ts
  git commit -m "test: verify setup transparency behavior"
  ```
