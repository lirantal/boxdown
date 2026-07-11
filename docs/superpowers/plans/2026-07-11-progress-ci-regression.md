# Progress CI Regression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore CI by making progress checklist cleanup mode-independent and updating stale spinner-label source assertions.

**Architecture:** Preserve the existing `ProgressReporter` API and output behavior. Move only internal cleanup ahead of rendering guards, then loosen two source-presence assertions while leaving runtime checklist-output coverage intact.

**Tech Stack:** TypeScript, Node.js 24 test runner, `node:assert`, pnpm, ESLint, tsdown

## Global Constraints

- Do not change progress APIs, spinner copy, output formatting, or command flow.
- Use Node.js 24 for tests because the current Node.js 26 host runtime is incompatible with an installed CommonJS test dependency.
- Commit documentation separately from the implementation, as explicitly requested.

---

### Task 1: Commit the approved documentation

**Files:**

- Create: `docs/superpowers/specs/2026-07-11-progress-ci-regression-design.md`
- Create: `docs/superpowers/plans/2026-07-11-progress-ci-regression.md`

**Interfaces:**

- Consumes: The user-approved diagnosis and design.
- Produces: Durable design and execution context for the CI fix.

- [ ] **Step 1: Verify documentation formatting**

Run:

```bash
git diff --check
fnm exec --using v24.15.0 node ../../node_modules/markdownlint-cli/markdownlint.js \
  -c .github/.markdownlint.yml -i 'apm_modules/**' -i '.git' -i '__tests__' \
  -i '.github' -i '.changeset' -i 'CODE_OF_CONDUCT.md' -i 'CHANGELOG.md' \
  -i 'node_modules' -i 'dist' '**/**.md'
```

Expected: PASS with no whitespace or Markdown lint errors.

- [ ] **Step 2: Commit documentation only**

```bash
git add docs/superpowers/specs/2026-07-11-progress-ci-regression-design.md docs/superpowers/plans/2026-07-11-progress-ci-regression.md
git commit -m "docs: design progress CI regression fix"
```

Expected: A commit containing only the design specification and implementation plan.

### Task 2: Fix progress cleanup and stale assertions

**Files:**

- Modify: `src/progress.ts:147`
- Test: `__tests__/app.test.ts:3080`
- Test: `__tests__/app.test.ts:3427`

**Interfaces:**

- Consumes: `ProgressReporter.end()` and `ProgressReporter.isChecklistActive()`.
- Produces: Mode-independent reporter cleanup without API changes.

- [ ] **Step 1: Verify the existing tests reproduce both CI failures**

Run:

```bash
fnm exec --using v24.15.0 node --import tsx --test \
  --test-name-pattern='reports whether a checklist is active|hidden command helpers use friendly spinner labels' \
  __tests__/app.test.ts
```

Expected: FAIL because checklist state remains active in `none` mode and the SSH label regular expressions require an outdated direct-property expression.

- [ ] **Step 2: Make cleanup independent of rendering mode**

In `ProgressReporter.end()`, clear internal state immediately after stopping timers:

```ts
this.#steps = []
this.#renderedStepLineCount = 0
```

Remove the existing duplicate cleanup after the interactive section terminator.

- [ ] **Step 3: Make the source-presence assertions expression-shape independent**

Replace the two SSH assertions with:

```ts
assert.match(sshKeySource, /Generating Boxdown SSH identity/)
assert.match(sshKeySource, /Writing Boxdown SSH public key/)
```

- [ ] **Step 4: Verify the focused regression tests pass**

Run the Step 1 command again.

Expected: PASS for both selected tests.

- [ ] **Step 5: Run full verification**

Run:

```bash
fnm exec --using v24.15.0 node ../../node_modules/c8/bin/c8.js node --import tsx --test __tests__/**/*.test.ts
fnm exec --using v24.15.0 node ../../node_modules/eslint/bin/eslint.js .
fnm exec --using v24.15.0 node ../../node_modules/typescript/bin/tsc
fnm exec --using v24.15.0 node ../../node_modules/tsdown/dist/run.mjs
```

Expected: All tests pass, ESLint reports no errors, TypeScript compilation succeeds, and tsdown builds successfully.

- [ ] **Step 6: Commit the implementation separately**

```bash
git add src/progress.ts __tests__/app.test.ts
git commit -m "fix(progress): clear checklist state in every mode"
```

Expected: A second commit containing only the production fix and updated assertions.
