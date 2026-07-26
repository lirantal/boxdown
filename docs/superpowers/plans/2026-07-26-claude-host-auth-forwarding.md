# Claude Code Host Authentication Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse a supported host Claude Code credential inside Boxdown containers so authentication survives container removal without copying credentials into Boxdown state.

**Architecture:** `src/paths.ts` resolves only the documented file-backed host credential path for Linux/WSL and native Windows; macOS and other platforms resolve to no mountable path. `src/config.ts` adds a writable, single-file bind mount when that path exists and does not conflict with a user-provided mount. `src/status.ts` exposes availability rather than claiming an existing container has a mount, while the published image supplies the target parent directory. The Dev Containers CLI synchronizes the remote UID/GID so Linux/WSL owner-only credential files are usable by `node`, accepting a local create-time cost.

**Tech Stack:** TypeScript, Node.js built-in test runner, Dockerfile, Markdown documentation.

## Global Constraints

- Never read, copy, log, or store Claude credential contents in Boxdown state.
- Mount only the documented credential file; never mount host `~/.claude` or `~/.claude.json`.
- Linux/WSL and native Windows use file-backed credential discovery; macOS is explicitly unsupported because Claude Code uses Keychain there.
- Other host platforms are unsupported unless Boxdown has a documented file-backed Claude credential path.
- The Claude credential mount is writable because Claude Code updates it during `/login`, `/logout`, and token refresh.
- Enable `updateRemoteUserUID` so owner-only Linux/WSL credential files remain usable by the remote user; document the resulting create-time tradeoff.
- A missing host credential is non-fatal and must provide host-login plus `--recreate` guidance.
- `docker rm`, `boxdown down`, and `boxdown purge` must never remove host Claude credentials.
- Keep existing custom devcontainer mounts authoritative when they target the Claude directory or credential file.
- Follow TDD: every production-code change begins with a focused failing test and is verified green before the next task.

---

### Task 1: Resolve and Mount Supported Host Claude Credentials

**Files:**
- Modify: `src/constants.ts`
- Modify: `src/paths.ts`
- Modify: `src/config.ts`
- Modify: `__tests__/app.test.ts`

**Interfaces:**
- Produces `BOXDOWN_CONTAINER_CLAUDE_DIR = '/home/node/.claude'` and `BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH = '/home/node/.claude/.credentials.json'` from `src/constants.ts`.
- Produces `defaultHostClaudeCredentialsPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string | undefined` from `src/paths.ts`.
- Adds `hostClaudeCredentialsPath?: string` to `WorkspaceContext`; it is `undefined` on macOS and a candidate path on Linux/WSL or Windows.
- Consumes `context.hostClaudeCredentialsPath` in `buildGeneratedDevcontainerConfig()` to add the writable credential bind mount.

- [ ] **Step 1: Write the failing path-resolution and mount-generation tests**

  In `__tests__/app.test.ts`, import `defaultHostClaudeCredentialsPath` and the two new Claude container constants. Add a `describe('Claude Code host credentials', ...)` section before `describe('devcontainer config generation', ...)` with these focused tests:

  ```ts
  test('resolves documented Claude credential paths by platform', () => {
    assert.strictEqual(
      defaultHostClaudeCredentialsPath({ HOME: '/home/alice' }, 'linux'),
      '/home/alice/.claude/.credentials.json'
    )
    assert.strictEqual(
      defaultHostClaudeCredentialsPath({ USERPROFILE: 'C:\\Users\\Alice' }, 'win32'),
      'C:\\Users\\Alice\\.claude.credentials.json'
    )
    assert.strictEqual(
      defaultHostClaudeCredentialsPath({ CLAUDE_CONFIG_DIR: '/secure/claude' }, 'linux'),
      '/secure/claude/.credentials.json'
    )
    assert.strictEqual(defaultHostClaudeCredentialsPath({ HOME: '/Users/alice' }, 'darwin'), undefined)
  })

  test('mounts a present host Claude credential file read-write', () => {
    const home = tempDir('claude-auth-home')
    const credentialsDir = join(home, '.claude')
    const credentialsPath = join(credentialsDir, '.credentials.json')
    mkdirSync(credentialsDir)
    writeFileSync(credentialsPath, '{}\n')
    const context = createWorkspaceContext({
      workspace: tempDir('claude-auth-workspace'),
      env: { HOME: home, BOXDOWN_CACHE_HOME: tempDir('claude-auth-cache'), BOXDOWN_DATA_HOME: tempDir('claude-auth-data') },
      assetsDevcontainerDir
    })

    const config = buildGeneratedDevcontainerConfig(context)

    assert.strictEqual(context.hostClaudeCredentialsPath, credentialsPath)
    assert.ok(config.mounts?.includes(
      `type=bind,source=${credentialsPath},target=${BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH}`
    ))
    assert.ok(!config.mounts?.some((mount) => mount.includes(`target=${BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH},readonly`)))
  })
  ```

  Add a third test that creates no credential file and asserts no mount targets `BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH`. Add a fourth test that supplies custom assets with either `target=${BOXDOWN_CONTAINER_CLAUDE_DIR}` or `target=${BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH}` and asserts the original mount is preserved without Boxdown adding its mount.

