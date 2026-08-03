# Task 6 Production Fix Report

## Scope

This focused pass closes the final production-path gaps in Task 6 without
starting Task 7 or changing user documentation.

- A persisted plan is now mounted whenever it exists, including an explicit
  `selected: []` plan. The plan directory remains read-only and the result
  directory remains read-write.
- Existing containers with any persisted plan now require recreation when
  either generated mount intent is absent or invalid. Status reports an empty
  plan as disabled only after an existing container has valid plan and result
  mounts.
- Legacy dependency failures now return zero explicitly in non-strict mode.
  Selected-Node synchronization still uses strict mode, returns nonzero to the
  bootstrap adapter, records a retryable failed runtime result, and leaves the
  lifecycle command nonfatal.
- Boxdown places its dispatcher and wrapper `PATH` export before the standard
  Debian noninteractive `.bashrc` return. The dispatcher remains on the
  read-only Dev Container asset mount, sources the runtime-secret bootstrap,
  and reads only the validated user-owned toolchain environment file.
- The image lifecycle smoke now has an executable host mode that uses the same
  Docker-backed `sshd -i` ProxyCommand shape as Boxdown. It validates a real
  `ssh ... node --version` command session rather than a `BASH_ENV` simulation.

## Root causes and TDD evidence

The regression tests were added before their production fixes.

1. Generated configuration filtered plans with `selected.length === 0`, so an
   explicit none plan was persisted on the host but invisible in the
   container. The new app tests failed on both missing mounts and recreation
   intent; status also incorrectly returned `disabled` before checking mounts.
2. `deps-install.sh` ended its failure branch with a false strict-mode test.
   In non-strict mode that status escaped `main`, and the new direct fixture
   failed with `legacy non-strict dependency failure returned nonzero`.
3. Toolchain `PATH` setup was appended after the default noninteractive
   `.bashrc` guard. The new fixture failed until the read-only dispatcher and
   path export were atomically placed before that guard while retaining the
   user's remaining `.bashrc` content.
4. The generated-config test still expected the secret bootstrap itself as
   `BASH_ENV`. It now expects the read-only toolchain dispatcher and verifies
   that the dispatcher sources the secret bootstrap.

The green executable lifecycle fixture covers direct strict/non-strict exits,
post-create legacy suppression, selected-Node retry results, empty and non-Node
plans, exact wrapper ownership, secure modes, and symlink refusal.

## Verification

The following checks completed with exit code 0 after the final changes:

```sh
node --import tsx --test --test-name-pattern='toolchain|runtime secret state' __tests__/app.test.ts
# 15 tests, 15 passed

node --import tsx --test --test-name-pattern='explicit none plan is missing' __tests__/app.test.ts
# 1 test, 1 passed

node --import tsx --test __tests__/toolchains-lifecycle.test.ts
# 1 test, 1 passed

node --import tsx --test __tests__/image-input-policy.test.ts
# 31 tests, 31 passed

node_modules/.bin/eslint src/config.ts src/devcontainer.ts src/status.ts \
  __tests__/app.test.ts __tests__/toolchains-lifecycle.test.ts \
  __tests__/image-input-policy.test.ts
node_modules/.bin/tsc --noEmit
bash -n assets/devcontainer/utils/toolchains-bootstrap.sh \
  assets/devcontainer/utils/toolchains-env-bootstrap.sh \
  assets/devcontainer/utils/deps-install.sh \
  assets/devcontainer/hooks/post-create.sh \
  assets/devcontainer/hooks/post-start.sh \
  assets/image/lifecycle-smoke-test.sh \
  __tests__/fixtures/toolchains-lifecycle.sh
git diff --check
```

The real AMD64 image checks also completed with exit code 0:

```sh
docker buildx build --platform linux/amd64 --load \
  -f assets/image/Dockerfile -t boxdown-toolchains:test .

docker run --rm --user root \
  --mount type=bind,source="$PWD/assets/devcontainer",target=/opt/boxdown/devcontainer,readonly \
  boxdown-toolchains:test \
  /opt/boxdown/image-tools/lifecycle-smoke-test.sh --remap-node

bash assets/image/lifecycle-smoke-test.sh --ssh-proxy-host \
  boxdown-toolchains:test "$PWD/assets/devcontainer"
# ssh proxy toolchain smoke: ok
```

The remapped lifecycle smoke provisioned Node.js 24.17.0, Python 3.14.6,
uv 0.11.32, Go 1.26.5, and Rust 1.97.1 before completing its strict dependency,
result, hook, and empty-plan assertions. The host SSH smoke verified that a
real noninteractive proxy session resolves `node` to
`/home/node/.local/bin/node`, returns `v24.17.0`, receives the mounted secret
environment, cannot write the dispatcher, and writes `succeeded` with zero
runtime records after the same production-mounted plan is changed to
`selected: []`.

`pnpm` remains unavailable in this environment because Corepack refuses the
project's pnpm 11.8.0 after registry-signature verification fetches fail. The
repository-local Node/tsx, ESLint, and TypeScript binaries were used directly.
