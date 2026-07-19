# Container Runtime Readiness and Lifecycle Preflight

## Goal

Make every Boxdown command that can create or start a devcontainer recover
cleanly when Docker has just been launched, while preserving `boxdown start` as
a standalone command after a missing or failed `boxdown setup`.

## Problem

`boxdown setup` currently runs required host-readiness checks before prompts,
workspace state, or Docker work. Other commands that can create a container do
not share that gate. A user can therefore run setup while Docker is stopped,
start Docker, and then run `boxdown start` while Docker Desktop or its selected
Buildx builder is still initializing. The Dev Containers CLI proceeds far
enough to invoke `docker buildx build`, then returns a generic JSON error
envelope that does not explain the lifecycle gap.

The existing checks also establish only that the Docker CLI exists and that the
daemon answers `docker info`. They do not distinguish these Buildx states:

- Buildx is unavailable and the Dev Containers CLI will use its supported
  classic-build fallback.
- Buildx is discoverable but its selected builder is not operational yet.
- Buildx is operational and ready for a Feature image build.

## Decisions

- `boxdown start` remains valid without a successful prior setup.
- Start does not install setup-only SSH aliases or external app integrations.
- Commands that may create or start a container share one readiness gate.
- Transient Docker daemon and Buildx builder failures are polled once per second
  for at most 60 seconds.
- A missing Docker executable is terminal and fails immediately.
- Missing Buildx is non-blocking because the bundled Dev Containers CLI already
  supports a non-Buildx build path.
- Discoverable but unusable Buildx is transient until the readiness deadline,
  then terminal with the last builder diagnostic.
- `devcontainer up` is invoked once after readiness succeeds. Boxdown does not
  retry genuine image, Feature, Dockerfile, registry, or lifecycle failures.
- Workspace metadata remains inventory for a workspace Boxdown has touched; it
  does not become a setup-completion record.
- No `setupCompleted` field or migration is introduced.

## Alternatives Considered

### Shared CLI lifecycle gate

This is the selected design. A focused container-runtime module owns probing
and bounded waiting. CLI lifecycle orchestration calls it before metadata or
container work, and `doctor` reuses the same single-attempt probe semantics.

This keeps host-runtime policy out of devcontainer configuration code, makes
the command scope explicit, and preserves setup's stronger ordering.

### Readiness inside `startDevcontainer`

Putting the gate in `startDevcontainer` would make it difficult for a caller to
forget the check. It would, however, run after setup has already entered its
workflow unless setup retained a second preflight. It would also couple Docker
host diagnostics and waiting policy to the lower-level devcontainer lifecycle
implementation.

### Retry `devcontainer up`

Retrying the failed Dev Containers command is too late and cannot reliably
distinguish runtime initialization from a real build failure. It could repeat
expensive work or obscure an actionable Feature, registry, or Dockerfile error.

## Architecture

### Container runtime module

Add `src/container-runtime.ts` as the single owner of Docker and Buildx
readiness semantics. It exposes two levels of behavior:

- A single-attempt probe used by `doctor` and by each waiter iteration.
- A bounded waiter used before container-creating lifecycle commands.

The module accepts an injected command runner, clock, and sleep function so its
tests do not use the real Docker daemon or wall-clock delays.

The probe returns a structured result rather than throwing. Its stable states
are:

- `ready`: Docker is reachable and Buildx is either operational or unavailable
  with a supported fallback.
- `waiting`: Docker or a discoverable Buildx builder may still become ready.
- `failed`: a terminal prerequisite is missing.

The structured result includes:

- the high-level reason;
- whether the Dev Containers CLI will use Buildx or its fallback;
- the command whose last attempt failed;
- compact stdout/stderr detail suitable for an actionable error; and
- non-blocking warnings.

The stable terminal and transient reasons are:

- `docker-cli-unavailable`: terminal;
- `docker-daemon-unavailable`: transient until timeout;
- `buildx-builder-unavailable`: transient until timeout.

### Readiness commands

Each probe performs only the commands required by the state reached:

1. Run `docker --version`. A spawn failure or any nonzero exit produces the
   terminal `docker-cli-unavailable` result.
2. Run `docker info`. A nonzero result produces the transient
   `docker-daemon-unavailable` result.
