# Workspace Toolchains Design

## Goal

Let Boxdown detect a repository's development runtimes, let an interactive
user explicitly confirm or edit that selection, and provision the selected
runtimes inside the Boxdown-managed container. The first release supports
Node.js, Python, Go, and Rust.

The feature extends Boxdown's existing Node dependency installation behavior.
It is not a repository scaffolder and must not write Boxdown configuration into
the target repository.

## Scope and invariants

- Detection reads only known files at the workspace root. It does not recurse
  through monorepos, execute project scripts, or modify repository files.
- A workspace can select more than one runtime.
- Every provisioning decision is visible before it happens in interactive
  setup, is recorded in Boxdown-owned state, and is visible in `boxdown status`.
- The target repository remains the Dev Container workspace. Generated config
  and plans remain outside it.
- An explicit CLI toolchain selection is intentional user guidance and takes
  precedence over repository declarations.
- Container provisioning failures must not make the container unusable. They
  are reported, recorded, and retried on the next start.

Ruby and PHP are neither detected nor provisioned by the first release. They
are future adapters, not aliases for an unsupported generic runtime.

## Detection and planning

Add a `toolchains` domain with one adapter per runtime. An adapter owns only
its known marker discovery, strict parsing, version resolution input, display
text, provisioning, and dependency synchronization.

The resolver returns a typed `ToolchainPlan` with one entry per detected or
explicitly selected runtime. Each entry records:

- runtime identifier;
- selection source (`interactive`, `cli`, or `persisted`);
- evidence paths and declarations;
- requested and resolved version;
- resolution source (`override`, `project`, or `boxdown-default`);
- any non-blocking compatibility note; and
- the current synchronization result.

Parsing is specific to each source format, rather than a generic version
regular expression. Malformed or contradictory declarations become actionable
diagnostics. They are never silently guessed.

### Marker precedence

The adapter documentation specifies exact precedence. Initial sources are:

| Runtime | Exact-version sources | Constraint/fallback sources |
| --- | --- | --- |
| Node.js | `volta.node` in `package.json`, `.nvmrc`, `.node-version`, `.tool-versions` | `engines.node` in `package.json` |
| Python | `.python-version`, `.tool-versions` | `requires-python` in `pyproject.toml` |
| Go | `toolchain` in `go.mod`, `.go-version`, `.tool-versions` | `go` directive in `go.mod` |
| Rust | `rust-toolchain.toml`, `rust-toolchain`, `.tool-versions` | `package.rust-version` in `Cargo.toml` |

An exact declaration resolves directly. With a compatible constraint, Boxdown
uses its release-pinned default only when that version satisfies the
constraint. A constraint that excludes the default appears as an unchecked
actionable selection in interactive setup; Boxdown does not choose a different
version implicitly.

## Defaults and overrides

The typed default registry is the source of truth for exact runtime versions.
Each Boxdown release pins its default versions and documents them in the
Toolchains feature page. The initial runtime lines are:

- Node.js 24.x LTS;
- Python 3.14.x;
- Go 1.26.x; and
- Rust 1.97.x.

The release artifact and documentation name the exact patch versions. Upgrading
a default is a deliberate Boxdown release change, not a floating lookup during
provisioning. A test verifies that the documentation table matches the default
registry.

`--toolchain <runtime>@<version>` overrides every repository declaration. If it
conflicts with a detected marker, Boxdown continues and displays a prominent
note in setup and status. It does not require a separate `--force` flag.

## CLI and selection

Add a repeatable `--toolchain <selector>` option to `setup` and `start`:

```sh
boxdown setup --toolchain auto
boxdown setup --toolchain node --toolchain python
boxdown setup --toolchain node@24 --toolchain go@1.27
boxdown setup --toolchain none
```

Selectors have these meanings:

- Omitted, interactive `setup`: display an editable multi-select of detected
  toolchains. Detected runtimes are preselected, but the user explicitly
  confirms the final selection.
- Omitted, non-interactive command: report detections but select nothing.
- `auto`: explicitly approve all high-confidence detected toolchains.
- `<runtime>`: select the runtime, resolving its declared version or the
  Boxdown default.
