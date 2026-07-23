# Targeted SSH Integration Uninstall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support `boxdown ssh uninstall --target <name>` so users can remove selected app integrations without removing the Boxdown-managed SSH alias, while preserving unqualified full cleanup.

**Architecture:** Keep `src/ssh-install-targets.ts` as the single registry of optional SSH integrations by adding an uninstall lifecycle handler beside each existing install handler. `src/main.ts` will treat the presence of one or more parsed targets as integration-only mode; when targets are absent, it will remove the OpenSSH alias and dispatch every registered target handler.

**Tech Stack:** TypeScript (Node.js), Node built-in test runner with `tsx`, `eslint`, `markdownlint-cli`.

## Global Constraints

- Supported SSH integration target names remain exactly `codex` and `claude`.
- `--target` is repeatable and parsed targets retain first-seen order after deduplication.
- `ssh uninstall` with no `--target` remains complete cleanup: remove the SSH block and every registered target integration.
- Any `ssh uninstall --target ...` invocation preserves the managed SSH block, even when every known target is named.
- Targeted cleanup must not prompt or write workspace metadata.
- Codex removal includes app config, persisted sidebar state, and legacy `/home/node/<repo>` paths.
- Claude removal includes its matching remote and trusted-host entry.
- `purge` remains full cleanup and must not accept `--target`.

---

## File Structure

- Modify `src/ssh-install-targets.ts`: make each target definition own install and uninstall behavior, including target-specific status and restart output.
- Modify `src/main.ts`: accept `--target` for `ssh uninstall`, select complete versus targeted mode, and delegate app cleanup through the registry.
- Modify `__tests__/app.test.ts`: cover parser rules and end-to-end CLI behavior across the SSH config and the two external app config files.
- Modify `README.md`: describe target-only cleanup and unqualified full cleanup in user-facing command guidance.
- Modify `docs/features/ssh-config-and-proxy.md`: document the exact cleanup matrix and examples.
- Modify `docs/architecture.md`: keep the external-app integration lifecycle description accurate.

### Task 1: Parse and document the targeted-uninstall CLI contract

**Files:**

- Modify: `src/main.ts: USAGE string and parseCliArgs target command validation`
- Modify: `__tests__/app.test.ts: parseCliArgs and USAGE tests near existing SSH command coverage`

**Interfaces:**

- Consumes: `isSshConfigInstallTarget(value): value is SshConfigInstallTarget` and `dedupeSshInstallTargets(targets)` from `src/ssh-install-targets.ts`.
- Produces: `ParsedCli` with `command: 'ssh-uninstall'` and an optional deduplicated `targets: SshConfigInstallTarget[]` field.
- Produces: CLI help where `ssh uninstall` accepts `[--target <name>]...` and `--target` names `setup`, `ssh install`, and `ssh uninstall` as supported commands.

- [ ] **Step 1: Write failing parser and help tests**

  Add the following assertion to the existing `parses ssh uninstall` test, preserving its existing no-target cases:

  ```ts
  assert.deepStrictEqual(parseCliArgs([
    'ssh', 'uninstall', '--target', 'codex', '--target', 'claude', '--target', 'codex'
  ]), {
    command: 'ssh-uninstall',
    workspace: undefined,
    alias: undefined,
    targets: ['codex', 'claude'],
    recreate: false,
    json: false,
    verbose: false
  })
  ```

  Replace the existing target-rejection expectation with these two assertions:

  ```ts
  assert.throws(
    () => parseCliArgs(['start', '--target', 'codex']),
    /--target is only supported with setup, ssh install, and ssh uninstall/
  )
  assert.throws(
    () => parseCliArgs(['codex', '--target', 'claude']),
    /--target is only supported with setup, ssh install, and ssh uninstall/
  )
  ```

  Extend the USAGE checks so they require:

  ```ts
  assert.match(USAGE, /boxdown ssh uninstall \[--workspace <path>\] \[--alias <name>\] \[--target <name>\]\.\.\./)
  assert.match(USAGE, /Repeatable\. Supported by[\s\S]*setup, ssh install, and ssh uninstall: codex, claude\./)
  ```

- [ ] **Step 2: Run the targeted tests and verify they fail**

  Run:

  ```bash
  pnpm exec tsx --test __tests__/app.test.ts --test-name-pattern="parses ssh uninstall|rejects unknown commands|prints usage"
  ```

  Expected: the parser test fails because `parseCliArgs` rejects targets for
  `ssh-uninstall`, and the USAGE assertion fails because its syntax and option
  copy do not yet include uninstall.

- [ ] **Step 3: Make the minimal parser and help changes**

  In `src/main.ts`, make these exact behavioral changes:

  ```ts
  if (targets.length > 0 && command !== 'setup' && command !== 'ssh-install' && command !== 'ssh-uninstall') {
    throw new Error('--target is only supported with setup, ssh install, and ssh uninstall')
  }
  ```

  Update the SSH uninstall usage line to:

  ```text
  boxdown ssh uninstall [--workspace <path>] [--alias <name>] [--target <name>]...
  ```

  Update the `--target` option description to identify it as an optional SSH
  integration target and list the three supported command forms. Update the
  `ssh uninstall` command description so it distinguishes removing the managed
  SSH alias from removing selected app integrations. Do not alter `parsed()`'s
  existing deduplication or omit-empty-target behavior.

