# Default Commit Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new Boxdown environments sign commits through the host SSH agent by default, while retaining an unsigned, warning-only fallback.

**Architecture:** A host-side resolver selects one unambiguous public SSH key and snapshots only that key into workspace state. The generated devcontainer config mounts the host agent and the public-key snapshot. A container bootstrap validates a disposable SSH-signed commit and configures global Git for SSH signing or disables it without touching repository-local Git config.

**Tech Stack:** Node.js 24, TypeScript, Bash, Git, OpenSSH, Docker/Dev Containers CLI, Node test runner.

## Global Constraints

- Never copy private signing-key material into Boxdown state or the container.
- Multiple ambiguous agent identities disable signing and warn; never select one arbitrarily.
- Signing diagnostics are `warn`, never a setup-preflight failure.
- Never write `commit.gpgsign` in the repository-local `.git/config`.
- Docker integration is optional and must not pull images or push commits.

---

### Task 1: Resolve and persist a signing plan

**Files:**

- Create: `src/git-signing.ts`
- Modify: `src/constants.ts`, `src/paths.ts`, `src/config.ts`
- Test: `__tests__/app.test.ts`

**Interfaces:**

```ts
export type GitSigningReason = 'agent-unavailable' | 'no-identities' | 'ambiguous-identities' | 'configured-key-not-loaded' | 'agent-mount-unavailable'
export interface GitSigningPlan { enabled: boolean, reason?: GitSigningReason, publicKey?: string, agentSocketSource?: string }
export function parseSshPublicKey(value: string): string | undefined
export function selectGitSigningKey(identities: string[], configuredKey?: string, githubKeys?: string[]): { key?: string, reason?: GitSigningReason }
export function writeGitSigningPublicKey(context: WorkspaceContext, key: string): void
```

- [ ] Write focused failing tests for parsing keys without comments, configured-key selection, a unique GitHub-key match, single-key fallback, ambiguous fallback, and config mount generation.
- [ ] Run `node --import tsx --test --test-name-pattern='git signing|devcontainer config generation' __tests__/app.test.ts` and confirm the new assertions fail because the module and mounts do not exist.
- [ ] Add state paths and container constants, implement the pure resolver and public-key snapshot, and let `buildGeneratedDevcontainerConfig(context, signingPlan)` add read-only key-state and agent mounts only for enabled plans.
- [ ] Rerun the focused tests and confirm they pass.

### Task 2: Configure and validate container-side Git signing

**Files:**

- Create: `assets/devcontainer/utils/git-signing-bootstrap.sh`
- Modify: `assets/devcontainer/utils/git-config-bootstrap.sh`, `assets/devcontainer/hooks/post-create.sh`, `assets/devcontainer/hooks/post-start.sh`
- Test: `__tests__/app.test.ts`

**Interfaces:**

```bash
bash /opt/boxdown/devcontainer/utils/git-signing-bootstrap.sh
# Reads BOXDOWN_GIT_SIGNING_ENABLED and BOXDOWN_GIT_SIGNING_KEY_PATH.
# Exits 0 in both signed and unsigned fallback modes.
```

- [ ] Write failing shell-hook tests for successful SSH configuration, absent-agent fallback, removal of incompatible `gpg.program`, and absence of repository-local `commit.gpgsign` writes.
- [ ] Run the matching `devcontainer git config hooks` tests and confirm the new assertions fail.
- [ ] Implement a temporary-repository signing probe using `ssh-add -L`, a temporary allowed-signers file, and `git commit --allow-empty`; set global SSH signing only after it succeeds, otherwise set global `commit.gpgsign=false` and print a warning.
- [ ] Remove unconditional global signing disablement and all post-create local `commit.gpgsign` mutations; call the bootstrap after create and start.
- [ ] Rerun the hook tests and confirm they pass.

### Task 3: Use one signing-aware lifecycle for every command

**Files:**

- Modify: `src/devcontainer.ts`, `src/main.ts`
- Test: `__tests__/app.test.ts`

**Interfaces:**

```ts
export async function resolveGitSigningPlan(context: WorkspaceContext): Promise<GitSigningPlan>
export async function ensureContainerGitSigning(context: WorkspaceContext, plan: GitSigningPlan, options?: ContainerCommandOptions): Promise<void>
```

- [ ] Write failing command-flow tests proving `startDevcontainer` writes a signing-aware config and invokes the non-fatal container signing refresh for fresh and reused containers.
- [ ] Run the relevant `CLI execution` and `coding-agent command mapping` tests and confirm they fail on the missing signing lifecycle.
- [ ] Resolve the plan before writing generated config, pass plan state to the lifecycle script, and call the refresh from shared startup so setup, shell, coding agents, SSH proxy, and tunnels all inherit it.
- [ ] Ensure refresh failures only warn and do not change the command exit code.
- [ ] Rerun focused lifecycle tests and confirm they pass.

### Task 4: Add doctor/preflight warnings and user documentation

**Files:**

- Modify: `src/doctor.ts`, `src/main.ts`, `README.md`, `docs/features/setup.md`, `docs/architecture.md`, `docs/features/README.md`
- Create: `docs/features/commit-signing.md`, `.changeset/<generated-name>.md`
- Test: `__tests__/app.test.ts`

- [ ] Write failing doctor tests for unavailable agent, ambiguous identities, unusable mount, missing GitHub signing registration, and warning-only setup behavior.
- [ ] Run the `doctor output` and setup-preflight tests and confirm the new checks are absent.
- [ ] Add warning-only host signing checks, including an optional GitHub signing-key query; do not add account mutations or required preflight failures.
- [ ] Document automatic selection order, unsigned fallback, Docker mount limitations, agent security exposure, and GitHub's one-time separate signing-key registration.
- [ ] Add a changeset for default-on best-effort commit signing.
- [ ] Rerun focused doctor/setup tests and lint changed Markdown.

### Task 5: Verify the full feature

**Files:**

- Test: `__tests__/app.test.ts`

- [ ] Run `node --import tsx --test __tests__/**/*.test.ts`; record the two known unrelated baseline failures and require no additional failures.
- [ ] Run `npm run build` and `npm run lint` using local project tooling where available.
- [ ] With Docker and a loaded agent available, create a disposable container using the generated mount, make an empty signed commit, and verify its SSH fingerprint; do not push it.
- [ ] Review `git diff --check`, changed docs, and the implementation against `docs/superpowers/specs/2026-07-11-default-commit-signing-design.md`.