- [ ] **Step 2: Run the new tests to verify they fail**

  Run:

  ```sh
  node --import tsx --test --test-name-pattern='Claude Code host credentials' __tests__/app.test.ts
  ```

  Expected: FAIL because `defaultHostClaudeCredentialsPath`, the Claude constants, and `WorkspaceContext.hostClaudeCredentialsPath` do not exist.

- [ ] **Step 3: Add the minimal credential-path and generated-mount implementation**

  In `src/constants.ts`, add:

  ```ts
  export const BOXDOWN_CONTAINER_CLAUDE_DIR = '/home/node/.claude'
  export const BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH = `${BOXDOWN_CONTAINER_CLAUDE_DIR}/.credentials.json`
  ```

  In `src/paths.ts`, import `win32` from `node:path`, add the resolver, and call it from `createWorkspaceContextFromIdentity()`:

  ```ts
  export function defaultHostClaudeCredentialsPath (
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
  ): string | undefined {
    if (platform === 'darwin') return undefined

    const pathJoin = platform === 'win32' ? win32.join : join

    if (env.CLAUDE_CONFIG_DIR) {
      return pathJoin(env.CLAUDE_CONFIG_DIR, '.credentials.json')
    }

    const home = platform === 'win32'
      ? env.USERPROFILE ?? env.HOME ?? homedir()
      : env.HOME ?? homedir()

    return platform === 'win32'
      ? pathJoin(home, '.claude.credentials.json')
      : pathJoin(home, '.claude', '.credentials.json')
  }
  ```

  Add `hostClaudeCredentialsPath?: string` to `WorkspaceContext` and set it to the resolver result. Do not read the file in `paths.ts`.

  In `src/config.ts`, import the two Claude constants. After the Codex auth mount block, add the read/write file mount only when all conditions hold:

  ```ts
  if (
    context.hostClaudeCredentialsPath !== undefined &&
    fileExists(context.hostClaudeCredentialsPath) &&
    !hasMountTarget(mounts, BOXDOWN_CONTAINER_CLAUDE_DIR) &&
    !hasMountTarget(mounts, BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH)
  ) {
    boxdownMounts.push(
      `type=bind,source=${context.hostClaudeCredentialsPath},target=${BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH}`
    )
  }
  ```

  Use existing `fileExists()` so directories, absent paths, and special files are not mounted. Do not add `readonly`.

- [ ] **Step 4: Run the focused tests to verify they pass**

  Run:

  ```sh
  node --import tsx --test --test-name-pattern='Claude Code host credentials|Codex auth cache' __tests__/app.test.ts
  ```

  Expected: PASS, including the pre-existing Codex mount tests.

- [ ] **Step 5: Commit the credential mount slice**

  ```sh
  git add src/constants.ts src/paths.ts src/config.ts __tests__/app.test.ts
  git commit -m "feat: forward host Claude credentials"
  ```

