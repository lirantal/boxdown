# Node SSH-Agent Proxy Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable best-effort SSH commit signing for the non-root Boxdown user while preserving explicit user Git-signing preferences.

**Architecture:** A root Node proxy forwards the raw mounted agent socket to a node-owned socket. The post-create hook starts and verifies that proxy before signing bootstrap. The bootstrap applies Boxdown's SSH default only when neither global nor local Git configuration expresses a signing preference.

**Tech Stack:** TypeScript, Node `net` Unix sockets, Bash lifecycle hooks, Node test runner.

## Global Constraints

- Do not read, copy, mount, or log private keys.
- Signing and proxy failures must never block lifecycle commands or commits.
- Preserve explicit user `commit.gpgsign`, `gpg.format`, `user.signingkey`, and `gpg.program` settings.
- Existing containers require `--recreate`.

---

### Task 1: Add the node-accessible SSH-agent proxy

**Files:**

- Create: `assets/devcontainer/utils/ssh-agent-proxy.mjs`
- Modify: `assets/devcontainer/hooks/post-create.sh`
- Test: `__tests__/app.test.ts`

- [ ] **Step 1: Write a failing proxy forwarding test**

Create a temporary raw Unix server, launch the proxy with a temporary target
socket and the current test user's UID/GID, send bytes through the target, and
assert the raw server receives and echoes them.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `fnm exec --using v24.15.0 -- node --import tsx --test --test-name-pattern='forwards node SSH-agent connections' __tests__/app.test.ts`

Expected: FAIL because the proxy asset does not exist.

- [ ] **Step 3: Implement the proxy and lifecycle startup helper**

Implement a Node `net.createServer()` bridge that unlinks stale target sockets,
listens with mode `0600`, changes ownership to the supplied UID/GID, and pipes
each client to the raw socket. Start it with `sudo` in post-create, wait for
the target socket, and run `ssh-add -L` through it before signing bootstrap.

- [ ] **Step 4: Run the focused test to verify it passes**

Run the Task 1 command. Expected: PASS.

### Task 2: Route generated configuration and diagnostics through the proxy

**Files:**

- Modify: `src/config.ts`
- Modify: `assets/devcontainer/utils/git-signing-bootstrap.sh`
- Test: `__tests__/app.test.ts`

- [ ] **Step 1: Write failing generated-config and hook tests**

Assert enabled plans set `SSH_AUTH_SOCK` to `/run/boxdown/ssh-agent-node.sock`,
retain the raw source only in `BOXDOWN_GIT_SIGNING_SOURCE_SOCKET`, and disable
signing with `container-agent-proxy-unavailable` when proxy readiness fails.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `fnm exec --using v24.15.0 -- node --import tsx --test --test-name-pattern='node SSH-agent proxy|proxy-unavailable' __tests__/app.test.ts`

Expected: FAIL because generated configuration still exposes the raw socket.

- [ ] **Step 3: Implement proxy socket configuration and failure reporting**

Add constants or literal paths for raw and node-facing sockets, update generated
container environment, and teach the bootstrap to report the proxy reason
without replacing user configuration.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run the Task 2 command. Expected: PASS.

### Task 3: Preserve explicit user signing configuration

**Files:**

- Modify: `assets/devcontainer/utils/git-signing-bootstrap.sh`
- Modify: `docs/features/commit-signing.md`
- Modify: `docs/superpowers/specs/2026-07-11-default-commit-signing-design.md`
- Test: `__tests__/app.test.ts`

- [ ] **Step 1: Write failing bootstrap tests**

Add separate tests for repository-local `commit.gpgsign=false`, global
non-SSH `gpg.format`, and an explicit SSH signing key. Assert the first two
remain unchanged; assert the SSH case maps only its public-key path to the
mounted snapshot and signs successfully.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `fnm exec --using v24.15.0 -- node --import tsx --test --test-name-pattern='preserves explicit.*signing' __tests__/app.test.ts`

Expected: FAIL because the bootstrap currently overwrites global SSH settings.

- [ ] **Step 3: Implement explicit-preference detection**

Check local configuration first, then copied global configuration. Preserve an
explicit opt-out or non-SSH configuration; use Boxdown defaults only with no
explicit preference. For explicit SSH configuration, replace only an
unavailable public-key path with the selected mounted key.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run the Task 3 command. Expected: PASS.

### Task 4: Document and verify

**Files:**

- Modify: `docs/features/commit-signing.md`
- Modify: `docs/superpowers/specs/2026-07-11-default-commit-signing-design.md`
- Create: `.changeset/<generated-name>.md`

- [ ] **Step 1: Document the proxy, user-precedence policy, and `--recreate` requirement**

- [ ] **Step 2: Add a patch changeset**

- [ ] **Step 3: Run complete verification**

Run: `pnpm test`, `pnpm lint`, `pnpm build`, `bash -n assets/devcontainer/utils/git-signing-bootstrap.sh`, `node --check assets/devcontainer/utils/ssh-agent-proxy.mjs`, and `git diff --check`.

- [ ] **Step 4: Commit**

Use: `git commit -m "fix: proxy SSH agent for commit signing"`
