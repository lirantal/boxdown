# Interactive Agent Profile Setup Design

## Summary

`boxdown setup` will offer an interactive agent-profile selector after it
resolves optional Codex and Claude app targets. The selector makes the existing
`none`, `auth`, and `full` profile tiers discoverable without adding another
configuration surface.

The selector is conditional. It appears only when:

1. setup resolves at least one app target, either from `--target` or the
   interactive target prompt;
2. `--agent-profile` was not supplied; and
3. the process can prompt interactively.

An explicit `--agent-profile` remains authoritative and suppresses the profile
prompt. A setup with no selected app targets retains the profile already
recorded for the workspace, or uses `auth` when no profile has been recorded.
Non-interactive setup retains the same resolution without prompting.

## Goals

- Make agent-profile selection discoverable during interactive setup.
- Preserve `--agent-profile` as the only public configuration control for
  explicit and automated use.
- Keep `auth` as the balanced default for a new or legacy workspace.
- Preserve a workspace's recorded `none` or `full` selection by default.
- Keep app integration and container profile exposure as separate decisions.
- Complete both setup questions before writing metadata or starting container
  setup.
- Reuse a generic single-choice prompt primitive with the same terminal
  behavior as Boxdown's existing prompts.

## Non-goals

- Prompting from `start`, coding-agent, tunnel, SSH proxy, or token-refresh
  commands.
- Prompting from `boxdown ssh install`, which does not provision a container.
- Adding a global profile preference, environment-variable override, project
  configuration field, or metadata version.
- Filtering copied profile sources according to the selected app targets.
- Changing the contents, staging, isolation, or recreation behavior of the
  existing profile tiers.
- Adding an `interactive` profile-selection source to status or JSON output.

## Existing Behavior

Agent-profile resolution currently uses this precedence:

1. explicit `--agent-profile`;
2. the value in Boxdown workspace metadata;
3. `auth`.

`boxdown setup` currently runs its readiness preflight and then resolves
optional Codex and Claude app targets. Explicit `--target` values bypass the
target prompt. Otherwise, an interactive multi-select is shown; non-interactive
setup selects no optional targets.

After target resolution, setup records the resolved profile and starts the
container lifecycle. App target installation happens later in that lifecycle.

## Interaction Flow

Setup will use the following sequence:

```text
Parse flags
  -> read workspace metadata and resolve the current profile
  -> run setup preflight
  -> resolve app targets
  -> resolve the setup agent profile
  -> persist workspace metadata
  -> create or reuse the container
  -> install the SSH alias and selected app targets
```

Invalid CLI values continue to fail during parsing, before preflight, prompts,
metadata writes, or container work.

If app target selection is cancelled, setup prints `Canceled setup.`, returns
exit code `1`, and does not show the profile prompt.

### Resolution Matrix

Profile prompt eligibility is based on the final resolved targets, not on
whether the target prompt ran.

| Final app targets | Explicit profile | Interactive | Result |
| --- | --- | --- | --- |
| Any | Yes | Any | Use the flag and do not show the profile prompt |
| None | No | Any | Use recorded metadata, otherwise `auth`; do not prompt |
| One or more | No | Yes | Show the profile prompt |
| One or more | No | No | Use recorded metadata, otherwise `auth`; do not prompt |

Therefore, `boxdown setup --target codex` shows the profile prompt in an
interactive terminal unless `--agent-profile` is also supplied. The same
command does not prompt in CI or another non-interactive environment.

A fully explicit invocation is:

```sh
boxdown setup --target codex --agent-profile auth
```

### Profile Selector

The selector title will make clear that it controls container-wide host agent
data rather than the selected host app integration:

```text
How much host agent data should Boxdown copy into the container?
```

Choices use stable tier order and describe the existing semantics:

| Value | Label | Description |
| --- | --- | --- |
| `none` | No agent profile | Copy no host user-scoped agent data |
| `auth` | Authentication and ~/.agents | Copy agent authentication and `~/.agents`; Boxdown default |
| `full` | Full agent profiles | Copy complete Codex, Claude, and `~/.agents` profiles; may include sensitive data |

The current resolved profile is the initial focus and default. For a new or
legacy workspace this is `auth`. For a workspace with recorded `none` or
`full`, pressing Enter retains that value rather than silently changing it.

The prompt does not infer a profile from the chosen app targets. These remain
valid combinations:

- a Codex or Claude app target with profile `none`;
- only the Codex app target with profile `full`;
- only the Claude app target with profile `auth`.

The profile remains container-wide. In particular, `full` may copy supported
Claude data when only the Codex app target was selected, and `auth` may expose
supported Claude credentials or an API key. The prompt and documentation must
not imply target-specific filtering.

### Cancellation and Failure

Cancelling the profile prompt has the same setup semantics as cancelling the
target prompt:

- print `Canceled setup.`;
- return exit code `1`;
- do not write or update workspace metadata;
- do not generate container configuration;
- do not start or recreate a container;
- do not install the SSH alias or selected app targets.

Readiness preflight still precedes both prompts. A preflight failure therefore
shows neither prompt and preserves the existing no-state-write guarantee.

Unexpected prompt errors propagate to the existing CLI error boundary before
metadata is written.

Once both prompts complete, setup persists the final profile before starting
the lifecycle, matching current explicit-flag behavior. If later container
setup fails, the selected profile remains recorded. Status can then report a
recreation requirement. Changing the active profile never implicitly recreates
a container; the user must supply `--recreate`.

## Architecture

### Generic Single-choice Prompt

`src/interactive-prompts.ts` will gain a generic `promptSelect<T>` primitive
alongside `promptMultiSelect`, `promptText`, and `promptConfirm`.