### Task 2: Prepare the Published Image for the Single-File Mount

**Files:**
- Modify: `assets/image/Dockerfile`
- Modify: `__tests__/image-input-policy.test.ts`

**Interfaces:**
- Consumes `BOXDOWN_CONTAINER_CLAUDE_CREDENTIALS_PATH` only as the target contract established in Task 1.
- Produces a `node`-owned `/home/node/.claude` directory in every newly built Boxdown image.

- [ ] **Step 1: Write the failing image-policy test**

  In `__tests__/image-input-policy.test.ts`, add:

  ```ts
  test('creates the Claude credential mount parent for the node user', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8')

    assert.match(
      dockerfile,
      /install -d -m 0700 -o node -g node \/home\/node\/\.claude/
    )
  })
  ```

- [ ] **Step 2: Run the new test to verify it fails**

  Run:

  ```sh
  node --import tsx --test --test-name-pattern='Claude credential mount parent' __tests__/image-input-policy.test.ts
  ```

  Expected: FAIL because the Dockerfile does not create `/home/node/.claude`.

- [ ] **Step 3: Create the directory in the published image**

  In `assets/image/Dockerfile`, while the active user is `root`, add a dedicated instruction before the final `USER node`:

  ```dockerfile
  RUN install -d -m 0700 -o node -g node /home/node/.claude
  ```

  Do not add a credential file to the image.

- [ ] **Step 4: Run the focused image-policy test to verify it passes**

  Run:

  ```sh
  node --import tsx --test --test-name-pattern='Claude credential mount parent' __tests__/image-input-policy.test.ts
  ```

  Expected: PASS.

- [ ] **Step 5: Commit the image-preparation slice**

  ```sh
  git add assets/image/Dockerfile __tests__/image-input-policy.test.ts
  git commit -m "feat: prepare Claude credential mount target"
  ```

### Task 3: Surface Claude Authentication State in Status

**Files:**
- Modify: `src/status.ts`
- Modify: `__tests__/app.test.ts`

**Interfaces:**
- Consumes `WorkspaceContext.hostClaudeCredentialsPath` from Task 1, the existing injectable `exists(path)` callback, and a new injectable `isFile(path)` callback.
- Produces `ClaudeCredentialsState = 'available' | 'missing' | 'unsupported'` and `StatusInfo.claude.credentials` for both text and JSON status output.
- Does not change `statusIsHealthy()`; host Claude auth is optional and must not make a healthy devcontainer unhealthy.

- [ ] **Step 1: Write the failing status tests**

  Extend `formats status for running and absent containers` in `__tests__/app.test.ts` with a platform-independent Linux-style fixture. Pass `isFile: (path) => path === context.hostClaudeCredentialsPath` through `createStatusInfo()` and assert:

  ```ts
  const baseContext = createWorkspaceContext({
    workspace,
    env: { BOXDOWN_CACHE_HOME: tempDir('status-cache'), BOXDOWN_DATA_HOME: tempDir('status-data') },
    assetsDevcontainerDir
  })
  const context = {
    ...baseContext,
    claudeCredentialsSupport: 'file',
    hostClaudeCredentialsPath: '/home/demo/.claude/.credentials.json'
  }

  assert.deepStrictEqual(running.claude.credentials, {
    state: 'available',
    path: context.hostClaudeCredentialsPath
  })
  assert.match(formatStatusText(running), /Claude credentials: .* \(available on host; host-owned\)/)
  ```

  Add a focused test with the same Linux context but an `exists` function that excludes `context.hostClaudeCredentialsPath`; assert:

  ```ts
  assert.deepStrictEqual(status.claude.credentials, {
    state: 'missing',
    path: context.hostClaudeCredentialsPath
  })
  assert.match(formatStatusText(status), /Run Claude Code and \/login on the host, then recreate the devcontainer\./)
  ```

  Add an unsupported fixture using the same spread pattern and assert the full result:

  ```ts
  const macContext = { ...baseContext, claudeCredentialsSupport: 'macos-keychain', hostClaudeCredentialsPath: undefined }
  const unsupported = createStatusInfo(macContext, 'demo-devcontainer', undefined, () => false, { sshConfigPath })

  assert.deepStrictEqual(unsupported.claude.credentials, { state: 'unsupported', reason: 'macos-keychain' })
  assert.match(formatStatusText(unsupported), /macOS Keychain credentials are not automatically forwarded/)
  ```

