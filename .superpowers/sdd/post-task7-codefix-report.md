# Post-Task 7 Code Fix Report

## Scope

This remediation changes code, tests, and the lifecycle behavior fixture only.
It intentionally does not add product documentation or a changeset.

## Root Causes and Changes

### Setup selection safety

- Interactive setup previously passed every detection as an initial selection,
  including incompatible constraints and unresolved diagnostic results. Initial
  selections now include only detections whose version resolution is
  `resolved`; incompatible and unresolved choices remain visible and unchecked.
- A bare runtime selector previously fell through to the Boxdown default even
  when a detected repository declaration was incompatible or unresolved. Bare
  selectors now fail with an actionable `runtime@<version>` instruction in
  those cases. A runtime without any repository declaration still uses the
  release-pinned Boxdown default, and an explicit version remains an override.

### Lifecycle wrapper ownership

- The production ownership matcher already accepted and removed the complete
  production wrapper shape while preserving marker-bearing user wrappers that
  execute a different binary.
- The fixture globally replaced `/usr/local/bin/mise`, which also rewrote the
  ownership matcher's expected path. It then changed only some generated
  wrappers back to the production path, so the fixture matcher rejected real
  production-shaped wrappers and reported them as stale.
- The fixture now substitutes the fake mise binary only at bootstrap invocation
  sites. Generated wrappers and the ownership matcher retain their exact
  production shape. The failed-version-change scenario removes stale Boxdown
  `node`, `npm`, and `npx` wrappers while preserving the adversarial user
  `corepack` wrapper.

### Task 3 app expectations

- Interactive setup tests now consume the toolchain prompt before the older
  target/profile prompts and assert that an explicitly dismissed prompt leaves
  an empty stored plan even if a later prompt is cancelled.
- Direct lifecycle tests seed an explicit empty plan under the same injected
  environment used by `runCli`.
- Direct coding-agent launch now rejects an unconfigured workspace before
  container lifecycle, matching direct `start` and preventing the former loop
  order from hiding the missing guard.

## TDD Evidence

- The new incompatible/unresolved setup tests first failed with all three
  detections selected and with a bare incompatible selector returning a plan.
  They passed after filtering initial selections and rejecting unsafe automatic
  resolution.
- The absolute lifecycle fixture first failed with `failed runtime install
  retained stale Boxdown-owned wrappers`. It passed after narrowing the fixture
  substitution.
- The coding-agent absent-plan regression first failed with exit code `0`
  instead of `1`. It passed after extending the stored-plan guard.
- The 11 stale Task 3 app cases were reproduced before their prompt and plan
  setup was updated; the resulting focused set, including the new regression,
  passes 12 of 12 tests.

## Verification

- PASS: `node --import tsx --test __tests__/toolchains.test.ts` — 41 of 41.
- PASS: absolute invocation of
  `__tests__/fixtures/toolchains-lifecycle.sh` with the absolute devcontainer
  asset path and Node path — final output `toolchains lifecycle fixture: ok`.
- PASS: focused app regression selection — 12 of 12.
- PASS: `./node_modules/.bin/eslint .`.
- PASS: `./node_modules/.bin/tsc --noEmit`.
- PASS: `./node_modules/.bin/tsc && ./node_modules/.bin/tsdown`.
- PASS: Bash syntax checks for the lifecycle fixture and production bootstrap.
- PASS: `git diff --check` before the report was added.
- EXPECTED SANDBOX FAILURE: `node --import tsx --test __tests__/app.test.ts`
  passes 363 of 364 tests. The sole failure is the existing SSH-agent proxy test
  receiving `listen EPERM` while binding its Unix socket under `/tmp`.
- EXPECTED SANDBOX FAILURE: the direct repository-wide Node runner reaches only
  the same SSH-agent proxy test/suite failure; the toolchain lifecycle test and
  every other test pass.

The local pnpm shim attempted an unavailable registry signature lookup, so
static checks and builds used the repository's already-installed binaries
directly instead of downloading or switching package-manager versions.

## Review

An independent read-only review found that two mixed command matrices initially
seeded plans too broadly, which could have hidden absent-plan regressions in
unaffected lifecycle commands. The fixtures were narrowed to direct `start`,
`shell`, and coding-agent commands. The affected matrices, ESLint, TypeScript,
and the diff check passed after that change, and re-review returned no Critical
or Important findings with a ready verdict.
