# Purge Removal Plan Design

## Status

Approved 2026-07-26.

## Context

`boxdown purge` already asks for confirmation in an interactive terminal, but
the prompt currently summarizes removal with internal, generic terms such as
"devcontainer", "cache", and "data". That does not let a control-conscious
user determine which resources on their machine will be affected.

The feature will make the normal `boxdown purge` flow explain its planned
effects. It deliberately does not add a `--dry-run` flag or change what purge
removes.

## Goals

- Before deletion, show an exact, user-facing removal plan for every selected
  workspace.
- Use concrete resource names and paths instead of Boxdown implementation
  terminology.
- Preserve the existing styled interactive confirmation prompt.
- Give explicitly targeted non-interactive and CI invocations the same plan as
  readable, plain text before deletion begins.
- Clearly identify resources that purge keeps.
- Never disclose secret values while describing runtime state.
- Preserve the existing removal behavior and its final, authoritative
  re-checks.

## Non-goals

- Add a `--dry-run`, a new purge command, or JSON output for purge.
- Change target selection, confirmation policy, deletion order, or which
  resources purge owns.
- Delete repositories, host Git configuration, unrelated Docker resources, or
  other Boxdown workspaces.
- Expose runtime-secret contents, SSH private-key contents, or command-log
  contents.
- Make a preview an atomic reservation of Docker resources; Docker state can
  change after confirmation.

## User-facing contract

### Vocabulary

The removal plan must use these user-facing terms:

- **Docker container**, never "devcontainer".
- **Docker image used by this workspace**, including the image name and/or ID
  when known.
- **Docker volumes attached only to that container**, because purge removes the
  container with its anonymous volumes.
- **SSH connection** for Boxdown-managed SSH aliases.
- **Codex remote project** and **Claude remote connection** for managed app
  entries.
- **Generated Boxdown configuration**, **Boxdown workspace data**, and
  **temporary runtime state** for Boxdown-owned directories.

The plan may explain what a directory contains at a high level, for example
that workspace data includes the workspace SSH key, command log, metadata, and
Git-config snapshot. It must not print sensitive file contents.

### Interactive execution

For an interactive TTY, the existing `Purge Boxdown workspace?` confirmation
remains the decision point. Its detail area becomes a grouped removal plan:

```text
This will remove:

• Docker container: Boxdown: newsfeed-app (running)
• Docker image used by this workspace: ghcr.io/lirantal/boxdown:… (sha256:…)
• Docker volumes attached only to that container
• SSH connection: newsfeed-app-devcontainer
• Codex remote project and Claude remote connection for that SSH connection,
  when installed
• Generated Boxdown configuration:
  ~/.cache/boxdown/workspaces/<id>/
• Boxdown workspace data:
  ~/.local/share/boxdown/workspaces/<id>/
• Temporary runtime state:
  …/boxdown/workspaces/<id>/

This will keep:

• Your repository and files: /path/to/newsfeed-app
• Your Git history and original host Git configuration
• Other Docker containers, images, volumes, and Boxdown workspaces
```

The actual output uses the existing prompt styling rather than this literal
Markdown layout. A plan is a snapshot collected immediately before the prompt;
the deletion phase must re-resolve Docker resources so a changed container is
handled safely.

When an optional resource is absent or cannot be read, the plan says so. For
example, it can state that no Boxdown Docker container currently exists or
that Docker state could not be inspected and purge will attempt cleanup during
execution. It must never imply that an absent resource will be removed.

### Batch interactive execution

After the workspace selector, the single confirmation displays a compact,
clearly separated removal plan for each selected workspace. Each section names
that workspace path and has its own resources and retained-resource guarantee.

### Explicit non-interactive and CI execution

An explicitly targeted purge still does not prompt in non-interactive or CI
execution. Before it mutates state, it writes the same removal plan in plain
text, without ANSI control sequences. This makes logs informative while
preserving automation's non-blocking behavior.

Running purge without a target from an untracked non-interactive directory
continues to fail safely and does not emit a plan.

## Data collection and rendering design

Introduce a focused `PurgePlan` model in `src/purge.ts`. It represents only
the displayable plan for one workspace:

- workspace path;
- discovered Docker container identifier/name and state, if present;
- inspected image name/ID when available, otherwise the recorded image ID;
- candidate managed SSH aliases (provided, recorded, and default);
- the Boxdown-managed Codex and Claude entries associated with those aliases;
- exact runtime, cache, and workspace-data paths, with existence state; and
- a stable list of retained resources.

The planner uses read-only metadata, filesystem, Docker lookup, and Docker
image inspection. It performs no logging setup, removal, configuration write,
or prompt side effect. A failure to inspect one optional resource becomes a
displayable availability state rather than a reason to skip the normal purge
flow.

`src/main.ts` builds all selected plans before confirmation. It routes the
formatted result to the existing prompt in interactive mode and to ordinary
stdout in non-interactive mode. The existing `purgeWorkspace` execution path
continues to look up Docker resources again and remains responsible for all
deletions and errors.

## Safety and compatibility

- A cancelled interactive purge may perform read-only Docker discovery, but
  must not remove containers, images, directories, SSH config, or app entries.
- The normal purge confirmation remains required in interactive terminals.
- CI and scripts retain their current no-prompt behavior for explicitly
  targeted workspaces.
- The per-workspace command log is still created only after confirmation, when
  the purge lifecycle begins; previewing does not create a log entry.
- Resource names in the plan are informational. Purge does not widen its
  deletion scope based on a preview.

## Documentation changes

Update `docs/features/lifecycle.md` to explain that purge displays a
resource-level removal plan before the interactive confirmation, and before
mutation for explicitly targeted non-interactive/CI runs. Document the kept
resources and the fact that plan discovery is a snapshot.

## Verification

Add regression coverage in `__tests__/app.test.ts` for:

1. An interactive single-workspace confirmation that displays the concrete
   Docker resources, aliases/app integrations, exact Boxdown paths, and kept
   repository guarantee.
2. An absent-resource plan that is accurate and does not promise removal.
3. A non-interactive targeted purge that prints a plain-text plan with no ANSI
   control sequences and does not prompt.
4. An interactive cancellation that permits only read-only discovery and
   performs no removal command or state deletion.
5. A batch confirmation that gives every selected workspace its own plan.

Run the focused tests first, then the full test suite, lint, build, Markdown
lint, and `git diff --check` using Node 24, the version used by CI.
