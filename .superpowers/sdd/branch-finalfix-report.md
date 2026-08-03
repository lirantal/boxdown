# Branch Final-Fix Report

## Outcome

Implemented the five requested branch-review remediations without changing
product documentation.

1. Post-create dependency dispatch now treats a genuinely missing toolchain
   plan as a legacy workspace, while a present invalid, corrupt, or unsafe plan
   emits a warning and suppresses legacy dependency installation. Valid empty
   and non-Node plans continue to suppress the legacy installer. The container
   validator rejects non-regular leaf files and requires the complete selected
   plan schema.
2. Non-interactive `setup` without selectors consumes repository detections,
   prints a deterministic detected-toolchains summary, and leaves the plan
   absent.
3. Explicit versions now retain a source-aware compatibility note when
   malformed or unsupported repository evidence prevents verification. Status
   output renders the persisted note.
4. Relevant quoted TOML assignments accept a standard trailing `#` comment for
   Python and Rust markers. Trailing non-comment syntax remains malformed.
   Single-quoted literal values are accepted without escape decoding; basic
   strings containing escapes remain conservatively unsupported.
5. Persisting a plan refreshes `toolchainPlanUpdatedAt` on existing metadata
   from `plan.updatedAt`; initial setup also records the same provenance when it
   creates metadata. Later lifecycle metadata creation also recovers provenance
   from a plan that predates metadata.

## TDD Evidence

The new regressions were observed failing before production edits:

- Lifecycle fixture failed because a corrupt present plan ran the legacy path
  and did not emit the safety warning.
- TOML inline-comment and explicit unchecked-evidence tests failed because the
  parser rejected comments and the resolver omitted compatibility notes.
- App tests failed because non-interactive setup omitted the detection summary,
  plan persistence omitted metadata provenance, and status omitted the Python
  override note.

After the implementation, the corresponding focused tests passed.

## Verification

- `node --import tsx --test __tests__/toolchains.test.ts`: 44/44 passed.
- Focused app/toolchain status, setup, persistence, and lifecycle tests: passed.
- `node --import tsx --test __tests__/toolchains-lifecycle.test.ts`: 1/1 passed,
  including the real shell fixture (about 109 seconds).
- Full direct app runner outside the filesystem sandbox: 367/367 passed in
  about 47 seconds on the final diff. An earlier sandboxed run had one unrelated
  `EPERM` when the
  SSH-agent proxy test tried to bind a Unix socket; the unrestricted rerun
  passed that test.
- `node_modules/.bin/tsc --noEmit`: passed.
- `node_modules/.bin/eslint .`: passed.
- Direct markdownlint invocation matching the package script: passed.
- `bash -n` for the changed post-create hook and lifecycle fixture: passed.
- `node_modules/.bin/tsdown`: passed.
- `node dist/bin/cli.cjs --help`: passed.
- Docker 29.6.2 acceptance against local image
  `boxdown-toolchains:test` (`sha256:735dd5c...`) passed with the current
  devcontainer assets bind-mounted. The lifecycle/SSH runner provisioned all
  four runtimes and exited zero under amd64-on-arm64 emulation.
- Package dry run passed with 143 entries and included the changed post-create
  asset when run as `npm pack --dry-run --json --force --ignore-scripts` with a
  temporary npm cache.

## Caveats

- Project `pnpm` commands could not start because the pnpm 11.8.0 signed
  package-manager switch attempted unavailable registry fetches and refused to
  proceed. Installed local binaries and direct Node test runners were used for
  equivalent lint, typecheck, build, and test coverage.
- Plain `npm pack --dry-run --json` is intentionally rejected by the package's
  pnpm-only `devEngines`; a first forced attempt also reached Husky's prepare
  hook and was blocked from writing the shared worktree Git config. The passing
  dry run therefore used `--ignore-scripts` and a disposable cache. Build and
  CLI smoke tests were run separately.
- The Docker acceptance reused the existing local release-image fixture rather
  than rebuilding it from the network. Current devcontainer assets, including
  the changed post-create hook, were mounted read-only into that acceptance run.

## Focused Review

An independent read-only diff review found two high-priority validation gaps
and one provenance gap before commit: FIFO/device plans could reach
`readFileSync`, reduced-schema JSON could be treated as a valid plan, and
metadata created later by container lifecycle omitted an existing plan's
timestamp. Each finding received a failing regression, a scoped fix, and a
green focused/full rerun before this report was finalized.