- [ ] **Step 2: Run the new status tests to verify they fail**

  Run:

  ```sh
  node --import tsx --test --test-name-pattern='formats status for running and absent containers|Claude credential status' __tests__/app.test.ts
  ```

  Expected: FAIL because `StatusInfo` has no `claude` field.

- [ ] **Step 3: Add the optional Claude credentials status model and formatter**

  In `src/status.ts`, define:

  ```ts
  export type ClaudeCredentialsState = 'available' | 'missing' | 'unsupported'

  export interface ClaudeCredentialsStatus {
    state: ClaudeCredentialsState
    path?: string
    reason?: 'macos-keychain' | 'unsupported-platform'
  }
  ```

  Add this property to `StatusInfo`:

  ```ts
  claude: {
    credentials: ClaudeCredentialsStatus
  }
  ```

  Import `statSync` from `node:fs`. Extend `createStatusInfo()` options with `isFile?: (path: string) => boolean`; default it to a private helper that returns `statSync(path).isFile()` and returns `false` for missing or unreadable paths. Add a private credential-status helper:

  ```ts
  function inspectClaudeCredentialsStatus (
    context: WorkspaceContext,
    isFile: (path: string) => boolean
  ): ClaudeCredentialsStatus {
    if (context.claudeCredentialsSupport !== 'file') {
      return { state: 'unsupported', reason: context.claudeCredentialsSupport }
    }

    return {
      state: isFile(context.hostClaudeCredentialsPath) ? 'available' : 'missing',
      path: context.hostClaudeCredentialsPath
    }
  }
  ```

  Use the injected/default `isFile` callback in `createStatusInfo()`. In `formatStatusText()`, insert a `Claude Code:` section after `Paths:`. Render `available` as `Claude credentials: <path> (available on host; host-owned)` and explain that recreation applies the current mount configuration. Render `missing` with host `/login` and recreation guidance. Render `unsupported` with either the macOS Keychain limitation or a platform-specific file-forwarding limitation.

  This status describes the generated-config mount eligibility, not a new health prerequisite. Keep `statusIsHealthy()` unchanged.

- [ ] **Step 4: Run the focused status tests to verify they pass**

  Run:

  ```sh
  node --import tsx --test --test-name-pattern='formats status for running and absent containers|Claude credential status' __tests__/app.test.ts
  ```

  Expected: PASS, and the existing healthy running status remains healthy.

- [ ] **Step 5: Commit the status slice**

  ```sh
  git add src/status.ts __tests__/app.test.ts
  git commit -m "feat: report Claude credential forwarding"
  ```

### Task 4: Document the Credential Boundary and Recreation Behavior

**Files:**
- Modify: `README.md`
- Modify: `docs/features/generated-config-and-state.md`
- Modify: `docs/features/start-and-shell.md`
- Modify: `docs/features/lifecycle.md`
- Modify: `assets/devcontainer/README.md`
- Modify: `assets/devcontainer/devcontainer.json`

**Interfaces:**
- Consumes the mount contract from Task 1 and the status/recreation behavior from Task 3.
- Produces user-facing documentation that distinguishes host-owned Claude credentials from non-mounted Claude configuration and from Codex's read-only auth file.

