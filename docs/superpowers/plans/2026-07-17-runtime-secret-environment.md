# Runtime Secret Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Boxdown-provided secrets available in Bash sessions without writing their values to the repository, persistent Boxdown state, Docker environment configuration, or workspace logs.

**Architecture:** A private per-workspace runtime directory holds three secret files and is mounted read-only at `/run/boxdown/secrets`. A Bash bootstrap exports values for interactive, non-interactive, SSH, and Boxdown coding-agent Bash sessions. Docker configuration carries only paths; metadata inspection requests only image fields; logging structurally redacts known assignments.

**Tech Stack:** Node.js 24, TypeScript, Bash, `node:test`, Docker/Dev Containers configuration.

## Global Constraints

- Do not print, log, serialize, or place a secret value in generated configuration, command arguments, metadata, or diagnostics.
- Fixed Boxdown secret names: `ANTHROPIC_API_KEY`, `SNYK_TOKEN`, and `OP_SERVICE_ACCOUNT_TOKEN`.
- Missing values and unavailable 1Password access are non-blocking; the affected variable is absent.
- `.env.development` is project-owned: Boxdown does not create, edit, delete, or migrate it.
- Runtime secret directories/files use `0700`/`0600` and are outside `workspaceDataDir`.
- Existing containers require `boxdown start --recreate`; do not add legacy cleanup or `doctor --fix-secrets`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/constants.ts`, `src/paths.ts` | Runtime secret paths and fixed secret-name constants. |
| `src/config.ts`, `assets/devcontainer/devcontainer.json` | Read-only mount and non-secret Bash bootstrap config. |
| `assets/devcontainer/hooks/initialize.sh` | Atomically create/remove runtime secret files. |
| `assets/devcontainer/utils/secret-env-bootstrap.sh` | Read fixed files and export present values without output. |
| `assets/devcontainer/hooks/post-create.sh`, `src/shell.ts` | Source bootstrap for interactive and Boxdown-launched Bash sessions. |
| `src/main.ts`, `src/purge.ts` | Remove workspace runtime state after down/purge. |
| `src/devcontainer.ts`, `src/logging.ts` | Narrow Docker inspection and structural redaction. |
| `src/doctor.ts`, docs, `__tests__/app.test.ts` | Safety checks, documentation, and regression tests. |

### Task 1: Define runtime secret state and remove workspace injection

**Files:**
- Modify: `src/constants.ts`, `src/paths.ts`, `src/config.ts`, `assets/devcontainer/devcontainer.json`, `assets/devcontainer/hooks/initialize.sh`, `assets/devcontainer/hooks/post-start.sh`, `__tests__/app.test.ts`

**Interfaces:**

```ts
export const BOXDOWN_SECRET_ENV_NAMES = ['ANTHROPIC_API_KEY', 'SNYK_TOKEN', 'OP_SERVICE_ACCOUNT_TOKEN'] as const
export const BOXDOWN_CONTAINER_SECRET_ENV_DIR = '/run/boxdown/secrets'
export const BOXDOWN_CONTAINER_SECRET_ENV_BOOTSTRAP = '/opt/boxdown/devcontainer/utils/secret-env-bootstrap.sh'
export function defaultRuntimeRoot (env?: NodeJS.ProcessEnv): string
// WorkspaceContext adds runtimeRoot, workspaceRuntimeDir, workspaceSecretEnvDir.
```

- [ ] **Step 1: Write failing tests**

Create a context with `BOXDOWN_RUNTIME_HOME`. Assert that its secret directory starts below runtime root but not persistent workspace data. Assert generated config mounts that directory read-only at `/run/boxdown/secrets`, sets the non-secret bootstrap `BASH_ENV`, retains `NODE_ENV`, and serializes none of `--env-file`, `.env.development`, or the three secret names.

- [ ] **Step 2: Verify red**

Run `pnpm test -- --test-name-pattern "runtime secret|generated config"`. Expected: FAIL because the current config injects workspace-file and Docker-environment secrets.

- [ ] **Step 3: Implement paths and config**

Add the fixed constants. Resolve runtime root in this order: `BOXDOWN_RUNTIME_HOME`; then `join(XDG_RUNTIME_DIR, PACKAGE_NAME)`; then `join(tmpdir(), package-name plus UID)`. Add workspace-ID scoped runtime/secret paths. Append the read-only secret mount and `BASH_ENV`; remove the base `--env-file` pair and secret `containerEnv` values while preserving non-secret entries.

- [ ] **Step 4: Implement host runtime-file refresh**

Pass only `BOXDOWN_SECRET_ENV_DIR` to `initializeCommand`. Set `umask 077`; create the directory at `0700`; write each nonempty file through `mktemp` plus `chmod 0600` plus atomic rename; remove a file when its host value is absent. Read the existing 1Password reference into a local variable and never echo it. Remove all `.env.development` preparation/upsert logic and post-start deletion.

- [ ] **Step 5: Verify green and commit**

Run `pnpm test -- --test-name-pattern "runtime secret|generated config|devcontainer git config hooks"` and `bash -n assets/devcontainer/hooks/initialize.sh assets/devcontainer/hooks/post-start.sh`; expect both to pass. Commit the listed sources and tests as `feat: mount runtime secret environment`.

### Task 2: Export secret files in supported Bash sessions and clean runtime state

**Files:**
- Create: `assets/devcontainer/utils/secret-env-bootstrap.sh`
- Modify: `assets/devcontainer/hooks/post-create.sh`, `src/shell.ts`, `src/main.ts`, `src/purge.ts`, `__tests__/app.test.ts`

**Interfaces:**

```bash
# Bootstrap reads /run/boxdown/secrets/<fixed-name> and exports only present values.
```

- [ ] **Step 1: Write failing tests**

Run the bootstrap against a temporary secret directory with sentinel values. Assert each present value is exported, an absent file remains unset, and stdout/stderr do not contain a sentinel. Assert interactive shell/agent scripts source the bootstrap before `exec`. Assert down/purge remove only workspace runtime state.

- [ ] **Step 2: Verify red**

Run `pnpm test -- --test-name-pattern "secret bootstrap|runtime secret cleanup|interactive shell setup"`. Expected: FAIL because no bootstrap or runtime cleanup exists.

- [ ] **Step 3: Implement bootstrap/session loading**

Create a no-output script that reads the three fixed files with `IFS= read -r`, exports only nonempty values, and never sources secret file contents as code. Add an idempotent source line to the node user's `.bashrc` in post-create. Add the same bootstrap source before final `exec` in both shell script builders; never add a value to `interactiveShellEnvArgs`.

- [ ] **Step 4: Implement safe runtime cleanup**

Add a path-contained helper that removes only `context.workspaceRuntimeDir`, accepts absence, and never removes `runtimeRoot`. Invoke it after successful down and during purge before persistent state removal.

- [ ] **Step 5: Verify green and commit**

Run `pnpm test -- --test-name-pattern "secret bootstrap|runtime secret cleanup|interactive shell setup"` and `bash -n assets/devcontainer/utils/secret-env-bootstrap.sh assets/devcontainer/hooks/post-create.sh`; expect pass. Commit as `feat: export runtime secrets in Bash sessions`.

### Task 3: Replace full Docker inspection and harden logging

**Files:**
- Modify: `src/devcontainer.ts`, `src/logging.ts`, `__tests__/app.test.ts`

**Interfaces:**

```ts
export function parseDockerInspectImage (output: string, containerId: string): DockerImageInfo | undefined
export function redactKnownSecretEnvironmentAssignments (value: string): string
```

- [ ] **Step 1: Write failing tests**

Test parsing two JSON-string lines representing image ID/name. Add a fake Docker complete-inspect fixture containing an OP sentinel, assert the lifecycle log omits it and inspect uses a narrow format. Test plain and Docker-JSON assignment forms for each known secret variable.

- [ ] **Step 2: Verify red**

Run `pnpm test -- --test-name-pattern "docker inspect|known secret|workspace logger"`. Expected: FAIL because inspect uses `{{json .}}` and logging is value-only.

- [ ] **Step 3: Implement projection/redaction**

Use Docker format `{{json .Image}}` followed by `{{json .Config.Image}}`; parse exactly two scalar JSON lines and provide a container-ID-specific malformed-output error. Redact values after each fixed name before dynamic redactions and apply it through logger `#redact` for arguments, sections, errors, and child output while preserving the names.