- `<runtime>@<version>`: select the runtime and use the explicit override.
- `none`: select no toolchains and reject combinations with other selectors.

`start` reuses a previously confirmed plan. A direct `start` with no existing
plan does not prompt; it requires an explicit selector. `setup` is the
configuration entry point.

The interactive summary names the selected runtime, resolved version, and
source. For example:

```text
✓ Node.js 24 — package.json engines.node
✓ Python 3.14 — Boxdown default; no project version declaration
```

## State, generated config, and lifecycle

Persist plans at:

```text
~/.local/share/boxdown/workspaces/<workspace-id>/toolchains/plan.json
```

The plan has its own schema version. `metadata.json` stores only lightweight
plan provenance. The generated Dev Container config mounts the plan directory
read-only at a stable Boxdown container-state path. This mount allows a new
plan to be observed by an existing feature-aware container without exposing
host runtime state or repository files.

The first time an existing workspace selects toolchains it needs
`boxdown setup --recreate` or `boxdown start --recreate`, because adding the
plan mount is a create-time container change. Legacy workspaces without a plan
remain valid and retain current behavior.

The lifecycle hook delegates to a new idempotent toolchain bootstrap:

1. `postCreate` provisions selected runtimes and runs the safe dependency
   synchronizations.
2. `postStart` compares the mounted plan fingerprint with a container-local
   completion marker. It only provisions or synchronizes when the plan changed
   or the previous result failed.

Container-local tool installations and fingerprints live under the `node`
user's local state. They persist with the container but never write to the host
or target repository.

## Provisioning

Boxdown bundles a release-pinned `mise` binary in its Dev Container image.
Boxdown invokes it only with resolved runtime versions and configuration
loading disabled. Repository `mise.toml`, `.tool-versions`, environment files,
hooks, and tasks are not trusted or executed by the runtime manager. Boxdown's
own parsers are the only source of selected versions.

The packaged Node.js 24 runtime is a validated fast path when it matches the
plan. `mise` installs and activates another selected Node.js version, Python,
Go, or Rust in container-local state.

After a runtime is available, its adapter performs only its declared safe
dependency synchronization:

| Runtime | Synchronization |
| --- | --- |
| Node.js | Preserve the current detected package-manager installation behavior. |
| Python | `uv sync` for a `pyproject.toml` lockfile workflow, or install declared requirements. |
| Go | `go mod download`. |
| Rust | `cargo fetch`. |

Boxdown does not infer or run arbitrary package scripts, task runners, or build
commands. Dependency synchronization retains the current non-fatal lifecycle
behavior: failures warn, record a failed state, and retry on a later start.

## Status and diagnostics

`boxdown status` reports selected toolchains, resolved versions, their source,
last sync result, override notes, and whether a container recreation is needed.
It never reports repository file contents or host paths beyond the existing
workspace state locations.

The setup progress view adds clear steps for preparing selected runtimes and
synchronizing workspace dependencies. A failure explains the runtime and
operation that failed and points to the workspace command log. The user can
still open a shell or coding agent in the container.

## Testing and documentation

Unit tests cover all supported marker formats, precedence, constraints,
malformed inputs, multi-runtime detection, explicit overrides, and CLI selector
validation. Integration-style tests stub `mise` to assert exact invocation,
configuration isolation, plan mounts, lifecycle fingerprints, failure retries,
and status output.

Manual image acceptance tests exercise the four toolchains on each supported
architecture. The documentation update includes:

- supported runtimes and marker precedence;
- exact Boxdown defaults per release;
- interactive and non-interactive selection behavior;
- CLI override examples;
- status interpretation; and
- legacy-workspace recreation guidance.

## Out of scope

- Recursive monorepo/package discovery and per-package toolchain plans.
- Ruby and PHP provisioning.
- Executing repository-defined tasks, package scripts, or build commands.
- Adding a Boxdown config file to target repositories.
- Automatically upgrading an existing workspace to a new toolchain selection.