- [ ] **Step 1: Write the failing documentation assertions**

  Add a source-level test in `__tests__/app.test.ts` that reads the feature documents and asserts they contain the required user-facing phrases:

  ```ts
  test('documents narrow host Claude credential forwarding', () => {
    const stateDocs = readFileSync(join(process.cwd(), 'docs/features/generated-config-and-state.md'), 'utf8')
    const lifecycleDocs = readFileSync(join(process.cwd(), 'docs/features/lifecycle.md'), 'utf8')

    assert.match(stateDocs, /\.claude\/\.credentials\.json/)
    assert.match(stateDocs, /does not mount.*~\/\.claude.*~\/\.claude\.json/is)
    assert.match(stateDocs, /macOS.*Keychain/is)
    assert.match(lifecycleDocs, /does not remove host Claude credentials/is)
  })
  ```

- [ ] **Step 2: Run the documentation test to verify it fails**

  Run:

  ```sh
  node --import tsx --test --test-name-pattern='narrow host Claude credential forwarding' __tests__/app.test.ts
  ```

  Expected: FAIL because the current docs describe only optional full-directory mounts.

- [ ] **Step 3: Update the documentation and commented asset example**

  Make these exact documentation changes:

  - In `README.md`, add a short Claude Code authentication note near the coding-agent commands: supported host credentials are forwarded on Linux/WSL and Windows; users who log in after creating a container must recreate it.
  - In `docs/features/generated-config-and-state.md`, add a `Claude Code credentials` subsection. State the supported source paths, the writable single-file container target, the fact that Boxdown neither copies nor deletes it, and that it deliberately does not mount `~/.claude` or `~/.claude.json`. State the macOS Keychain limitation.
  - Expand the generated-mount list in that document to name the optional Claude credential file alongside the existing read-only Codex `auth.json` file. Update the recreation paragraph to include Claude host credentials.
  - In `docs/features/start-and-shell.md`, add the one-line `--recreate` recovery command for a newly created host credential.
  - In `docs/features/lifecycle.md`, state that `purge` does not delete host Claude credentials.
  - In `assets/devcontainer/README.md`, replace the `~/.claude` optional-customization bullet with an explanation that Boxdown now forwards the documented credential file automatically on supported platforms; leave generic guidance only for other agent configuration directories.
  - In `assets/devcontainer/devcontainer.json`, remove the commented `~/.claude` bind-mount example so it no longer suggests a broader, conflicting mount. Retain the generic `~/.gemini` example if desired, correcting its target to `/home/node/.gemini`.

- [ ] **Step 4: Run the documentation test and Markdown lint to verify they pass**

  Run:

  ```sh
  node --import tsx --test --test-name-pattern='narrow host Claude credential forwarding' __tests__/app.test.ts
  pnpm exec markdownlint -c .github/.markdownlint.yml README.md docs/features/generated-config-and-state.md docs/features/start-and-shell.md docs/features/lifecycle.md assets/devcontainer/README.md
  ```

  Expected: both commands PASS.

- [ ] **Step 5: Commit the documentation slice**

  ```sh
  git add README.md docs/features/generated-config-and-state.md docs/features/start-and-shell.md docs/features/lifecycle.md assets/devcontainer/README.md assets/devcontainer/devcontainer.json __tests__/app.test.ts
  git commit -m "docs: explain Claude credential forwarding"
  ```

### Task 5: Run the Full Verification Suite

**Files:**
- Verify only; no new production files.

**Interfaces:**
- Verifies all public behavior produced by Tasks 1 through 4.

- [ ] **Step 1: Run the complete test suite**

  Run:

  ```sh
  pnpm test
  ```

  Expected: PASS with all test files green.

- [ ] **Step 2: Run static and documentation checks**

  Run:

  ```sh
  pnpm lint
  pnpm build
  git diff --check 067dad8..HEAD
  ```

  Expected: all commands exit 0. `pnpm build` produces the distributable CLI without TypeScript errors; `git diff --check` prints no whitespace errors.

- [ ] **Step 3: Review the resulting change set before handoff**

  Run:

  ```sh
  git status --short
  git log --oneline 067dad8..HEAD
  git diff 067dad8..HEAD -- src/constants.ts src/paths.ts src/config.ts src/status.ts assets/image/Dockerfile README.md docs/features
  ```

  Expected: only the Claude host-auth feature commits are present, credentials are never included in output, and no host-wide Claude configuration mount has been added.