- [ ] **Step 4: Verify green and commit**

Run `pnpm test -- --test-name-pattern "docker inspect|known secret|workspace logger"`; expect pass. Commit as `fix: keep container secrets out of workspace logs`.

### Task 4: Doctor coverage and documentation

**Files:**
- Modify: `src/doctor.ts`, `__tests__/app.test.ts`, `assets/devcontainer/README.md`, `docs/features/generated-config-and-state.md`, `docs/features/start-and-shell.md`

- [ ] **Step 1: Write failing tests**

Extend doctor fake-command tests to require a disposable runtime-secret mount probe and a warning when generated config contains env-file, `.env.development`, or a fixed secret name in `containerEnv`. Add existing-style static documentation assertions for session exposure and `--recreate`.

- [ ] **Step 2: Verify red**

Run `pnpm test -- --test-name-pattern "doctor|generated config|runtime secret"`. Expected: FAIL because doctor does not inspect those conditions.

- [ ] **Step 3: Implement non-blocking checks/docs**

Add `workspaceSecretEnvDir` to disposable mount probes. Add a `secret-environment-config` doctor result: missing generated config is warning, unsafe config is warning, safe config is ok; never read secret file contents. Update docs: values are ordinary Bash-session variables but not Docker config; `.env.development` is ignored; missing values are non-blocking; existing containers need recreate; legacy leaked values/logs require manual removal and rotation.

- [ ] **Step 4: Verify green and commit**

Run `pnpm test -- --test-name-pattern "doctor|generated config|runtime secret"`; expect pass. Commit as `docs: describe runtime secret environment handling`.

### Task 5: Full verification

- [ ] **Step 1: Run the complete suite**

Run `pnpm test`, `pnpm lint`, `pnpm build`, `bash -n` for all changed hooks/utilities, `git diff --check`, and `git diff main...HEAD --check`. Expected: every command exits 0.

- [ ] **Step 2: Review secret-safety diff**

Run `git diff main...HEAD -- assets/devcontainer/devcontainer.json src/config.ts src/devcontainer.ts src/logging.ts`. Confirm no implementation path writes `.env.development`, uses `--env-file`, or contains literal token-like values.

- [ ] **Step 3: Commit a verification-only correction when required**

If verification requires a source correction, commit only that correction as `test: cover runtime secret environment regression`.

## Plan Self-Review

- Tasks 1–2 implement runtime-only state and compatible Bash-session exports.
- Task 3 removes the full-inspect log leak and adds a logging backstop.
- Task 4 adds doctor/documentation coverage without legacy cleanup.
- Task 5 runs full test, lint, build, Bash syntax, and diff checks.
