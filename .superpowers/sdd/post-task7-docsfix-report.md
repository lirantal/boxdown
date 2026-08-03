# Post-Task 7 Documentation Alignment Report

## Scope

This remediation updates documentation only after `5fbc651`. It does not
change product code, tests, or the release changeset.

## Corrections

- The host-visible result file is now documented at
  `toolchains/result/result.json`. The container-visible plan and result files
  are `/opt/boxdown/state/toolchains/plan/plan.json` and
  `/opt/boxdown/state/toolchain-results/result.json`, respectively.
- Detection documentation no longer describes a first-wins exact-source
  precedence. Repeated or conflicting exact declarations and constraints are
  documented as diagnostics that remain unresolved.
- Interactive setup documentation now says that only safely resolved detections
  start selected. Incompatible or unchecked declarations stay visible but
  unchecked, and a bare runtime selector must use an explicit version in those
  cases.
- Examples use explicit versions for direct runtime selection.
- Status documentation now matches `toolchainContainerState`: a non-empty plan
  is `active` when no container exists, and for an existing container only when
  generated configuration records both toolchain mounts and the result
  fingerprint matches. Empty plans, absent plans, missing mounts, absent or
  stale results, and failed matching results are described according to the
  implementation's ordering.

## Verification

- PASS: `./node_modules/.bin/markdownlint -c .github/.markdownlint.yml README.md docs/architecture.md docs/features/toolchains.md docs/features/generated-config-and-state.md`
- PASS: `node --import tsx --test __tests__/toolchains.test.ts` — 41 passing.
- PASS: `git diff --check`.