- [ ] **Step 4: Run the targeted tests and verify they pass**

  Run:

  ```bash
  pnpm exec tsx --test __tests__/app.test.ts --test-name-pattern="parses ssh uninstall|rejects unknown commands|prints usage"
  ```

  Expected: PASS. `ssh uninstall --target codex --target claude --target codex`
  parses to `['codex', 'claude']`; non-SSH commands still reject the flag.

- [ ] **Step 5: Commit the parser contract**

  ```bash
  git add src/main.ts __tests__/app.test.ts
  git commit -m "feat: accept targets for ssh uninstall"
  ```

### Task 2: Move target cleanup into the registry and execute targeted mode

**Files:**

- Modify: `src/ssh-install-targets.ts: target definition lifecycle interface, Codex/Claude cleanup handlers, registry dispatcher`
- Modify: `src/main.ts: ssh-uninstall execution branch and imports`
- Modify: `__tests__/app.test.ts: CLI integration tests near explicit target installation tests`

**Interfaces:**

- Consumes: `uninstallCodexAppConfigProject(entry, { additionalRemotePaths })` and `uninstallCodexGlobalStateProject(entry, { additionalRemotePaths })` from `src/codex-app-config.ts`.
- Consumes: `uninstallClaudeSshConfigHost(entry)` from `src/claude-app-config.ts`.
- Produces: `uninstallSshInstallTarget(context: WorkspaceContext, alias: string, targetValue: SshConfigInstallTarget, options?: SshInstallTargetOptions): Promise<void>`.
- Produces: `SshInstallTargetDefinition.uninstall(context, alias, options)` alongside its existing `install` method.

- [ ] **Step 1: Write failing target-only and complete-cleanup CLI tests**

  Add a test that prepares all three managed artifact types by running:

  ```ts
  runCliProcess(['ssh', 'install', '--workspace', workspace, '--target', 'codex', '--target', 'claude'], env)
  ```

  Then run targeted Claude removal:

  ```ts
  const result = runCliProcess(['ssh', 'uninstall', '--workspace', workspace, '--target', 'claude'], env)
  assert.strictEqual(result.code, 0)
  assert.strictEqual(existsSync(sshConfigPath), true)
  assert.strictEqual(parseCodexAppConfig(JSON.parse(readFileSync(codexConfigPath, 'utf8'))).remoteConnections.length, 1)
  assert.deepStrictEqual(parseClaudeSshConfigs(JSON.parse(readFileSync(claudeConfigPath, 'utf8'))), {
    configs: [],
    trustedHosts: []
  })
  assert.match(result.stdout, /Removed Claude SSH remote:/)
  assert.doesNotMatch(result.stdout, /Removed SSH alias:/)
  assert.doesNotMatch(result.stdout, /Codex app config:/)
  ```

  Add the symmetric Codex test. Seed a Codex global-state fixture containing a
  canonical project and a legacy `/home/node/<workspace>` project before
  calling `ssh uninstall --target codex`. Assert that the managed SSH block and
  Claude remote remain, the Codex app config has no matching canonical or
  legacy project, and the matching global-state remote projects are absent.

  Add a multi-target test that uninstalls `codex` and `claude` together and
  asserts the SSH config block still exists. Add a no-target test that creates
  the same three artifacts, runs `ssh uninstall`, and asserts the SSH config
  is empty while both app configs have their matching entries removed.

- [ ] **Step 2: Run the new CLI behavior tests and verify they fail**

  Run:

  ```bash
  pnpm exec tsx --test __tests__/app.test.ts --test-name-pattern="uninstalls selected SSH target|uninstalls all SSH integrations"
  ```

  Expected: targeted tests fail because the existing command removes the SSH
  block and both integrations regardless of `parsed.targets`.

- [ ] **Step 3: Add uninstall handlers to the SSH target registry**

  In `src/ssh-install-targets.ts`, replace the install-only options type with a
  shared options type and add the lifecycle method:

  ```ts
  export interface SshInstallTargetOptions {
    quiet?: boolean
  }

  export interface SshInstallTargetDefinition {
    value: SshConfigInstallTarget
    label: string
    description: string
    flag: string
    install: (context: WorkspaceContext, alias: string, options?: SshInstallTargetOptions) => Promise<void> | void
    uninstall: (context: WorkspaceContext, alias: string, options?: SshInstallTargetOptions) => Promise<void> | void
  }
  ```

  Implement `uninstallCodexTarget` with the exact existing cleanup inputs:

  ```ts
  const entry = codexProjectEntryForWorkspace(context, alias)
  const legacyRemotePath = legacyCodexRemotePathForWorkspace(context)
  const result = uninstallCodexAppConfigProject(entry, {
    additionalRemotePaths: [legacyRemotePath]
  })
  const stateResult = uninstallCodexGlobalStateProject(entry, {
    additionalRemotePaths: [legacyRemotePath]
  })
  ```

  Outside quiet mode, preserve the current Codex config/state paths, changed
  versus absent messages, backup messages, and Codex restart instruction.
  Implement `uninstallClaudeTarget` with `claudeSshConfigEntryForWorkspace`
  and `uninstallClaudeSshConfigHost`; print its current changed-versus-absent,
  backup, and Claude restart messages outside quiet mode. Register both
  handlers in `SSH_INSTALL_TARGETS`.

  Add this dispatcher after `installSshInstallTarget`:

  ```ts
  export async function uninstallSshInstallTarget (
    context: WorkspaceContext,
    alias: string,
    targetValue: SshConfigInstallTarget,
    options: SshInstallTargetOptions = {}
  ): Promise<void> {
    const target = SSH_INSTALL_TARGETS.find((candidate) => candidate.value === targetValue)

    if (target === undefined) {
      throw new Error(`Unsupported ssh install target: ${targetValue}`)
    }

    await target.uninstall(context, alias, options)
  }
  ```

