# Architecture-Aware 1Password Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the pinned prebuilt 1Password CLI archive for the current Linux architecture and exercise amd64, arm64, and unsupported paths in CI.

**Architecture:** Keep architecture selection inside the existing `install_1password_cli` shell function. Behavioral Node tests source the hook and replace only external commands, so CI runs the real selection logic without network access, privileged writes, Buildx, QEMU, or source builds.

**Tech Stack:** Bash, Node.js test runner, TypeScript, `node:assert`, pnpm

## Global Constraints

- Keep 1Password CLI pinned to version `2.32.1`.
- Fetch the prebuilt Linux zip; do not build 1Password from source.
- Support `x86_64|amd64` with the `amd64` archive and `aarch64|arm64` with the `arm64` archive.
- Warn and return successfully without downloading on unsupported architectures.
- Do not change the CI runner matrix, Snyk installer, devcontainer image, or unrelated lifecycle behavior.

---

### Task 1: Select and Test the 1Password Archive Architecture

**Files:**

- Modify: `assets/devcontainer/hooks/post-create.sh:112-117`
- Test: `__tests__/app.test.ts` near the existing post-create hook tests

**Interfaces:**

- Consumes: `install_1password_cli()` and the machine name returned by `uname -m`.
- Produces: A download request for `op_linux_<amd64|arm64>_v2.32.1.zip`, or a successful warning-only skip for an unsupported machine name.

- [ ] **Step 1: Add a shell smoke-test helper and failing architecture tests**

Add this helper near the existing `tempDir` test helper:

```ts
function runOnePasswordInstallForArchitecture (arch: string): { status: number | null, stderr: string, downloads: string } {
  const postCreatePath = join(assetsDevcontainerDir, 'hooks', 'post-create.sh')
  const curlLogPath = join(tempDir('onepassword-curl-log'), 'calls.log')
  const script = [
    'source "$1"',
    'uname() { printf "%s\\n" "$BOXDOWN_TEST_ARCH"; }',
    'curl() { printf "%s\\n" "$*" >> "$BOXDOWN_TEST_CURL_LOG"; }',
    'python3() { :; }',
    'sudo() { :; }',
    'chmod() { :; }',
    'rm() { :; }',
    'install_1password_cli'
  ].join('\n')
  const result = spawnSync('bash', ['-c', script, 'bash', postCreatePath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BOXDOWN_TEST_ARCH: arch,
      BOXDOWN_TEST_CURL_LOG: curlLogPath
    }
  })

  return {
    status: result.status,
    stderr: result.stderr,
    downloads: existsSync(curlLogPath) ? readFileSync(curlLogPath, 'utf8') : ''
  }
}
```

Add these focused tests near `post-create local git config is idempotent with multiple GitHub helpers`:

```ts
test('1Password installer selects the amd64 archive on x86_64', () => {
  const result = runOnePasswordInstallForArchitecture('x86_64')

  assert.strictEqual(result.status, 0)
  assert.match(result.downloads, /op_linux_amd64_v2\.32\.1\.zip/)
  assert.doesNotMatch(result.downloads, /op_linux_arm64/)
})

test('1Password installer selects the arm64 archive on aarch64', () => {
  const result = runOnePasswordInstallForArchitecture('aarch64')

  assert.strictEqual(result.status, 0)
  assert.match(result.downloads, /op_linux_arm64_v2\.32\.1\.zip/)
  assert.doesNotMatch(result.downloads, /op_linux_amd64/)
})

test('1Password installer skips unsupported architectures', () => {
  const result = runOnePasswordInstallForArchitecture('riscv64')

  assert.strictEqual(result.status, 0)
  assert.strictEqual(result.downloads, '')
  assert.match(result.stderr, /skipping 1Password CLI \(unsupported arch: riscv64\)/)
})
```

- [ ] **Step 2: Run the focused tests and verify the red phase**

Run:

```bash
pnpm exec c8 --clean=false node --import tsx --test \
  --test-name-pattern='1Password installer' __tests__/app.test.ts
```

Expected: FAIL. The amd64 test records the hard-coded arm64 URL, and the unsupported-architecture test records a download instead of a warning-only skip. The existing arm64 behavior may already pass.

- [ ] **Step 3: Implement architecture-aware archive selection**

Replace `install_1password_cli` with:

```bash
install_1password_cli() {
  local op_version="2.32.1"
  local op_arch

  case "$(uname -m)" in
    aarch64 | arm64) op_arch="arm64" ;;
    x86_64 | amd64) op_arch="amd64" ;;
    *)
      echo "post-create: skipping 1Password CLI (unsupported arch: $(uname -m))" >&2
      return 0
      ;;
  esac

  curl -fsSL "https://cache.agilebits.com/dist/1P/op2/pkg/v${op_version}/op_linux_${op_arch}_v${op_version}.zip" -o /tmp/op.zip
  python3 -c "import zipfile; zipfile.ZipFile('/tmp/op.zip').extract('op', '/tmp')"
  sudo mv /tmp/op /usr/local/bin/op && chmod +x /usr/local/bin/op && rm /tmp/op.zip
}
```

- [ ] **Step 4: Rerun the focused tests and shell syntax check**

Run:

```bash
pnpm exec c8 --clean=false node --import tsx --test \
  --test-name-pattern='1Password installer' __tests__/app.test.ts
bash -n assets/devcontainer/hooks/post-create.sh
```

Expected: All three focused tests pass and Bash reports no syntax errors.

- [ ] **Step 5: Run full repository verification**

Run:

```bash
pnpm run test
pnpm run lint
pnpm run build
git diff --check
```

Expected: The full test suite, lint, and build pass; the diff check produces no output.

- [ ] **Step 6: Commit the implementation**

```bash
git add assets/devcontainer/hooks/post-create.sh __tests__/app.test.ts
git commit -m "fix: select 1password installer architecture"
```

Expected: One implementation commit containing the architecture selector and its behavioral smoke tests.
