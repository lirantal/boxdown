# Branch Exit-Fix Report

## Outcome

Implemented the three requested final exit-review remediations without changing
product documentation.

1. The post-start retry validator now classifies the plan and result leaves
   with `lstat` and accepts only regular, non-symlink files no larger than 64
   KiB before any content read. Missing plans retain their legacy no-bootstrap
   result; unsafe, invalid, or special plan/result leaves request bootstrap and
   return without blocking.
2. Explicit `setup --toolchain` selection now prints a deterministic persisted
   selection summary. Each entry includes the runtime label, version, and
   selection/resolution source, followed by any conflict or cannot-verify
   compatibility note.
3. Root marker detection now resolves candidates beneath the workspace root
   and reads only regular, non-symlink files bounded to 1 MiB. Symlinks,
   directories, FIFOs and oversized inputs become diagnostics without content
   reads; true `ENOENT` remains ordinary absence and other lstat/read failures
   remain diagnostic.

## TDD Evidence

The new regressions were observed failing before production edits:

- The lifecycle fixture killed the post-start validator after it blocked on a
  FIFO plan and reported `FIFO plan skipped retry`.
- The detection suite followed a regular-file symlink, accepted an oversized
  marker, and timed out after three seconds trying to read a FIFO marker.
- The explicit-selector setup test persisted the intended Python and Go
  overrides but stdout contained no selected-toolchains summary.

After the scoped implementation, the focused checks passed:

- `node --import tsx --test __tests__/toolchains.test.ts`: 46/46 passed; the
  FIFO child completed in about 0.25 seconds on the focused run.
- Explicit-selector setup test: 1/1 passed, including incompatible Python and
  cannot-verify Go notes.
- `node --import tsx --test __tests__/toolchains-lifecycle.test.ts`: 1/1
  passed in about 113 seconds, including FIFO plan and result leaves.

## Verification

- Full direct suite: 511/512 passed in the filesystem sandbox. The only
  failure was the known unrelated `EPERM` when the SSH-agent proxy test tried
  to bind a Unix socket. The identical focused test passed 1/1 with approved
  unrestricted socket access, providing passing evidence for all 512 tests.
- `node_modules/.bin/eslint .`: passed.
- `node_modules/.bin/tsc --noEmit`: passed.
- `bash -n assets/devcontainer/hooks/post-start.sh
  __tests__/fixtures/toolchains-lifecycle.sh`: passed.
- `node_modules/.bin/tsdown`: passed.
- `node dist/bin/cli.cjs --help`: passed.
- `git diff --check`: passed before the final report.
- Docker 29.6.2 acceptance passed against existing local image
  `boxdown-toolchains:test`
  (`sha256:735dd5c2504fd7153892b6e695f1792ce1270e849ca64722c90c473a0e739d92`)
  with the current `assets/devcontainer` mounted read-only. The amd64 image ran
  under arm64 emulation, provisioned Node 24.17.0, Python 3.14.6, Go 1.26.5,
  Rust 1.97.1, and completed the remapped-node lifecycle with exit code 0.

## Scope

Changed only the post-start validator, toolchain detector/setup rendering, and
their tests/fixture. No setup-output documentation update was needed because
the existing documentation already describes explicit selection and override
semantics; this change makes the command output honor that contract.