- [ ] **Step 4: Dispatch the correct cleanup mode from `runCli`**

  In `src/main.ts`, remove direct Codex/Claude uninstall imports and import
  `uninstallSshInstallTarget` from `src/ssh-install-targets.ts`. Replace the
  existing `ssh-uninstall` branch with logic equivalent to:

  ```ts
  const targets = parsed.targets ?? SSH_INSTALL_TARGETS.map((target) => target.value)

  if (parsed.targets === undefined) {
    uninstallSshConfig(alias)
  }

  for (const target of targets) {
    await uninstallSshInstallTarget(context, alias, target)
  }

  return 0
  ```

  Do not write metadata, prompt, or call `installSshConfig` in this branch.
  Do not change `purge.ts`; it remains explicit full cleanup until a separate
  feature deliberately centralizes that path.

- [ ] **Step 5: Run the target behavior tests and verify they pass**

  Run:

  ```bash
  pnpm exec tsx --test __tests__/app.test.ts --test-name-pattern="uninstalls selected SSH target|uninstalls all SSH integrations|uninstalls managed SSH config block"
  ```

  Expected: PASS. Each targeted invocation leaves the SSH alias untouched,
  Codex cleanup handles canonical and legacy paths, Claude cleanup removes its
  trusted host, and no-target invocation preserves complete cleanup.

- [ ] **Step 6: Commit the target lifecycle implementation**

  ```bash
  git add src/main.ts src/ssh-install-targets.ts __tests__/app.test.ts
  git commit -m "feat: support targeted ssh uninstall"
  ```

### Task 3: Publish the targeted cleanup behavior and run the full checks

**Files:**

- Modify: `README.md: SSH target examples and removal guidance`
- Modify: `docs/features/ssh-config-and-proxy.md: SSH uninstall behavior section`
- Modify: `docs/architecture.md: external app integrations lifecycle section`

**Interfaces:**

- Consumes: the completed CLI contract from Tasks 1 and 2.
- Produces: consistent end-user and architecture documentation for target-only
  versus complete SSH cleanup.

- [ ] **Step 1: Update the README command guidance**

  Replace the single removal example with both modes:

  ```sh
  npx boxdown ssh uninstall --target claude
  npx boxdown ssh uninstall --target codex
  npx boxdown ssh uninstall
  ```

  State that a target flag removes only that agent integration and leaves the
  SSH alias in place, while omitting the flag removes the alias and all known
  integrations. Mention that `--target` is repeatable.

- [ ] **Step 2: Update feature and architecture documentation**

  In `docs/features/ssh-config-and-proxy.md`, replace the unconditional claim
  that `ssh uninstall` removes Codex data with the two-mode matrix from the
  approved design. Include examples for a single target, multiple targets, and
  unqualified complete cleanup. In `docs/architecture.md`, state that each
  app integration is removable independently through `ssh uninstall --target`
  while `purge` and unqualified uninstall perform full cleanup.

- [ ] **Step 3: Run documentation lint and the complete verification suite**

  Run:

  ```bash
  pnpm exec markdownlint -c .github/.markdownlint.yml README.md docs/architecture.md docs/features/ssh-config-and-proxy.md
  pnpm test
  pnpm run build
  pnpm run lint
  git diff --check
  ```

  Expected: every command exits `0`; the full suite has no TypeScript, test,
  ESLint, Markdown, or whitespace errors.

- [ ] **Step 4: Commit the documentation and verification-ready change**

  ```bash
  git add README.md docs/architecture.md docs/features/ssh-config-and-proxy.md
  git commit -m "docs: explain targeted ssh cleanup"
  ```

## Self-Review

- [x] The plan covers every approved behavior: target-only cleanup, no-target
  complete cleanup, repeatable target selection, future-target registry
  ownership, CLI output, documentation, and tests.
- [x] The planned parser, registry, and dispatch signatures use the same
  `SshConfigInstallTarget` name and ordered deduplicated `targets` data.
- [x] The plan intentionally leaves `purge` as full cleanup and does not add
  unrelated state migration or prompting behavior.
- [x] A scan found no placeholders, deferred work markers, or ambiguous mode
  selection: the presence of `--target` always means preserve the alias.
