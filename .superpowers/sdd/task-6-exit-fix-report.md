# Task 6 exit-fix report

## Changes

- Made the BASH_ENV/.bashrc toolchain dispatcher preserve the caller's shell
  options while exporting the Boxdown wrapper bin directory and loading runtime
  secrets.
- After a selected runtime's installation fails, remove only that runtime's
  recognized Boxdown wrappers. User-owned executables and wrappers from other
  runtimes remain untouched.
- Added lifecycle coverage for both shell-option states, secret/PATH dispatch,
  successful version A followed by failed version B, and user executable
  preservation. The app test now requires an executable `source` line rather
  than accepting a substring or comment.

## Verification

- `node --import tsx --test __tests__/toolchains-lifecycle.test.ts` — passed.
- `node --import tsx --test --test-name-pattern='mounts runtime secret state' __tests__/app.test.ts` — passed.
- `node_modules/.bin/tsc --noEmit` — passed.
- `node_modules/.bin/eslint __tests__/app.test.ts __tests__/toolchains-lifecycle.test.ts` — passed.
- `bash -n assets/devcontainer/utils/toolchains-env-bootstrap.sh assets/devcontainer/utils/toolchains-bootstrap.sh __tests__/fixtures/toolchains-lifecycle.sh` — passed.
- `git diff --check` — passed.
- Docker lifecycle check was not run: `docker info` could not access the local
  Docker daemon socket (`permission denied`).
