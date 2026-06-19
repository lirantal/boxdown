# Todo and Next Plans

This file is a handoff for the next Boxdown implementation session. It assumes
v1 exists as a CLI-first package that stores reusable devcontainer assets under
`assets/devcontainer/`, generates per-workspace override config outside target
repositories, and supports start (with `shell` as an alias), SSH proxy, SSH
config install, lifecycle status/stop/down/doctor commands, and GitHub auth
refresh commands.

## Current Baseline

- Boxdown has no root `.devcontainer/` directory.
- Reusable devcontainer source lives in `assets/devcontainer/`.
- Generated config uses the Dev Containers CLI with `--workspace-folder` and
  `--override-config`.
- Workspace cache state defaults to `~/.cache/boxdown`.
- Workspace persistent state defaults to `~/.local/share/boxdown`.
- Host private SSH keys stay on the host; the container receives only a public
  key mount.
- Lifecycle commands report status, check host prerequisites, stop containers,
  and remove containers without deleting Boxdown state or SSH keys.
- Unit tests cover parsing, generated config shape, SSH config block generation,
  lifecycle output formatting, and packaging safety.

## Next Implementation Tracks

### 1. Manual Acceptance and Runtime Fixes (completed)

The real Docker and SSH workflow was tested from linked local `boxdown`
commands. Runtime fixes from that pass included interactive terminal width
normalization and command alias cleanup.

Acceptance commands:

```sh
boxdown start --workspace ~/projects/repos/gh-cp
boxdown ssh-config install --workspace ~/projects/repos/gh-cp
ssh gh-cp-devcontainer 'whoami && pwd'

boxdown start --workspace ~/projects/repos/lirantaldotcom
boxdown ssh-config install --workspace ~/projects/repos/lirantaldotcom
ssh lirantaldotcom-devcontainer 'whoami && pwd'
```

### 2. Lifecycle Commands and CLI UX (completed)

Added practical commands around the existing start flow:

- `boxdown status` to show workspace, generated config path, container ID,
  running state, SSH alias, and key paths.
- `boxdown stop` to stop the workspace container.
- `boxdown down` to remove the workspace container.
- `boxdown doctor` to validate Node, npm, Docker, SSH, `gh`, and asset presence.
- `boxdown status --json` for machine-readable status output.

Lifecycle commands keep destructive behavior explicit and conservative. They do
not remove generated state or SSH keys.

### 3. Editor Stub Support

Add an optional command for users who want native VS Code or Cursor Dev
Containers discovery:

```sh
boxdown init-editor-stub
```

The stub should be opt-in and small. It can either create a minimal
`.devcontainer/devcontainer.json` that delegates to Boxdown-generated config or
document why native editor discovery still requires a project-local file.

Do not make editor stubs part of the default workflow. The v1 invariant is that
target repositories stay clean unless the user explicitly asks for a file.

### 4. Customization and Profiles

Design a small user configuration surface for common changes:

- Extra forwarded ports.
- Extra host mounts for agent config directories.
- Feature toggles for tools such as Snyk, 1Password, Codex CLI, or APM.
- Image or Node version overrides.
- Per-project SSH alias defaults.

Prefer a Boxdown-owned config file under user config/state locations before
adding target-repo config. If target-repo config is needed, make precedence and
security implications explicit.

### 5. Dev Container Feature Packaging

Investigate moving the container-side OpenSSH bootstrap and runtime setup into a
proper Dev Container Feature. This could make lifecycle behavior more
spec-native and reduce reliance on mounted shell assets.

Questions to answer:

- Should the feature be published to GHCR?
- Does publishing a feature complicate local development?
- Which setup should remain as mounted assets for offline or unreleased use?

### 6. Asset Sync Workflow

Decide whether `gh-cp/.devcontainer` remains the canonical source or whether
Boxdown now owns the canonical asset copy.

If `gh-cp` remains canonical, add a documented sync command or maintainer script
that copies only tracked files and excludes `.ssh/`. If Boxdown becomes
canonical, update docs in both repos so future changes happen in the right
place.

### 7. Integration Test Harness

Add tests beyond pure unit coverage without making CI fragile:

- Fake `docker`, `npm`, `gh`, and `devcontainer` binaries for command argument
  assertions.
- Temporary HOME, cache, data, and SSH config paths.
- Golden tests for generated `devcontainer.json`.
- Optional local-only integration tests that start real containers.

Keep real Docker tests out of default CI until they are fast, deterministic, and
safe for GitHub Actions runners.

### 8. Release Polish

Before the first serious npm release:

- Confirm package contents with `npm pack --dry-run --json`.
- Confirm `npx boxdown --help` works from a packed tarball.
- Add examples for common agent workflows.
- Confirm the changeset summary is user-facing.
- Consider whether `dist` should be committed or only generated in release CI.

## What a Fresh Session Needs to Know

Read these files first:

- `docs/architecture.md`
- `docs/features/generated-config-and-state.md`
- `docs/features/ssh-config-and-proxy.md`
- `src/config.ts`
- `src/devcontainer.ts`
- `src/ssh-config.ts`
- `src/ssh-key.ts`

Confirm these facts before implementation:

- Whether real Docker/SSH manual acceptance is allowed in the current session.
- Which host platforms are in scope for the next release: macOS, Linux, WSL, or
  Windows OpenSSH.
- Whether Boxdown or `gh-cp` should own canonical devcontainer assets going
  forward.
- Whether target repositories may ever contain generated files by default.
- Whether user configuration should live only in Boxdown state or may be read
  from the target repository.
- Which editor gets first-class support if editor stubs are built.
- Whether GitHub auth refresh should keep using `--insecure-storage` inside the
  container or offer a more configurable credential strategy.

## Suggested Fresh-Session Prompt

```text
Continue Boxdown after v1. Read docs/todo.md, docs/architecture.md, and the
feature docs first. Start with manual Docker and SSH acceptance for two repos,
then fix any runtime issues while preserving the invariants: no root
.devcontainer in Boxdown, no .devcontainer copied into target repos, no private
SSH key mounted into containers, and generated config/state owned by Boxdown.
```