Its public input includes:

- title;
- choices containing value, label, and description;
- current/default value;
- summary label;
- optional input, output, and environment overrides.

Its result is one of:

- selected value;
- cancelled;
- non-interactive.

Raw-terminal behavior:

- Up/Down and `k`/`j` move focus with wrapping.
- Enter selects the focused choice.
- Escape, Ctrl-C, and Ctrl-D cancel.
- Cursor visibility and raw mode are restored on every completion path.

Line-mode fallback behavior:

- display numbered choices;
- accept a choice number or tier value;
- accept blank input as the current/default value;
- explain invalid input and retry;
- treat EOF as cancellation.

Non-interactive detection returns without reading input or rendering prompt
output.

A dedicated selector is preferable to an exclusive mode on
`promptMultiSelect`: mutual exclusivity and a current default are intrinsic to
this interaction, while changing the multi-select contract would add
mode-dependent behavior to existing target and purge prompts. A validated text
prompt would require users to know and type the values and would make the
security-relevant descriptions less discoverable.

### Setup Profile Resolver

Setup will use a focused resolver that receives:

- the parsed explicit profile, if any;
- the current profile resolved from explicit value, metadata, and default;
- the final app targets;
- prompt input, output, and environment.

The resolver will:

1. return the explicit value without prompting when one was supplied;
2. return the current resolution without prompting when no targets were
   selected;
3. invoke `promptSelect` when targets exist and prompting is interactive;
4. return the selected tier, the current resolution for a non-interactive
   result, or a cancelled result.

The resolver must retain explicit provenance separately from the already
resolved value. Checking only the resolved value would incorrectly prompt after
an explicit `--agent-profile auth`.

The resolver is setup-specific. Other commands continue using
`resolveAgentProfile` directly and retain their existing behavior.

### Persistence and Status

An interactively selected profile is written to the existing `agentProfile`
workspace metadata field. Later commands and `boxdown status` see it as a
metadata selection. No new metadata field, version, or public selection-source
value is needed.

The same final value must be:

- written to workspace metadata;
- passed to setup and container lifecycle functions;
- written into generated devcontainer configuration;
- validated against the running container marker by existing lifecycle logic.

## Compatibility

The only intentional interaction change is that an interactive invocation with
an explicit target and no explicit profile is no longer prompt-free:

```sh
boxdown setup --target codex
```

Users and scripts that require a prompt-free interactive invocation can provide
both flags. CI and non-interactive behavior is unchanged.

The following behavior remains unchanged:

- targetless setup defaults a new or legacy workspace to `auth`;
- targetless setup retains an existing recorded profile;
- explicit profile precedence;
- profile persistence across later commands;
- recreation requirements;
- app integration installation;
- `boxdown ssh install` prompts only for app targets;
- repository-scoped agent configuration remains visible in every tier.

## Testing

### Prompt Primitive

Direct tests for `promptSelect` will cover:

- initial focus on each possible default;
- Enter selecting the current value;
- Up/Down and `k`/`j` movement and wrapping;
- raw-mode cancellation through Escape, Ctrl-C, and Ctrl-D;
- cursor and raw-mode cleanup;
- line-mode selection by number and value;
- blank line accepting the current value;
- invalid line input followed by a valid retry;
- EOF cancellation;
- non-interactive silence and no input reads;
- raw-mode failure falling back to line mode where consistent with existing
  prompt behavior.

### Setup Flow

Setup tests will cover:

- an interactively selected target followed by profile selection;
- an explicit target followed by profile selection in a TTY;
- target skip suppressing the profile prompt and resolving to `auth` for a new
  workspace;
- target skip retaining recorded `none` and `full`;
- explicit `--agent-profile` suppressing the profile prompt;
- the explicit value remaining authoritative over recorded metadata;
- each prompted `none`, `auth`, and `full` value being persisted and forwarded;
- CI and non-TTY behavior with and without explicit targets;
- profile cancellation causing no metadata, generated config, container setup,
  SSH alias, or app installation;
- target cancellation suppressing the profile prompt;
- preflight failure occurring before either prompt;
- a changed profile on an existing container retaining the existing
  `--recreate` requirement;
- unchanged `boxdown ssh install` behavior.

Sequential raw-prompt tests must wait until the second prompt is rendered
before sending its input. Sending both key sequences immediately is race-prone
because the target prompt removes its listener before the profile prompt
attaches one.

Existing full-suite, lint, build, shell, package, and container lifecycle
verification remain required before completion.

## Documentation

Update:

- `README.md`;
- `docs/features/setup.md`;
- CLI help and usage tests where the interactive behavior is described;
- `docs/testing.md` if it catalogs interactive prompt coverage.

Documentation will state:

- when the profile prompt appears;
- that explicit `--agent-profile` suppresses it;
- that non-interactive setup never asks;
- that recorded metadata is retained and only an unrecorded workspace defaults
  to `auth`;
- that app integration and container profile exposure are separate;
- that profiles are container-wide rather than filtered by app target;
- how to provide both flags for fully explicit setup;
- that an existing container may require `--recreate` after a profile change.

## Acceptance Criteria

- Interactive setup with one or more final app targets and no explicit profile
  asks for exactly one profile tier.
- An explicit profile, no final targets, or a non-interactive environment
  suppresses the profile prompt.
- The current resolved tier is the prompt default.
- Cancellation occurs before setup state or external integration mutations.
- The selected tier is persisted and passed unchanged through the lifecycle.
- Existing profile semantics, metadata compatibility, status behavior, and
  non-setup commands remain unchanged.
- Documentation explains the conditional prompt and fully explicit invocation.