3. Run `docker buildx version`. A nonzero result produces a ready result with a
   fallback warning; it does not block container startup.
4. Run `docker buildx inspect --bootstrap`. A nonzero result produces the
   transient `buildx-builder-unavailable` result. Success produces Buildx-ready
   status.

`--bootstrap` is intentional: the selected builder is the builder the Dev
Containers CLI will use, and readiness must establish that it can start before
Boxdown begins the Feature build. The command may initialize a selected custom
builder, but Boxdown does not create, replace, select, or delete builders.

### Bounded waiter

The waiter uses these defaults:

- timeout: 60,000 milliseconds;
- poll interval: 1,000 milliseconds;
- first probe: immediate;
- deadline behavior: retain and report the final failed probe;
- terminal failure behavior: return immediately without sleeping.

The waiter never launches Docker Desktop or modifies Docker contexts. It gives
a daemon or builder that the user has already launched time to become ready.

## Command Scope and Data Flow

The readiness gate applies to commands that may create or start a container:

| Command path | Waits for readiness | May create/start |
| --- | --- | --- |
| `setup` | Yes | Yes |
| `start` / `shell` | Yes | Yes |
| `ssh-proxy` | Yes | Yes |
| `tunnel` | Yes | Yes |
| `refresh-gh-token` | Yes | Yes |
| `codex`, `claude`, `opencode`, `antigravity` | Yes | Yes |
| `refresh-gh-token-running` | No | No |
| `ssh install`, `ssh uninstall` | No | No |
| `doctor`, `status`, `list` | No wait | No |
| `stop`, `down`, `purge` | No bring-up wait | No |

`doctor` performs one readiness snapshot and reports it; it does not poll for
60 seconds.

For non-setup container lifecycle commands, the sequence is:

1. Resolve the workspace and alias.
2. Create the managed command logger so readiness details can be preserved.
3. Wait for container-runtime readiness.
4. Write workspace inventory metadata.
5. Generate runtime configuration and invoke the requested lifecycle.

A readiness failure may leave a diagnostic command log, but it does not create
workspace metadata, generated devcontainer configuration, an SSH identity, or a
container.

Setup retains stronger state-free ordering:

1. Wait for container-runtime readiness without creating a workspace logger.
2. Run the remaining required doctor checks.
3. Show optional-target prompts.
4. Write inventory metadata.
5. Start the container and install the SSH alias and selected integrations.

This preserves the existing contract that setup preflight failures do not
create workspace data. Setup reports its final readiness diagnostic directly
because no managed log exists yet.

## User Experience

Interactive mode adds one stable checklist step labelled `Checking container
runtime`. When a transient condition is observed, the detail changes to either
`Waiting for Docker daemon` or `Waiting for Docker Buildx builder`. Individual
poll attempts do not add terminal lines or restart the spinner.

Verbose mode prints the first transient observation, state transitions, and
final outcome. It does not print identical output once per second.

When Buildx is unavailable, Boxdown emits one warning that the Dev Containers
CLI will use its fallback. It then proceeds without a delay.

Timeout errors include:

- the failed capability;
- the 60-second timeout;
- the last compact command diagnostic;
- an appropriate manual check, `docker info` or `docker buildx inspect`; and
- the workspace command-log path when the command has an active logger.

Examples of error summaries are:

```text
Docker daemon did not become ready within 60 seconds.
Last check: docker info
Detail: Cannot connect to the Docker daemon ...
Check Docker with: docker info
Command log: /path/to/boxdown.log
```

```text
Docker Buildx builder did not become ready within 60 seconds.
Last check: docker buildx inspect --bootstrap
Detail: failed to initialize builder ...
Check Buildx with: docker buildx inspect
Command log: /path/to/boxdown.log
```

## Dev Containers Failure Reporting

Readiness success marks the boundary between runtime initialization and the
actual Dev Containers lifecycle. Any subsequent `devcontainer up` failure is
reported without an automatic retry.

The concise failure formatter will:

- handle a zero line budget as zero lines instead of using `.slice(-0)`;
- preserve stderr before allocating remaining space to stdout;
- recognize a Dev Containers JSON object with `outcome: "error"` as a wrapper;
- avoid presenting the wrapper's repeated build command as the root cause when
  more specific stderr exists;
