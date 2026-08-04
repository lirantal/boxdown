# Complete Toolchain Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Boxdown's complete supported runtime catalog during interactive setup, while preselecting only safely resolved detections and resolving manually selected undetected runtimes to pinned defaults.

**Architecture:** Keep detection and plan resolution unchanged. Build the interactive choices by joining the canonical `TOOLCHAIN_IDS` catalog with a lookup of detected evidence, using the existing detected description when present and a new Boxdown-default description when absent.

**Tech Stack:** TypeScript, Node.js test runner, ANSI terminal prompt streams, pnpm, ESLint.

## Global Constraints

- Continue supporting exactly Node.js, Python, Go, and Rust in canonical `TOOLCHAIN_IDS` order.
- Safely resolved detections start selected; incompatible and unchecked detections stay visible and unchecked.
- Undetected runtimes stay unchecked and show their exact release-pinned Boxdown default.
- Preserve `No toolchains` as the explicit empty-selection action and safe initial focus when no runtime is detected.
- Do not change plan persistence, CLI selector semantics, provisioning, non-interactive behavior, or detection depth.

---

### Task 1: Show the complete supported catalog in interactive setup

**Files:**
- Modify: `__tests__/app.test.ts:350-430`
- Modify: `src/setup-toolchains.ts:60-109`
- Modify: `docs/features/toolchains.md:56-65`

**Interfaces:**
- Consumes: `TOOLCHAIN_IDS`, `TOOLCHAIN_DEFAULTS`, `detectToolchains(workspaceFolder)`, `descriptionFor(detection)`, and `resolveToolchainPlan(options)`.
- Produces: interactive `promptMultiSelect` choices for every `ToolchainId`; persisted undetected selections retain the existing `ResolvedToolchain` shape with `resolutionSource: 'boxdown-default'`.

- [ ] **Step 1: Add the failing empty-detection picker test**

Add this test after `setup toolchain selection preselects detected runtimes and persists the choice` in `__tests__/app.test.ts`:

```ts
test('setup toolchain selection offers supported defaults when nothing is detected', async () => {
  const workspace = tempDir('setup-toolchains-supported-defaults')
  const context = createWorkspaceContext({
    workspace,
    env: {HOME: workspace, BOXDOWN_DATA_HOME: join(workspace, 'data')}
  })
  const {input, output, outputText} = fakePromptStreams()

  const resultPromise = resolveSetupToolchains({
    context,
    selectors: [],
    input,
    output,
    env: {CI: 'false'}
  })

  const initialOutput = outputText()
  assert.strictEqual((initialOutput.match(/□/g) ?? []).length, 4)
  assert.match(initialOutput, /■.*No toolchains/s)

  input.write('\u001B[A')
  input.write(' ')
  input.write('\r')
  const result = await resultPromise

  assert.deepStrictEqual(result.detected, [])
  assert.deepStrictEqual(result.plan?.selected, [{
    id: 'rust',
    version: '1.97.1',
    selectionSource: 'interactive',
    resolutionSource: 'boxdown-default',
    evidence: []
  }])
  assert.match(outputText(), /Node\.js.*Boxdown default 24\.17\.0/s)
  assert.match(outputText(), /Python.*Boxdown default 3\.14\.6/s)
  assert.match(outputText(), /Go.*Boxdown default 1\.26\.5/s)
  assert.match(outputText(), /Rust.*Boxdown default 1\.97\.1/s)
})
```

The single Up key moves focus from `No toolchains` to the last canonical choice, Rust; Space selects it and Enter confirms it. The persisted entry proves that an undetected interactive choice uses the existing pinned-default resolution path.

- [ ] **Step 2: Run the focused test and verify the regression**

Run:

```bash
node --import tsx --test --test-name-pattern='setup toolchain selection offers supported defaults' __tests__/app.test.ts
```

Expected: FAIL because the prompt contains no runtime choices, so Up still focuses `No toolchains`, the result persists an empty plan, and the four catalog assertions do not match.

- [ ] **Step 3: Build choices by joining supported IDs with detections**

In `resolveSetupToolchains`, create a detection lookup immediately before `promptMultiSelect`, then replace the detection-only `choices` mapping:

```ts
  const detectionsById = new Map(detected.map((detection) => [detection.id, detection]))
  const prompt = await promptMultiSelect({
    title: 'Select workspace toolchains?',
    choices: TOOLCHAIN_IDS.map((id) => {
      const detection = detectionsById.get(id)

      return {
        value: id,
        label: TOOLCHAIN_DEFAULTS[id].label,
        description: detection === undefined
          ? `No project markers detected; Boxdown default ${TOOLCHAIN_DEFAULTS[id].version}`
          : descriptionFor(detection)
      }
    }),
```

Keep the existing `initialValues`, `skipLabel`, prompt result handling, and plan resolution unchanged. This ensures only safely resolved detections start selected and lets `resolveToolchainPlan` supply the pinned default for an undetected selection.

- [ ] **Step 4: Run the focused toolchain prompt tests**

Run:

```bash
node --import tsx --test --test-name-pattern='setup toolchain selection' __tests__/app.test.ts
```

Expected: all matching tests PASS, including detected preselection, incompatible and unresolved detections remaining unchecked, and the new undetected-default selection.

- [ ] **Step 5: Align the user documentation**

Replace the first selection bullet in `docs/features/toolchains.md` with:

```md
- Omit selectors in an interactive `boxdown setup` to review an editable
  multi-select of every supported runtime. Compatible, fully resolved detections
  begin selected. Incompatible or unchecked detections and runtimes without
  project markers remain visible but unchecked; undetected runtimes show the
  exact Boxdown default used when selected. Setup requires you to confirm the
  final selection. Choosing `No toolchains` writes an explicit empty plan.
```

- [ ] **Step 6: Run full verification**

Run:

```bash
pnpm test
pnpm lint
pnpm build
git diff --check
```

Expected: the complete test suite passes, lint reports no errors, the TypeScript and package builds succeed, and `git diff --check` prints no output.

- [ ] **Step 7: Commit the implementation**

```bash
git add src/setup-toolchains.ts __tests__/app.test.ts docs/features/toolchains.md
git commit -m "fix: show supported toolchains during setup"
```