- state explicitly when the wrapper contains no nested Docker diagnostic;
- include the managed command-log path when available; and
- retain the `--verbose` recovery instruction.

The full redacted stdout and stderr streams continue to be stored by the
existing workspace command logger. The readiness work does not weaken current
secret redaction.

## Workspace State Semantics

`boxdown start` is a recovery-capable standalone command. It may create the
Boxdown SSH identity and generated devcontainer config required for container
operation, but it does not install an SSH host alias or modify Codex or Claude
application configuration.

Workspace metadata continues to mean that Boxdown reached a ready runtime and
attempted a lifecycle for that workspace. A build failure after readiness may
therefore leave metadata and a diagnostic log. A readiness failure leaves no
metadata. This distinction does not require a metadata schema change.

## Testing Strategy

### Container-runtime unit tests

Use an injected command runner to verify:

- missing Docker exits immediately with `docker-cli-unavailable`;
- an unavailable daemon returns `docker-daemon-unavailable` without probing
  Buildx;
- missing Buildx returns ready fallback status and one warning;
- successful Buildx version plus failed bootstrap returns
  `buildx-builder-unavailable`;
- successful Docker, Buildx version, and bootstrap returns Buildx-ready status;
- command output is compacted and retained in failure details.

Use injected clock and sleep functions to verify:

- the first probe happens without sleeping;
- two transient failures followed by success produce exactly two sleeps;
- terminal failures never sleep;
- polling stops at the 60-second deadline;
- the timeout reports the last probe rather than the first; and
- identical transient output does not create repeated user-facing messages.

### CLI lifecycle tests

Extend the existing CLI execution tests to verify:

- `start` after a failed setup can proceed when runtime readiness becomes
  healthy;
- readiness runs before metadata for each container-creating command path;
- readiness failure creates no metadata, generated config, SSH key, or
  container call;
- setup still performs readiness before prompts or state writes;
- `refresh-gh-token-running` and SSH-only commands do not wait;
- every coding-agent command shares the same gate; and
- a post-readiness `devcontainer up` failure is invoked once and not retried.

Command-scope coverage will use a table-driven test so adding a new
container-creating CLI command requires an explicit readiness decision.

### Failure-formatting tests

Verify that:

- a zero stdout line budget produces no stdout lines;
- specific stderr is retained ahead of the generic JSON wrapper;
- a wrapper-only failure explains that the nested diagnostic was unavailable;
- logged lifecycle failures show the exact command-log path; and
- secret redaction remains unchanged.

### Complete verification

After the focused tests pass, run:

```sh
pnpm test
pnpm lint
pnpm build
git diff --check
```

No automated test requires a real Docker daemon, Docker Desktop, registry
network access, or wall-clock waiting.

## Documentation

Update the README and lifecycle documentation to state that:

- `start` works without a completed setup;
- setup-only SSH and application integrations remain exclusive to setup;
- container-creating commands wait up to 60 seconds for Docker and an available
  Buildx builder;
- missing Buildx uses the Dev Containers CLI fallback; and
- timeout errors point to `docker info`, `docker buildx inspect`, and the
  workspace command log.

## Non-Goals

- Launching or restarting Docker Desktop automatically.
- Creating, selecting, repairing, or deleting Buildx builders.
- Retrying `devcontainer up` or individual Docker builds.
- Classifying every possible Docker, registry, Feature, or Dockerfile error.
- Adding setup-completion state or migrating workspace metadata.
- Changing the packaged Node base image or Dev Container Feature pins.
- Installing setup-only SSH or external app integrations from `start`.

## Success Criteria

- A user can run `start` after a failed setup and recover once Docker becomes
  ready, without rerunning setup.
- Docker and Buildx startup races receive a bounded wait rather than an opaque
  immediate build failure.
- Every current container-creating command uses the shared readiness contract.
- Readiness failures do not create workspace metadata, generated config, an SSH
  identity, or a container. Non-setup lifecycle commands may retain only their
  diagnostic command log.
- Genuine post-readiness build failures execute once and retain their useful
  diagnostic context.
- Setup preserves its state-free preflight ordering.
- Existing workspaces require no metadata migration.
